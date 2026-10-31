/**
 * The model-facing half: what a call can do to the sidecar browser, and what it
 * says back.
 *
 * Two costs decide whether this is usable: the tokens a read spends, and the
 * round trips a task spends. The tool surface here is shaped around both — a
 * read can be narrowed (`mode`, `max_chars`) and diffed (`changed_only`), and
 * `browser_do` runs a run of steps in one call with waits that know when a page
 * has settled.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { VIEW, DESKTOP_UA } from './sidecar.js?v=1'
import { planOf, gather, sizeText, coreRows } from './media.js?m=2'
import { dropLogin, listLogins, readLogin, saveLogin, vaultState } from './vault.js'
import { readPage, renderPage, readArticle, readRelevant, findOnPage, locate, locateFirst, FRAME_BASE, covering, contextFor, identityOf, sameThing, differs, labelSpot, selectSpot, bounds, pictures, clickInDom, writeInDom, REF_GONE } from './read.js?v=1'
import { brief as askBrief, recordRound, lastRoundNote, lastRound, markRound, MARK_STATUS } from './review.js?v=1'

/**
 * What a saved file should be called, from the address when it says so and the
 * type when it does not.
 * @param {string} url - the media's address.
 * @param {string} [mime] - what the server called it.
 * @returns {string} an extension with the dot.
 */
function extensionOf(url, mime = '') {
  const known = /\.(mp4|m4v|webm|mkv|mov|flv|ts|m4s|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i.exec(String(url ?? ''))
  if (known !== null) return `.${known[1].toLowerCase()}`
  const said = String(mime ?? '').toLowerCase()
  if (said.includes('mp4') || said.includes('m4v')) return '.mp4'
  if (said.includes('webm')) return '.webm'
  if (said.includes('mpegurl')) return '.ts'
  if (said.startsWith('audio/')) return '.m4a'
  return '.bin'
}

/** What the page's own players are showing, in one look: the address, the length, whether it runs. */
async function playersOf(page) {
  const answer = await page.cdp.send('Runtime.evaluate', {
    expression: `(() => [...document.querySelectorAll('video,audio')].map((one) => ({ url: one.currentSrc || one.src || '', playing: !one.paused, dur: Number.isFinite(one.duration) ? Math.round(one.duration) : 0 })))()`,
    returnByValue: true,
  }).catch(() => null)
  const seen = answer?.result?.value
  return Array.isArray(seen) ? seen.filter((one) => String(one?.url ?? '') !== '') : []
}

/** Seconds as a person writes them: 2:13, 1:02:00. */
function clockOf(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0))
  const rest = whole % 3600
  const pad = (value) => String(value).padStart(2, '0')
  return whole >= 3600 ? `${String(Math.floor(whole / 3600))}:${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` : `${String(Math.floor(whole / 60))}:${pad(rest % 60)}`
}

/** Which chat the running call belongs to, so each gets its own tab. */
export const sessionScope = new AsyncLocalStorage()

/** @returns {string} the chat id of the running call. */
function currentSession() {
  return String(sessionScope.getStore() ?? '')
}

/** How a call asked to act: real mouse and keys, or the page's own DOM. */
const WAYS = new Set(['human', 'dom'])

/** The way each chat said to act, until it says otherwise. */
const chatWays = new Map()

/**
 * The way this call should act: what it asked for, else what its chat last set,
 * else a real mouse and real keys, which no page can tell from a person.
 * @param {any} args - the call's arguments.
 * @returns {'human'|'dom'} which way.
 */
function wayOf(args) {
  const said = String(args?.mode ?? '')
  if (WAYS.has(said)) return /** @type {'human'|'dom'} */ (said)
  const chat = currentSession()
  return chatWays.get(chat) === 'dom' ? 'dom' : 'human'
}

/** Which project the running call belongs to, so its files stay together. */
export const workScope = new AsyncLocalStorage()

/** Where files a call produces land, under the user's home. */
export const ARTIFACT_ROOT = String(process.env.DSH_INNER_BROWSER_ARTIFACTS ?? '') !== ''
  ? String(process.env.DSH_INNER_BROWSER_ARTIFACTS)
  : join(homedir(), '.dsh-inner-browser-use', 'artifacts')

/** How many files one kind keeps per chat; older ones go. */
export const ARTIFACT_KEEP = 40

/** Project folder name: the folder's own name, plus a short hash of its path. */
function projectKey() {
  const cwd = String(workScope.getStore() ?? '')
  if (cwd === '') return 'no-project'
  const named = basename(cwd).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '')
  return `${named === '' ? 'project' : named}-${createHash('sha1').update(cwd).digest('hex').slice(0, 6)}`
}

/** Chat folder name: the short id a person can match to the chat. */
function sessionKey() {
  const id = currentSession().replace(/^session-/, '').replace(/[^a-z0-9-]/gi, '')
  return id === '' ? 'no-chat' : id.slice(0, 8)
}

/**
 * Where one kind of file for this project and this chat goes.
 * `~/.dsh-inner-browser-use/artifacts/<project>/<chat>/<kind>/`
 * @param {string} kind - shots, pictures, pdf.
 * @returns {string} absolute directory; not created yet.
 */
export function artifactDir(kind) {
  return join(ARTIFACT_ROOT, projectKey(), sessionKey(), kind)
}

/**
 * Write one file where the project and the chat expect it, and keep the folder
 * from growing without a limit.
 * @param {string} kind - shots, pictures, pdf.
 * @param {string} body - base64 body.
 * @param {{name?: string, ext?: string, prefix?: string}} [options] - file name.
 * @returns {Promise<string>} absolute path.
 */
export async function saveArtifact(kind, body, options = {}) {
  const dir = artifactDir(kind)
  await mkdir(dir, { recursive: true })
  const ext = String(options.ext ?? '.png')
  /* A name is a name: no separators, no runs of dots that could read as a path
     climb, and no leading dot to hide the file. */
  const wanted = String(options.name ?? '').replace(/[^\w.-]/g, '').replace(/\.(png|jpe?g|webp|pdf)$/i, '').replace(/\.{2,}/g, '.').replace(/^\.+/, '')
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const prefix = String(options.prefix ?? kind)
  const file = join(dir, `${wanted === '' ? `${prefix}-${stamp}` : wanted}${ext}`)
  await writeFile(file, Buffer.from(body, 'base64'))
  await pruneArtifacts(dir, ARTIFACT_KEEP)
  return file
}

/**
 * Keep the newest `keep` files in one folder: a browser session that runs all
 * day does not leave a folder nobody can look through.
 * @param {string} dir - folder to trim.
 * @param {number} keep - how many files survive.
 * @returns {Promise<void>} done.
 */
export async function pruneArtifacts(dir, keep) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const listed = []
  for (const name of names) {
    try {
      listed.push({ name, at: (await stat(join(dir, name))).mtimeMs })
    } catch {
      /* a file that vanished between listing and reading is already gone */
    }
  }
  if (listed.length <= keep) return
  listed.sort((left, right) => right.at - left.at)
  for (const spare of listed.slice(keep)) {
    try {
      await unlink(join(dir, spare.name))
    } catch {
      /* best effort: a file in use stays */
    }
  }
}

/** How many times a call found a control again after the page redrew it. */
const follows = { count: 0 }

/** Shown when the sidecar has never been started in this run. */
export const SIDECAR_OFF = 'The sidecar browser is not running. Call browser_open with the address first.'

/** Output schema every tool returns. */
/** The picture half of a screenshot result: shown only when the route can see it. */
const SHOT_IMAGE = {
  type: 'object', // ui-copy-ignore
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' }, // ui-copy-ignore
    width: { type: 'integer' }, // ui-copy-ignore
    height: { type: 'integer' }, // ui-copy-ignore
    name: { type: 'string' }, // ui-copy-ignore
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  additionalProperties: false,
}

/** A screenshot's path, plus the picture when this model can look at it. */
export const SHOT_OUTPUT = {
  schema: { // ui-copy-ignore
    type: 'object', // ui-copy-ignore
    properties: { text: { type: 'string' }, image: SHOT_IMAGE },
    required: ['text'],
    additionalProperties: false,
  },
  /**
   * @param {unknown} _args - call arguments, unused.
   * @param {any} value - tool value.
   * @returns {any[]} the text, and the picture when there is one.
   */
  render(_args, value) {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }]
    if (value?.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
    return blocks
  },
}

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  /**
   * @param {unknown} _args - call arguments, unused.
   * @param {unknown} value - tool value.
   * @returns {Array<{type: string, text: string}>} blocks.
   */
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}


/**
 * One line about where the page now is. A step that worked says so in a few
 * words; the model reads the page only when it needs to, which is most of the
 * saving over reading after every action.
 * @param {any} page - sidecar page.
 * @returns {Promise<string>} address, title, focus and any open dialog.
 */
export const BRIEF_JS = `(() => {
    const a = document.activeElement
    const secret = a !== null && typeof a === 'object' && (String(a.type ?? '') === 'password' || String(a.getAttribute === undefined ? '' : a.getAttribute('type') ?? '') === 'password')
    const focus = a !== null && a !== document.body && a !== document.documentElement
      ? { name: String(a.getAttribute('aria-label') || a.getAttribute('placeholder') || (a.labels && a.labels[0] && a.labels[0].innerText) || a.innerText || a.name || a.tagName).trim().slice(0, 60), value: secret ? '' : String(a.value === undefined ? '' : a.value).slice(0, 60) }
      : null
    return { url: location.href, title: document.title.slice(0, 80), focus }
  })()`

async function brief(page) {
  const dialog = page.dialog
  if (dialog !== null && dialog !== undefined) {
    return `${String(page.url ?? '')} · dialog ${String(dialog.type ?? '')}: ${String(dialog.message ?? '')}`
  }
  /* On a Flash page the DOM around the plugin says nothing about what is on
     screen, and reading it right after a click waits for the main thread the
     plugin is holding. The bridge answers with the address and title instead. */
  if (page.flashBridge !== null && page.flashBridge !== undefined) {
    try {
      const reply = await fetch(`http://127.0.0.1:${page.flashBridge}/info`, { signal: AbortSignal.timeout(600) })
      if (reply.ok === true) {
        const info = await reply.json()
        const bits = [String(info?.url ?? page.url ?? '')]
        if (String(info?.title ?? '') !== '') bits.push(String(info.title))
        return bits.join(' · ')
      }
    } catch {
      /* the cached address below is still a true answer */
    }
    return String(page.url ?? '')
  }
  const info = await evaluate(page, BRIEF_JS)
  const bits = [String(info?.url ?? '')]
  if (String(info?.title ?? '') !== '') bits.push(String(info.title))
  if (info?.focus) bits.push(`focus ${info.focus.name}${info.focus.value === '' ? '' : ` = ${info.focus.value}`}`)
  return bits.join(' · ')
}

/**
 * What an action returns: a short line, or the whole read when asked for one.
 * @param {any} page - sidecar page.
 * @param {any} args - tool arguments.
 * @param {() => Promise<string>} look - full read.
 * @param {string} label - what was done.
 * @returns {Promise<string>} reply text.
 */
/** The address each page last reported to the model, so it is said once. */
const saidUrls = new WeakMap()

/**
 * The address is worth one line the first time and every time it changes; the
 * same address on every step is a cost with nothing to teach — the model read
 * it a step ago and still has it. Titles and focus still come through.
 * @param {any} page - sidecar page.
 * @param {string} briefText - address, title and focus as `brief` built them.
 * @returns {string} the line to send.
 */
/**
 * A PDF is a document, not a blank page: say so, and put its bytes somewhere a
 * reader can open them. The mirror cannot draw a PDF, and a model looking at an
 * empty screen would otherwise think the address had nothing on it.
 * @param {any} page - the tab.
 * @returns {Promise<string>} a line to append to the read, or ''.
 */
async function pdfNote(page) {
  const found = page?.pdf
  if (found === null || found === undefined) return ''
  let file = { path: '', bytes: 0 }
  try {
    file = await page.documentFile()
  } catch (error) {
    file = { path: '', bytes: 0 }
  }
  const size = file.bytes > 0 ? ` (${String(Math.max(1, Math.round(file.bytes / 1024)))} KB)` : ''
  return file.path === ''
    ? `\nthis address is a PDF${size}: the mirror cannot draw it, and its bytes could not be saved. browser_downloads lists what the browser has downloaded.`
    : `\nthis address is a PDF${size}: the mirror cannot draw it. Saved to ${file.path} — envoy_read can read that file, or another document reader.`
}

/**
 * The numbered controls that were not on the page at the read before this one.
 * A model that just acted cares about what its action brought in, and saying so
 * costs a few numbers instead of a whole second read.
 * @param {any} before - the read before this one, or undefined.
 * @param {any} after - the read now.
 * @returns {number[]} refs in `after` that `before` did not have.
 */
export function freshRefs(before, after) {
  if (before === undefined || before === null) return []
  if (after === undefined || after === null) return []
  const had = new Set((Array.isArray(before.controls) ? before.controls : []).map((control) => Number(control?.ref ?? -1)))
  const fresh = []
  for (const control of Array.isArray(after.controls) ? after.controls : []) {
    const ref = Number(control?.ref ?? -1)
    if (ref < 0 || had.has(ref)) continue
    if (!fresh.includes(ref)) fresh.push(ref)
  }
  return fresh
}

/** What an action did, in one line: where it went, whether the page moved at all. */
export async function outcome(page, before) {
  if (typeof before !== 'string' || before === '') return ''
  const after = await pageMark(page)
  if (after === '') return ''
  /* A movie has no DOM to compare: its frame counter is the whole answer. */
  if (before.startsWith('flash:') && after.startsWith('flash:')) {
    return before === after ? ' · no frame change' : ' · screen updated'
  }
  const [wasTitle, wasUrl, wasText, wasNodes] = before.split('|')
  const [nowTitle, nowUrl, nowText, nowNodes] = after.split('|')
  if (after === before) return ' · no visible change'
  if (nowUrl !== wasUrl) {
    /* The brief on the same line already names the address this step went to.
       What it cannot say is whether the page moved within itself, so a jump to
       another spot on the same address is said as the spot alone. */
    const was = String(wasUrl ?? '')
    const now = String(nowUrl ?? '')
    const base = (value) => (value.includes('#') ? value.slice(0, value.indexOf('#')) : value)
    const spot = now.includes('#') ? now.slice(now.indexOf('#')) : ''
    if (spot !== '' && base(was) === base(now)) return ` · ${spot.slice(0, 120)}`
    return ' · new page'
  }
  const words = Math.abs(Number(nowText ?? 0) - Number(wasText ?? 0))
  const nodes = Math.abs(Number(nowNodes ?? 0) - Number(wasNodes ?? 0))
  if (nowTitle !== wasTitle) return ' · page moved on'
  if (words >= 20 || nodes >= 3) return ' · content changed'
  return ' · no visible change'
}

/** Read results this chat already paid for, keyed by what the page looks like. */
const readSeen = new WeakMap()

export function oncePerPage(page, briefText) {
  const parts = String(briefText).split(' · ')
  const url = String(parts[0] ?? '')
  const known = page === null || page === undefined ? undefined : saidUrls.get(page)
  if (url !== '' && known !== undefined) {
    saidUrls.set(page, url)
    if (url === known && parts.length > 1) return parts.slice(1).join(' · ')
    return briefText
  }
  if (url !== '' && page !== null && page !== undefined) saidUrls.set(page, url)
  return briefText
}

/**
 * A read that starts with an address the model was already given opens with the
 * page itself. The address is how a page says which page it is, not something
 * to repeat every read; a page that moved says the new address in full.
 * @param {any} page - sidecar page.
 * @param {string} url - the address this read is from.
 * @param {string} text - the rendered read.
 * @returns {string} the read, without a leading address already said.
 */
export function withoutSeenAddress(page, url, text) {
  const body = String(text ?? '')
  const address = String(url ?? '')
  if (address === '' || page === null || page === undefined) return body
  const first = body.split('\n')[0]
  if (first !== address || saidUrls.get(page) !== address) return body
  return body.slice(first.length + 1)
}

/** The focus line repeats the control the call named: say the name once. */
export function dropSameFocus(line, args) {
  const squeezed = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '')
  const named = squeezed(args?.text ?? args?.name ?? args?.ref ?? '')
  if (named === '') return line
  const at = line.indexOf(' · focus ')
  if (at < 0) return line
  const head = line.slice(0, at)
  const parts = line.slice(at + ' · focus '.length).split(' · ')
  const said = String(parts[0] ?? '')
  /* A field carries a value the words do not: that part is news, so it stays. */
  if (said.includes(' = ')) return line
  const label = squeezed(said)
  if (label !== named && !label.includes(named) && !named.includes(label)) return line
  const rest = parts.slice(1)
  return rest.length === 0 ? head : `${head} · ${rest.join(' · ')}`
}

async function acted(page, args, look, label) {
  if (args?.read === true) return await look()
  return `ok ${label} · ${dropSameFocus(oncePerPage(page, await brief(page)), args)}`
}

/**
 * Say the network failed, instead of reading Chrome's own error page as if it
 * were the site. Those pages mention proxies and firewalls, and they answer
 * every question with something that looks like content — a read returns the
 * text "This site can't be reached", a click lands on "Reload". A model that
 * treats that as the page will report a broken site, or worse, act on it.
 * @param {any} page - sidecar page.
 * @returns {Promise<string>} a sentence, or an empty string when the page is real.
 */
/**
 * Whether the tab is sitting on one of Chrome's own error pages, without asking
 * the page anything.
 * @param {any} page - sidecar page.
 * @returns {boolean} true while the browser is showing its own failure page.
 */
/** Titles a site shows while it asks the browser to prove a person is there. */
const CHECK_TITLES = ['请稍候', 'just a moment', 'checking your browser', 'verifying you are human', 'attention required']

const CHECK_NOTE = 'That is the site asking a browser to prove a person is there, and a windowless one never gets past it. browser_open with headless false opens a window on the same profile, with the same logins.'

/**
 * A check page: the site has not refused, it is asking for proof. Reading it
 * again cannot help, and neither can a click: the answer is a window.
 * @param {{url?: string, title?: string}} read - what the page says it is.
 * @returns {boolean} whether this is a check page.
 */
/**
 * What to say when nothing is drawing the mirror.
 *
 * The picture lives in the column of the chat that asked for it, and that tab
 * only exists once the page has loaded the plugin's drawing half. A page that
 * was open before the plugin was installed draws nothing, so the browser runs
 * unseen behind the window — which is exactly when a person says "I cannot see
 * it". Naming it, with the one thing that fixes it, beats a bare "viewers 0".
 */
export const NO_VIEWER = 'Nothing is drawing the mirror in the column yet — this page was loaded before the mirror was, so refresh it once. The window on screen is the same browser.'

/**
 * The sentence for how many tabs are drawing the mirror.
 * @param {number} viewers - tabs drawing frames.
 * @returns {string} a line to append, or '' when something is watching.
 */
export function viewerNote(viewers) {
  return Number(viewers) > 0 ? '' : NO_VIEWER
}

/**
 * How many tabs end up drawing the mirror, once the column has had a moment.
 * The drawing half attaches while the page is still arriving, so asking once,
 * too early, would always answer nothing.
 * @param {any} sidecar - the browser driver.
 * @param {any} page - sidecar page.
 * @param {number} ms - how long to give it.
 * @returns {Promise<number>} tabs drawing the mirror.
 */
async function watchForViewer(sidecar, page, ms) {
  const until = Date.now() + ms
  for (;;) {
    const seen = Number(page?.frames?.size ?? sidecar?.page?.frames?.size ?? 0)
    if (seen > 0 || Date.now() >= until) return seen
    await wait(80)
  }
}

export function isCheckPage(read) {
  const where = String(read?.url ?? '')
  if (where.includes('__cf_chl')) return true
  const title = String(read?.title ?? '').toLowerCase()
  return CHECK_TITLES.some((word) => title.includes(word))
}

export function isErrorPage(page) {
  const url = String(page?.url ?? '')
  return url.startsWith('chrome-error://') || url.startsWith('edge-error://')
}

export async function unreachable(page) {
  if (!isErrorPage(page)) return ''
  /* The code is the part a model can act on: ERR_NAME_NOT_RESOLVED is a typo,
     ERR_PROXY_CONNECTION_FAILED is this machine's proxy, ERR_TIMED_OUT is slow. */
  let detail = ''
  try {
    const said = await evaluate(page, `(() => {
      const text = String(document.body ? document.body.innerText : '')
      const code = (String(text).match(/ERR_[A-Z0-9_]+/) || [''])[0]
      return code
    })()`)
    if (typeof said === 'string') detail = said.trim()
  } catch {
    /* The error page itself refused to be read; the address still says enough. */
  }
  /* Chrome often writes the address it could not reach where the code would
     be: that is still the one thing the person can check. */
  if (detail === '') {
    const title = String(page.title ?? '').trim()
    if (title !== '' && !/\s/.test(title)) detail = title
  }
  if (detail === '') detail = String(page.wantUrl ?? page.lastUrl ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `the network could not reach that address — the browser stopped on its own error page (${detail === '' ? 'no details' : detail}), which is not the site. Nothing on it is page content. Use browser_nav with another address, or fix the connection this machine needs.`
}

/** Key names this driver can press: DOM `key` names for the named keys, and
    the character itself for a printable one (Space also answers to `Space`). */
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ContextMenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
  CapsLock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  NumLock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
  ScrollLock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
  PrintScreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
  Pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r' },
  AudioVolumeMute: { key: 'AudioVolumeMute', code: 'AudioVolumeMute', keyCode: 173 },
  AudioVolumeDown: { key: 'AudioVolumeDown', code: 'AudioVolumeDown', keyCode: 174 },
  AudioVolumeUp: { key: 'AudioVolumeUp', code: 'AudioVolumeUp', keyCode: 175 },
  MediaPlayPause: { key: 'MediaPlayPause', code: 'MediaPlayPause', keyCode: 179 },
  MediaTrackNext: { key: 'MediaTrackNext', code: 'MediaTrackNext', keyCode: 176 },
  MediaTrackPrevious: { key: 'MediaTrackPrevious', code: 'MediaTrackPrevious', keyCode: 177 },
  MediaStop: { key: 'MediaStop', code: 'MediaStop', keyCode: 178 },
}

/* A game moves while a key is held, and the keys a game listens for are letters
   and digits, not the ones a form needs. Each entry carries what a browser
   reports: the `key` value, the physical `code`, and the legacy number old
   engines still look at. */
for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
  KEYS[letter] = { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), text: letter }
  /* A capital is its own key event: the page reads `A` with shift held, and a
     form inserts `A`, not `a`. */
  KEYS[letter.toUpperCase()] = {
    key: letter.toUpperCase(),
    code: `Key${letter.toUpperCase()}`,
    keyCode: letter.toUpperCase().charCodeAt(0),
    text: letter.toUpperCase(),
    shift: true,
  }
}
for (const digit of '0123456789') {
  KEYS[digit] = { key: digit, code: `Digit${digit}`, keyCode: digit.charCodeAt(0), text: digit }
}

/* The symbols above the digits and around the alphabet, both halves of every
   key: a page reads `?` as Slash with shift down, and a field inserts `?`.
   `keyCode` is the legacy VK number Windows and old pages compare against. */
const PUNCTUATION = [
  ['Backquote', '`', 192], ['Minus', '-', 189], ['Equal', '=', 187],
  ['BracketLeft', '[', 219], ['BracketRight', ']', 221], ['Backslash', '\\', 220],
  ['Semicolon', ';', 186], ['Quote', "'", 222], ['Comma', ',', 188],
  ['Period', '.', 190], ['Slash', '/', 191],
]
const SHIFTED_SYMBOLS = [
  ['~', 'Backquote', 192], ['!', 'Digit1', 49], ['@', 'Digit2', 50], ['#', 'Digit3', 51],
  ['$', 'Digit4', 52], ['%', 'Digit5', 53], ['^', 'Digit6', 54], ['&', 'Digit7', 55],
  ['*', 'Digit8', 56], ['(', 'Digit9', 57], [')', 'Digit0', 48], ['_', 'Minus', 189],
  ['+', 'Equal', 187], ['{', 'BracketLeft', 219], ['}', 'BracketRight', 221], ['|', 'Backslash', 220],
  [':', 'Semicolon', 186], ['"', 'Quote', 222], ['<', 'Comma', 188], ['>', 'Period', 190],
  ['?', 'Slash', 191],
]
for (const [code, char, keyCode] of PUNCTUATION) {
  KEYS[char] = { key: char, code, keyCode, text: char }
}
for (const [char, code, keyCode] of SHIFTED_SYMBOLS) {
  KEYS[char] = { key: char, code, keyCode, text: char, shift: true }
}

/* Function keys, the numeric keypad a page can listen to, and the keys that do
   nothing in a text field but everything in an app: a canvas game, a document
   editor, a video player. */
for (let n = 1; n <= 12; n += 1) {
  KEYS[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }
}
for (const digit of '0123456789') {
  KEYS[`Numpad${digit}`] = { key: digit, code: `Numpad${digit}`, keyCode: 96 + Number(digit), text: digit }
}
KEYS.NumpadAdd = { key: '+', code: 'NumpadAdd', keyCode: 107, text: '+' }
KEYS.NumpadSubtract = { key: '-', code: 'NumpadSubtract', keyCode: 109, text: '-' }
KEYS.NumpadMultiply = { key: '*', code: 'NumpadMultiply', keyCode: 106, text: '*' }
KEYS.NumpadDivide = { key: '/', code: 'NumpadDivide', keyCode: 111, text: '/' }
KEYS.NumpadDecimal = { key: '.', code: 'NumpadDecimal', keyCode: 110, text: '.' }

/* The names people actually type, and the spelling a model guesses. */
const KEY_ALIASES = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', spacebar: 'Space', space: 'Space',
  menu: 'ContextMenu', prtsc: 'PrintScreen', printscreen: 'PrintScreen',
}

/**
 * The event a browser would report for a named key.
 * @param {string} name - a key in {@link KEYS}, or something close to one.
 * @returns {{key: string, code: string, keyCode: number, text?: string, shift?: boolean}} the event fields.
 * @throws {Error} when the key does not exist.
 */
export function keySpec(name) {
  const raw = String(name ?? '')
  const exact = KEYS[raw]
  if (exact !== undefined) return exact
  if (raw === ' ') return KEYS.Space
  const alias = KEY_ALIASES[raw.toLowerCase()]
  if (alias !== undefined) return KEYS[alias]
  const capital = raw.charAt(0).toUpperCase() + raw.slice(1)
  if (KEYS[capital] !== undefined) return KEYS[capital]
  const fn = /^f([1-9]|1[0-2])$/i.exec(raw)
  if (fn !== null) return KEYS[`F${fn[1]}`]
  throw new Error(`sidecar: no such key ${raw}`) // ui-copy-ignore
}

/**
 * Turn `Ctrl+Shift` into the CDP modifier bits. `Mod` is the platform's own
 * command key: Command on macOS, Control on Windows and Linux — one spelling
 * for the shortcut a page treats as copy, undo, select-all.
 * @param {string} held - modifiers joined by +, any of Alt/Option, Ctrl/Control,
 *   Meta/Cmd/Command/Super/Win, Shift, Mod.
 * @param {string} [platform] - defaults to this process's platform.
 * @returns {number} CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */
export function modifierBits(held, platform = process.platform) {
  let bits = 0
  for (const raw of String(held ?? '').split('+')) {
    const one = raw.trim().toLowerCase()
    if (one === 'alt' || one === 'option' || one === 'opt' || one === '⌥') bits |= 1
    else if (one === 'ctrl' || one === 'control' || one === '^') bits |= 2
    else if (one === 'meta' || one === 'cmd' || one === 'command' || one === 'super' || one === 'win' || one === '⌘') bits |= 4
    else if (one === 'shift' || one === '⇧') bits |= 8
    else if (one === 'mod') bits |= platform === 'darwin' ? 4 : 2
  }
  return bits
}

/**
 * Turn what the mirror's client posted into the event the page should see. A
 * capital letter carries its shift, a shortcut becomes the browser command it
 * names, and a release carries no text so the field does not type twice.
 * @param {any} body - `{ key, code?, keyCode?, modifiers?, text?, down?, repeat? }`.
 * @returns {{name: string, down: boolean, repeat: boolean, spec: any, command: string|null}} the event.
 */
export function keyEvent(body) {
  const name = String(body?.key ?? '')
  let known
  try {
    known = keySpec(name)
  } catch {
    known = null
  }
  const held = Number(body?.modifiers ?? 0)
  const down = body?.down !== false
  const repeat = body?.repeat === true
  const capital = name.length === 1 && name !== name.toLowerCase()
  const modifiers = capital ? held | 8 : held
  const command = down === true && repeat === false ? commandOf(name, modifiers) : null
  const text = command !== null ? undefined : body?.text === undefined ? known?.text : String(body.text)
  return {
    name,
    down,
    repeat,
    spec: {
      key: name,
      code: String(body?.code ?? known?.code ?? name),
      keyCode: Number(body?.keyCode ?? 0) || known?.keyCode || 0,
      text,
      modifiers,
    },
    command,
  }
}

/**
 * Read a chord the way a shortcut is written: `Ctrl+Shift+Tab` is the held
 * modifiers Ctrl and Shift around one Tab, and `Mod+a` is Command+a on macOS.
 * @param {string} chord - keys joined by +, modifiers may be in it.
 * @param {number} [modifiers] - bits already held.
 * @returns {{names: string[], modifiers: number}} the keys to press and the bits.
 */
export function splitChord(chord, modifiers = 0) {
  const bits = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, super: 4, win: 4, shift: 8, option: 1, opt: 1, mod: process.platform === 'darwin' ? 4 : 2 }
  const names = []
  let held = modifiers
  for (const raw of String(chord ?? '').split('+')) {
    const one = raw.trim()
    if (one === '') continue
    const bit = bits[one.toLowerCase()]
    if (bit === undefined) names.push(one)
    else held |= bit
  }
  return { names, modifiers: held }
}

/**
 * The editing command a browser runs for a shortcut, if any: copy and paste are
 * commands, not key events, and a key event alone leaves the clipboard alone.
 * @param {string} name - the key name.
 * @param {number} modifiers - CDP modifier bits.
 * @returns {string|null} a CDP command name, or null.
 */
export function commandOf(name, modifiers) {
  /* Either command key counts: a page listens for the one its platform uses,
     and the mirror can be driven from a machine with the other one. */
  if ((modifiers & 6) === 0) return null
  const one = String(name ?? '').toLowerCase()
  if (one === 'v') return 'paste'
  if (one === 'c') return 'copy'
  if (one === 'x') return 'cut'
  if (one === 'a') return 'selectAll'
  if (one === 'z') return (modifiers & 8) !== 0 ? 'redo' : 'undo'
  if (one === 'y') return 'redo'
  return null
}

/**
 * Press a key: keyDown, then keyUp, with the character when the key types one.
 * @param {any} page - sidecar page.
 * @param {string} name - key name.
 * @param {number} [modifiers] - CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 * @returns {Promise<void>} done.
 */
export async function pressKey(page, name, modifiers = 0, holdMs = 0) {
  const key = keySpec(name)
  const withShift = (key.shift === true ? modifiers | 8 : modifiers)
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: withShift }
  /* Copy, paste, undo and select-all are editor commands: a key event alone
     leaves the clipboard and the field where they were. */
  const command = commandOf(key.text ?? key.key, withShift)
  await page.key('keyDown', command === null
    ? (key.text === undefined ? base : { ...base, text: key.text })
    : { ...base, text: undefined, commands: [command] })
  /* A key held down is how a game moves: down, wait, up — not a tap. */
  if (holdMs > 0) await new Promise((settle) => setTimeout(settle, holdMs))
  await page.key('keyUp', base)
}

/**
 * Press several keys at once and hold them: the diagonal a game expects, and a
 * chord such as Shift+ArrowLeft. Releasing in reverse order is what a pair of
 * hands does, and some engines only notice the last key that went up.
 * @param {any} page - sidecar page.
 * @param {string[]} names - key names, for example ['ArrowLeft', 'ArrowUp'].
 * @param {number} [modifiers] - CDP modifier bits.
 * @param {number} [holdMs] - how long every key stays down.
 * @returns {Promise<void>} done.
 */
export async function pressChord(page, names, modifiers = 0, holdMs = 0) {
  const keys = names.map((name) => {
    const key = keySpec(name)
    return { key, base: { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: key.shift === true ? modifiers | 8 : modifiers } }
  })
  for (const one of keys) await page.key('keyDown', one.key.text === undefined ? one.base : { ...one.base, text: one.key.text })
  if (holdMs > 0) await new Promise((settle) => setTimeout(settle, holdMs))
  for (const one of [...keys].reverse()) await page.key('keyUp', one.base)
}

/**
 * Empty the field that has focus, whatever this machine calls select-all:
 * Command on macOS, Control elsewhere. A page can swallow the shortcut, so any
 * remaining text is selected in the page instead, ready for the next insert.
 * @param {any} page - sidecar page.
 * @returns {Promise<void>} the field is empty, or its text is selected.
 */
export async function clearFocus(page) {
  const command = process.platform === 'darwin' ? 4 : 2 // ui-copy-ignore
  const chord = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: command }
  await page.key('keyDown', chord)
  await page.key('keyUp', chord)
  await pressKey(page, 'Backspace')
  const leftover = await page.cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const field = document.activeElement
      if (field === null) return false
      const text = typeof field.value === 'string' ? field.value : (field.isContentEditable === true ? field.textContent : '')
      if (String(text ?? '') === '') return false
      if (typeof field.select === 'function') field.select()
      else if (field.isContentEditable === true) document.execCommand('selectAll')
      return true
    })()`,
    returnByValue: true,
  }).catch(() => null)
  if (leftover?.result?.value === true) return
}

/**
 * Say the person touched the mirror themselves since the last tool call, once.
 * The agent shares the page with them, so it should read what they left rather
 * than assume the page is where its own last step put it.
 * @param {any} sidecar - the browser driver.
 * @returns {string} a sentence to append, or an empty string.
 */
export function personNote(sidecar) {
  const person = sidecar?.person
  if (person === undefined || person === null || person.at === 0 || person.seen === true) return '' // ui-copy-ignore
  person.seen = true
  const age = Date.now() - person.at
  if (age > 120_000) return ''
  const when = age < 3000 ? 'just now' : `${Math.round(age / 1000)} s ago`
  const at = person.kind === 'click' || person.kind === 'wheel' ? ` at ${Math.round(person.x)},${Math.round(person.y)}` : '' // ui-copy-ignore
  return `\nthe person also used the page: ${person.kind}${at}, ${when}`
}

/**
 * What an action says when the person is using the mirror right now.
 *
 * The pane is theirs as much as the agent's: someone filling a field by hand
 * should not have the agent click somewhere else under their fingers. Hovering
 * is not taking the page, only real input is, and the hold is short, so a stray
 * click costs a few seconds rather than a run.
 * @param {any} sidecar - the browser driver.
 * @returns {string} a refusal, or '' when the agent may act.
 */
export function holdText(sidecar) {
  const left = Number(sidecar?.holding?.() ?? 0)
  if (left <= 0) return ''
  return `the person is using the mirror (${String(Math.ceil(left / 1000))} s more) — nothing was sent. Let them finish, then repeat this call; browser_resume takes the page back now.`
}

/**
 * Ask the page what is sitting over a control, and which control would take
 * that away.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref that was about to be used.
 * @returns {Promise<null|{tag: string, name: string, dismiss: null|{x: number, y: number, name: string}}>} the thing on top.
 */
async function coverProbe(page, ref) {
  if (!(Number(ref) > 0) || Number(ref) >= 900_000) return null
  const said = await page.cdp.send('Runtime.evaluate', { expression: covering(Number(ref)), returnByValue: true }).catch(() => null)
  const value = String(said?.result?.value ?? '')
  if (value === '') return null
  let top = null
  try {
    top = JSON.parse(value)
  } catch (error) {
    return null
  }
  if (top === null || typeof top !== 'object') return null
  const dismiss = top.dismiss !== null && typeof top.dismiss === 'object' && Number.isFinite(Number(top.dismiss.x))
    ? { x: Number(top.dismiss.x), y: Number(top.dismiss.y), name: String(top.dismiss.name ?? '') }
    : null
  return { tag: String(top.tag ?? ''), name: String(top.text ?? ''), dismiss } // ui-copy-ignore
}

/**
 * Say when something else is sitting over the control, because a click that
 * lands under a banner looks exactly like a click that did nothing.
 * @param {ReturnType<typeof coverProbe>} probe - what the page said is on top.
 * @returns {string} a sentence, or an empty string.
 */
function coverNote(probe, moved) {
  if (probe === null || probe === undefined) return ''
  const what = probe.tag === 'div' || probe.tag === 'section' ? 'an overlay' : `a ${probe.tag}`
  const head = `
${what} covers it${probe.name === '' ? '' : `: ${probe.name}`}`
  /* A banner that is about to be cleared is not a warning: the line below it
     already says what was clicked on the way, so do not claim the click will
     land under something that is leaving. */
  return moved ? head : `${head} — the click would land beneath it`
}

/**
 * Clear a cookie banner or modal the way the person would, so the click the
 * agent meant still happens. Only a small safe set of words counts as a way
 * out — an overlay offering to pay, delete or sign out is reported, never
 * accepted on the person's behalf.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref the agent meant to use.
 * @returns {Promise<{note: string, cleared: boolean, name: string}>} what happened.
 */
async function clearCover(page, ref) {
  const probe = await coverProbe(page, ref)
  if (probe === null) return { note: '', cleared: true, name: '' }
  const note = coverNote(probe, probe.dismiss !== null)
  const away = probe.dismiss
  if (away === null) return { note, cleared: false, name: '' }
  await page.mouse('mouseMoved', { x: away.x, y: away.y })
  await page.mouse('mousePressed', { x: away.x, y: away.y, clickCount: 1 })
  await page.mouse('mouseReleased', { x: away.x, y: away.y, clickCount: 1 })
  /* Prove the banner left instead of guessing a paint delay: poll the same
     question the refusal would ask, and stop the moment it answers clear. */
  let again = await coverProbe(page, ref)
  for (let look = 0; look < 8 && again !== null; look += 1) {
    await wait(20)
    again = await coverProbe(page, ref)
  }
  if (again !== null) return { note: `${note}
- clicking ${away.name} on it did not clear it`, cleared: false, name: away.name } // ui-copy-ignore
  return { note: `${note}
- clicked ${away.name} on it first, then the control`, cleared: true, name: away.name } // ui-copy-ignore
}

/**
 * The same clearing, said in one clause so a numbered step stays one line.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref the step was about to use.
 * @returns {Promise<string>} a prefix like `after Accept on a banner, ` or empty.
 */
export async function coverLead(page, ref) {
  const gate = await clearCover(page, ref)
  return gate.name === '' ? '' : `after ${gate.name} on a banner, `
}

/** @param {number} ms - how long. */
function wait(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}

/**
 * Evaluate an expression and return its value, JSON-safe.
 * @param {any} page - sidecar page.
 * @param {string} expression - JavaScript.
 * @param {{contextId?: number, sessionId?: string}|null} [route] - frame to run in.
 * @returns {Promise<any>} the value.
 */
async function evaluate(page, expression, route, raceMs = 2000) {
  const params = { expression, returnByValue: true, awaitPromise: true }
  if (route?.contextId !== undefined) params.contextId = route.contextId
  /* A page that navigates mid-call destroys the context this ran in; the
     rejection arrives after the race is already lost. Handled, so it cannot
     take the whole process down with it. */
  const call = page.cdp.send('Runtime.evaluate', params, route?.sessionId)
    .catch((error) => ({ threw: String(error?.message ?? error) }))
  let timer = null
  const raced = await Promise.race([call, new Promise((done) => { timer = setTimeout(() => done('timeout'), raceMs) })])
  clearTimeout(timer)
  if (raced === 'timeout') return undefined
  if (raced?.threw !== undefined) return undefined
  const { result, exceptionDetails } = raced
  if (exceptionDetails !== undefined) {
    return { error: String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed') }
  }
  return result?.value
}

/**
 * The local storage a page is holding, per origin: some sites keep the sign-in
 * itself there and cookies alone would come back signed out.
 * @param {any} page - sidecar page.
 * @returns {Promise<Array<{origin: string, items: Record<string, string>}>>} what it holds.
 */
async function storageOf(page) {
  const raw = await evaluate(
    page,
    '(() => { try { const items = {}; for (let i = 0; i < localStorage.length; i += 1) { const key = localStorage.key(i); if (key !== null) items[key] = String(localStorage.getItem(key)).slice(0, 4000); } return JSON.stringify([{ origin: location.origin, items }]) } catch { return "[]" } })()',
    null,
    4000,
  )
  let rows = []
  try {
    rows = JSON.parse(String(raw ?? '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row) => row !== null && typeof row === 'object' && typeof row.origin === 'string' && row.items !== null && typeof row.items === 'object')
    .map((row) => ({ origin: String(row.origin), items: Object.fromEntries(Object.entries(row.items).slice(0, 200).map(([key, value]) => [key, String(value)])) }))
}

/**
 * Puts one origin's local storage back. The page has to be on that origin to
 * write to it, so this navigates there first — a sign-in that lives in local
 * storage is worth the extra step.
 * @param {any} page - sidecar page.
 * @param {{origin: string, items: Record<string, string>}} row - what to put back.
 * @returns {Promise<number>} how many entries went in.
 */
async function restoreStorage(page, row) {
  if (String(row?.origin ?? '') === '' || page === null) return 0
  try {
    const here = String(page.url ?? '')
    if (!here.startsWith(String(row.origin))) await page.navigate(String(row.origin))
  } catch {
    return 0
  }
  const written = await evaluate(
    page,
    `(() => { try { const items = ${JSON.stringify(row.items ?? {})}; for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value); return Object.keys(items).length } catch { return 0 } })()`,
    null,
    4000,
  )
  return Number(written) || 0
}

/**
 * What the page looks like in one cheap string: address, title, how many
 * elements and how much text. Two of these equal says the click did nothing
 * visible — worth saying, so the model does not click a dead control twice.
 * A Flash page has no DOM to ask, so its frame counter answers instead.
 * @param {any} page - sidecar page.
 * @returns {Promise<string>} a fingerprint, or '' when the page would not say.
 */
export async function pageMark(page) {
  if (page?.flashBridge !== null && page?.flashBridge !== undefined) {
    return `flash:${Number(page.seq ?? 0)}:${Number(page.lastFrameAt ?? 0)}`
  }
  const said = await evaluate(page, `(() => { const body = document.body; return String(document.title || '').slice(0, 80) + '|' + String(location.href).slice(0, 200) + '|' + (body ? body.innerText.length : 0) + '|' + document.querySelectorAll('*').length })()`).catch(() => undefined)
  return typeof said === 'string' ? said : ''
}

/**
 * The page's answer, as an object.
 * @param {any} said - what evaluate returned.
 * @returns {any} the answer, or null when the page did not answer.
 */
function asSpot(said) {
  if (typeof said !== 'string') return null
  try {
    return JSON.parse(said)
  } catch {
    return null
  }
}

/**
 * Wait until the page has settled: loading finished and the address stopped
 * changing. Acting on a page mid-navigation is how a driver clicks the old page.
 * @param {any} page - sidecar page.
 * @param {number} [timeout] - ceiling in milliseconds.
 * @returns {Promise<string>} the address it settled on.
 */
export async function settle(page, timeout = 5000, since = 0) {
  /* A Flash page has no load events and no DOM of its own to poll: the next
     picture is the only sign the click changed anything, and the bridge paints
     every pump, so this ends at the frame instead of at the timeout. */
  if (page.flashBridge !== null && page.flashBridge !== undefined) {
    const until = Date.now() + Math.min(timeout, 700)
    const before = Number(page.seq ?? 0)
    while (Date.now() < until) {
      if (Number(page.seq ?? 0) > before || Number(page.lastFrameAt ?? 0) > since) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return String(page.url ?? '')
  }
  /* A click may have opened a tab. The mirror follows it, so every tool that
     waited on a page ends up on the page the person would be looking at. */
  const opened = typeof page.adoptOpened === 'function' ? await page.adoptOpened().catch(() => '') : ''
  const deadline = Date.now() + timeout
  const started = Date.now()
  let last = ''
  let steady = 0
  while (Date.now() < deadline) {
    if (page.dialog !== null && page.dialog !== undefined) return String(page.url ?? '')
    /* The browser already said the load it began has finished. That is the same
       answer a readyState poll gives, and it stays true while a page's own
       scripts hold the main thread, which is exactly when the poll stalls. */
    const began = Number(page.navStarted ?? 0)
    const fired = Number(page.loadFired ?? 0)
    /* Two event-only answers: nothing began loading since the action, or the
       navigation this action started has already finished. Neither needs the
       renderer, whose answer can take seconds on a page that is busy. */
    if (since > 0 && began <= since) return String(page.url ?? '')
    if (fired > 0 && fired >= began && (since === 0 || fired >= since)) return String(page.url ?? '')
    /* A click opened a page whose own requests hang: the browser began loading
       and nothing has finished since. A person presses Esc and uses what
       arrived, and waiting the whole timeout only to give up helps no one. */
    if (since > 0 && began > since && Date.now() - began > 900) {
      await page.cdp.send('Page.stopLoading', {}).catch(() => {})
      return String(page.url ?? '')
    }
    const state = await evaluate(page, '({ ready: document.readyState, href: location.href, n: document.getElementsByTagName("*").length, c: (document.body?.textContent ?? "").length })', null, 400)
    /* Nothing began loading since the action, and the page is complete: the
       click changed state without navigating, so there is nothing to wait for. */
    if (since > 0 && state?.ready === 'complete' && Number(page.navStarted ?? 0) <= since) return String(state?.href ?? '')
    const key = `${String(state?.ready)}|${String(state?.href)}|${String(state?.n)}|${String(state?.c)}`
    steady = key === last ? steady + 1 : 0
    last = key
    /* A page that already says complete needs one steady poll, not two: the
       second look is what a redirect needs, and a click usually has none. */
    if (state?.ready === 'complete' && steady >= 1) return String(state?.href ?? '')
    if (state?.ready !== 'loading' && steady >= 2) return String(state?.href ?? '')
    /* A loaded page can change on the next paint; a loading one is either
       navigating or about to be. Right after an action that is usually the
       page the action opened, which lands in tens of milliseconds, so the
       first quarter second is watched closely and only then slows down. */
    const fresh = Date.now() - started < 250
    await wait(state?.ready === 'complete' ? (fresh ? 12 : 25) : (fresh ? 12 : 60))
  }
  return ''
}

/**
 * Poll the page until a condition holds.
 * @param {any} page - sidecar page.
 * @param {string} expression - a JavaScript expression that is true when done.
 * @param {number} timeout - ceiling in milliseconds.
 * @returns {Promise<boolean>} whether it ever held.
 */
async function until(page, expression, timeout) {
  /* The page watches itself. One round trip that the page resolves on the
     mutation which matters: no snapshot every 100 ms, no rounding the answer up
     to the next tick, and nothing to miss between two polls. */
  const ceiling = Math.max(200, Number(timeout) || 1000)
  const script = `new Promise((done) => {
    const deadline = Date.now() + ${String(ceiling)}
    let watcher = null
    let timer = null
    let frame = null
    const stop = (value) => {
      if (watcher !== null) watcher.disconnect()
      watcher = null
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      done(value)
    }
    const test = () => { try { return Boolean(${expression}) } catch (error) { return false } }
    if (test()) return stop(true)
    watcher = new MutationObserver(() => { if (test()) stop(true) })
    if (document.documentElement !== null) watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    const tick = () => {
      if (test()) return stop(true)
      if (Date.now() >= deadline) return stop(false)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    timer = setTimeout(() => stop(false), deadline - Date.now())
  })`
  const answer = await evaluate(page, script, undefined, ceiling + 3000)
  return answer === true
}

/**
 * How long the page has been still: a mutation resets the clock, and the call
 * comes back the moment nothing has moved for `quiet` ms. Reads no node, so an
 * animation-heavy page costs the same as a blank one.
 */
async function quietInPage(page, timeout = 5000, quiet = 350) {
  const ceiling = Math.max(300, Number(timeout) || 5000)
  const script = `new Promise((done) => {
    const ceiling = Date.now() + ${String(ceiling)}
    const settleMs = ${String(Math.max(50, Number(quiet) || 350))}
    let changedAt = Date.now()
    let frame = null
    const watcher = new MutationObserver(() => { changedAt = Date.now() })
    if (document.documentElement !== null) watcher.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    const tick = () => {
      const now = Date.now()
      if (now - changedAt >= settleMs) { watcher.disconnect(); return done(true) }
      if (now >= ceiling) { watcher.disconnect(); return done(false) }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  })`
  const answer = await evaluate(page, script, undefined, ceiling + 3000)
  return answer === true
}

/**
 * One step of a batch. Kept small on purpose: every step is one thing a person
 * would do with a mouse or a keyboard.
 * @param {any} page - sidecar page.
 * @param {any} step - the step.
 * @returns {Promise<string>} a compact report.
 */
/** The first control whose words match, scrolled into view. Text can beat a number: it costs no read. */
/** Words a label can lose without changing what it asks for. */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'my', 'your', 'please', 'click', 'tap', 'button', 'btn', 'link', 'now'])

/**
 * The significant words of a label, lowercased.
 * @param {unknown} text - a label.
 * @returns {string[]} words worth comparing.
 */
export function tokensOf(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word !== '' && !SMALL_WORDS.has(word))
}

/**
 * The one label that means what the caller said when no label repeats it.
 * Only an unambiguous winner is offered, so a paraphrase cannot silently click
 * a different control than the one asked for.
 * @param {Array<{ref: number, name?: string, view?: boolean}>} controls - controls from a read.
 * @param {string} words - what the caller asked for.
 * @returns {any} the best control, or null when nothing stands out.
 */
export function nearestByWords(controls, words) {
  const want = tokensOf(words)
  if (want.length === 0 || !Array.isArray(controls)) return null
  const scored = []
  for (const control of controls) {
    if (control?.view === false) continue
    const have = new Set(tokensOf(control?.name))
    if (have.size === 0) continue
    let shared = 0
    for (const word of want) if (have.has(word)) shared += 1
    const cover = shared / want.length
    if (shared === 0 || cover < 0.5) continue
    scored.push({ control, score: cover * 0.7 + (shared / have.size) * 0.3 })
  }
  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  const second = scored[1]
  if (second !== undefined && second.score > best.score - 0.05) return null
  if (String(best.control.name ?? '').length > String(words).length * 3 + 12) return null
  return { ...best.control, ref: Number(best.control.ref) }
}

export async function findWords(page, words, known) {
  /* The words a caller used usually came from a read that already happened, so
     look among those numbers first: one position check is a single evaluate,
     while a fresh read walks the whole page. A number the page no longer has
     falls through to the read, so a redraw is not a missed click. */
  const squeezeOf = (text) => String(text).toLowerCase().replace(/\s+/g, '')
  const wantedFirst = squeezeOf(words)
  const remembered = Array.isArray(known) ? known.filter((control) => control.view !== false && squeezeOf(control.name ?? '').includes(wantedFirst)) : []
  remembered.sort((a, b) => Number(squeezeOf(a.name ?? '') === wantedFirst) - Number(squeezeOf(b.name ?? '') === wantedFirst))
  /* A page that repeats one word down a list ("Add to cart" on every card) has
     one obvious answer: the first one a person would reach. The last-first
     order that keeps a scrolled page fast also picked whichever duplicate sat
     lowest, so visible matches are tried in reading order first and the near
     end is only the fallback. */
  const firstInOrder = remembered.filter((control) => control.view !== false).sort((a, b) => Number(a.ref) - Number(b.ref))
  const nearEnd = remembered.slice(-8).reverse()
  const order = [...firstInOrder.slice(0, 4), ...nearEnd]
  /* One round trip answers which of these the page still has: a dozen numbers
     left over from a read that a redraw invalidated used to cost a dozen
     checks. Numbers inside a frame keep the per-number route below. */
  const plain = order.map((control) => Number(control.ref)).filter((ref) => Number.isFinite(ref) && ref < FRAME_BASE)
  if (plain.length > 0) {
    const any = await locateFirst(page, plain, wantedFirst)
    if (any?.gone !== true && Number.isFinite(Number(any?.x))) {
      const byRef = order.find((control) => Number(control.ref) === Number(any.ref)) ?? { ref: Number(any.ref) }
      return { ...byRef, ref: Number(any.ref), name: String(any.name ?? byRef.name ?? ''), x: Number(any.x), y: Number(any.y) }
    }
  }
  for (const control of order.filter((control) => Number(control.ref) >= FRAME_BASE)) {
    const spot = await locate(page, Number(control.ref))
    if (spot.gone === true) continue
    const name = String(spot.name ?? control.name ?? '')
    if (!squeezeOf(name).includes(wantedFirst)) continue
    return { ...control, ref: Number(control.ref), name, x: Number(spot.x), y: Number(spot.y) }
  }
  const read = await readPage(page, { mode: 'text', maxChars: 1200, max: 200 })
  const shown = read.controls.filter((control) => control.view !== false)
  /* The words may sit in separate inline nodes: <span>Sign</span><span>in</span>
     reads as "Signin" to the page, so compare with the spaces taken out too. */
  const squeeze = (text) => String(text).toLowerCase().replace(/\s+/g, '')
  const wanted = squeeze(words)
  const found = shown.find((control) => squeeze(control.name) === wanted) ?? shown.find((control) => squeeze(control.name).includes(wanted))
  if (found === undefined) {
    /* A button the page redrew often only swaps one word, and a person says
       "submit order" for "Place order". Accept only an unambiguous winner. */
    const near = nearestByWords(shown, words)
    if (near !== null) {
      const spot = await locate(page, near.ref)
      if (spot.gone === true) return null
      return { ...near, x: Number(spot.x), y: Number(spot.y) }
    }
    return null
  }
  /* When only the squeezed form matched, say the words the caller used: the
     page spread them over nodes and "Signin" is not what anyone wrote. */
  const hit = squeeze(found.name) === wanted && found.name.toLowerCase() !== words.toLowerCase() ? { ...found, name: words } : found
  const spot = await locate(page, hit.ref)
  if (spot.gone === true) return null
  return { ...hit, x: Number(spot.x), y: Number(spot.y) }
}

/** Kinds that take typed text, so a click on one is a click on a field. */
const EDITABLE_KINDS = ['input', 'textarea', 'select', 'combobox', 'textbox', 'searchbox', 'password', 'search', 'email', 'number', 'tel', 'url', 'date']

/**
 * The field the words belong to, when the words are not on the field itself.
 * @param {any} page - sidecar page.
 * @param {string} words - what the field is called on screen.
 * @returns {Promise<{x: number, y: number, name: string}|null>} where to click.
 */
async function fieldSpot(page, words) {
  const said = await evaluate(page, labelSpot(words))
  if (said === undefined || said === null || said.error !== undefined) return null
  const spot = typeof said === 'string' ? JSON.parse(said) : said
  if (spot === null || spot.name === undefined || spot.name === '') return null
  return { x: Number(spot.x), y: Number(spot.y), name: String(spot.name) }
}

/**
 * Where the field called these words is, clearing a banner over it first.
 * @param {any} page - sidecar page.
 * @param {string} words - what the field is called on screen.
 * @returns {Promise<{x: number, y: number, name: string, lead: string, ref?: number}|null>} the click.
 */
async function fieldByName(page, words, known) {
  const hit = await findWords(page, words, known)
  const lead = hit === null ? '' : await coverLead(page, hit.ref)
  if (hit !== null && EDITABLE_KINDS.includes(String(hit.kind))) {
    const spot = await locate(page, hit.ref)
    if (spot.gone !== true) return { x: Number(spot.x), y: Number(spot.y), name: String(hit.name), lead, ref: Number(hit.ref) }
  }
  const field = await fieldSpot(page, words)
  if (field !== null) return { ...field, lead }
  if (hit === null) return null
  const spot = await locate(page, hit.ref)
  if (spot.gone === true) return null
  return { x: Number(spot.x), y: Number(spot.y), name: String(hit.name), lead, ref: Number(hit.ref) }
}

/**
 * A date-like field ignores human typing: Chrome's date input wants its own
 * segments, so keystrokes leave the value empty while the call reports success.
 * Set it the way a form would, and say the value the page now holds.
 * @param {any} page - sidecar page.
 * @param {string} text - what the caller wanted in it.
 * @returns {Promise<string>} a clause about the field, or '' when it is not one.
 */
/* The input kinds a person cannot type into: Chrome gives each of them its own
   segment editor, and keys typed at it leave the value empty. */
const DATE_KINDS = ['date', 'time', 'month', 'week', 'datetime-local']

/**
 * The date-like kind the focus is on, if it is on one.
 * @param {any} page - sidecar page.
 * @returns {Promise<string>} date, time… or '' when it is an ordinary field.
 */
async function dateLikeFocus(page) {
  const said = await evaluate(page, `(() => {
    const el = document.activeElement
    if (!el || String(el.tagName).toUpperCase() !== 'INPUT') return ''
    const kind = String(el.type)
    if (!${JSON.stringify(DATE_KINDS)}.includes(kind)) return ''
    if (String(el.value) !== '') return ''
    return JSON.stringify({ kind })
  })()`).catch(() => undefined)
  return String(asSpot(said)?.kind ?? '')
}

async function fillDateLike(page, text) {
  const kind = await dateLikeFocus(page)
  if (kind === '') return ''
  const empty = { kind }
  const want = String(text).trim()
  const after = await evaluate(page, `(() => {
    const el = document.activeElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(want)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return String(el.value)
  })()`).catch(() => undefined)
  if (typeof after !== 'string' || after === '') {
    return `that ${empty.kind} field would not take "${want}" — it wants ${empty.kind === 'time' ? '09:30' : '2026-03-04'}`
  }
  return `set ${after} in the ${empty.kind} field`
}

/**
 * Put text in the focused box the cheapest way that still works there.
 * A box that reacts while you type (suggestion lists, live search) needs the
 * keys in order; anything else takes one paste event, and the box itself is
 * the judge of whether it took it.
 * @param {any} page - sidecar page.
 * @param {string} text - what to type.
 * @param {string} [hint] - the field's name, to spot a live-search box.
 * @returns {Promise<void>} resolves when the box holds the text.
 */
export async function typeInto(page, text, hint = '') {
  const words = String(text)
  if (words === '') return
  const live = /search|query|lookup|filter|搜索|筛选|查询/i.test(hint)
  if (!live && (await page.quickType(words)) === true) {
    await wait(30)
    return
  }
  await page.humanType(words)
}

/**
 * Click a spot, type into it, and optionally clear it first.
 * @param {any} page - sidecar page.
 * @param {{x: number, y: number}} point - where to click.
 * @param {string} text - what to type.
 * @param {{clear?: boolean, submit?: boolean}} options - how.
 */
async function writeAt(page, point, text, options = {}) {
  /* Approach the control the way a hand does: a couple of small moves that
     land in different places, not a teleport followed by a click. */
  const drift = (by) => ({ x: point.x + by, y: point.y + Math.round(by / 2) })
  /* The shape of the approach is what a page can see; the gaps between its
     points only buy latency. Three moves stay, the pauses are frames. */
  await page.mouse('mouseMoved', drift(-14 - Math.round(Math.random() * 10)))
  await wait(5 + Math.round(Math.random() * 8))
  await page.mouse('mouseMoved', drift(-4 - Math.round(Math.random() * 4)))
  await wait(4 + Math.round(Math.random() * 6))
  await page.mouse('mouseMoved', point)
  await wait(5 + Math.round(Math.random() * 8))
  await page.mouse('mousePressed', { ...point, clickCount: 1 })
  await wait(5 + Math.round(Math.random() * 9))
  await page.mouse('mouseReleased', { ...point, clickCount: 1 })
  await wait(14 + Math.round(Math.random() * 18))
  if (options.clear === true) await clearFocus(page)
  /* A date or time input never takes keystrokes: noticing that before typing
     spends one round trip instead of fourteen keys and a failed readback. */
  if (await dateLikeFocus(page) !== '') return await fillDateLike(page, text)
  if (options.human === false) await page.insertText(text)
  else await typeInto(page, text, String(options.hint ?? ''))
  const fixed = await fillDateLike(page, text)
  if (fixed !== '') return fixed
  if (options.submit === true) await pressKey(page, 'Enter')
  return ''
}

/**
 * Where the control behind a ref is now, following it across a re-render.
 * The module-level sibling of findAgain, for runStep, which has no closure.
 * @param {any} page - sidecar page.
 * @param {number} ref - the number the caller used.
 * @param {any[]} [known] - controls from the read that produced the ref.
 * @returns {Promise<{x?: number, y?: number, gone?: boolean, followed?: boolean, was?: string}>} where it is.
 */
async function followRef(page, ref, known) {
  const spot = await locate(page, ref)
  const was = Array.isArray(known) ? known.find((control) => Number(control.ref) === Number(ref)) : undefined
  if (spot.gone !== true) {
    const drift = differs(was, spot)
    return drift === '' ? spot : { gone: true, why: drift }
  }
  if (was === undefined) return spot
  const want = identityOf(was)
  if (want.name === '') return spot
  const read = await readPage(page, { mode: 'text', maxChars: 600, max: 400 })
  const again = read.controls.filter((control) => sameThing(want, control))
  if (again.length !== 1) return spot
  const next = await locate(page, Number(again[0].ref))
  if (next.gone === true) return spot
  follows.count += 1
  return { ...next, followed: true, was: want.name }
}

/**
 * One read state per chat, created the first time that chat reads.
 * @param {Map<string, any>} store - per-chat states.
 * @param {string} id - chat id.
 * @param {any} fallback - state for calls that name no chat.
 * @returns {any} the state of that chat.
 */
export function readStateFor(store, id, fallback) {
  const key = String(id ?? '')
  const known = store.get(key)
  if (known !== undefined) return known
  /* The one object the plugin was started with belongs to calls that name no
     chat, so a chat that does name itself gets an empty one of its own. */
  const fresh = key === '' ? fallback : { refs: [], at: 0 }
  store.set(key, fresh)
  return fresh
}

/**
 * A step that could not be carried out. The batch stops here: the next step was
 * written against a page that never arrived.
 * @param {string} text - what happened.
 * @returns {{text: string, blocked: boolean}} the step result.
 */
function stuck(text) {
  return { text, blocked: true }
}

async function runStep(page, step, known) {
  if (step.ref !== undefined) {
    if (step.tap !== undefined || step.text !== undefined) {
      const lead = await coverLead(page, Number(step.ref))
      const spot = await followRef(page, Number(step.ref), known)
      if (spot.gone === true) return stuck(`ref ${String(step.ref)}: ${REF_GONE}`)
      const after = spot.followed === true ? ` (it was redrawn under a new number, used where it is now)` : ''
      const point = { x: Number(spot.x), y: Number(spot.y) }
      await page.mouse('mouseMoved', point)
      await page.mouse('mousePressed', { ...point, clickCount: 1 })
      await page.mouse('mouseReleased', { ...point, clickCount: 1 })
      if (step.tap !== undefined) return `${lead}clicked ${String(step.ref)} ${String(spot.name ?? '')}`.trim() + after
      await wait(80)
      if (step.clear === true) await clearFocus(page)
      await page.humanType(String(step.text))
      if (step.submit === true) await pressKey(page, 'Enter')
      return `${lead}typed into ${String(step.ref)} ${String(spot.name ?? '')}`.trim() + after
    }
  }
  if (step.tap !== undefined && !/^\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*$/.test(String(step.tap))) {
    const hit = await findWords(page, String(step.tap), known)
    if (hit === null) return stuck(`no control says ${JSON.stringify(String(step.tap))}`)
    const lead = await coverLead(page, hit.ref)
    const spot = await locate(page, hit.ref)
    if (spot.gone === true) return stuck(`ref ${String(hit.ref)}: ${REF_GONE}`)
    const point = { x: Number(spot.x), y: Number(spot.y) }
    await page.mouse('mouseMoved', point)
    await page.mouse('mousePressed', { ...point, clickCount: 1 })
    await page.mouse('mouseReleased', { ...point, clickCount: 1 })
    return `${lead}clicked "${hit.name.slice(0, 60)}"`
  }
  if (step.field !== undefined) {
    /* The words may sit on the field or in a div above a bare input. Only a
       click that lands on the field itself can be trusted with the typing. */
    const target = await fieldByName(page, String(step.field), known)
    if (target === null) return stuck(`${String(step.field)}: ${REF_GONE}`)
    const dated = await writeAt(page, { x: target.x, y: target.y }, String(step.text ?? ''), { clear: step.clear, submit: step.submit })
    if (dated !== '') return dated
    return `${target.lead}typed into "${target.name.slice(0, 60)}"`
  }
  if (step.tap !== undefined) {
    const [x, y] = String(step.tap).split(',').map(Number)
    const point = { x, y }
    await page.mouse('mouseMoved', point)
    await page.mouse('mousePressed', { ...point, clickCount: 1 })
    await page.mouse('mouseReleased', { ...point, clickCount: 1 })
    return `clicked ${String(x)},${String(y)}`
  }
  if (step.text !== undefined) {
    if (step.clear === true) await clearFocus(page)
    await page.humanType(String(step.text))
    if (step.submit === true) await pressKey(page, 'Enter')
    return `typed ${String(step.text).slice(0, 60)}`
  }
  if (step.key !== undefined) {
    await pressKey(page, String(step.key))
    return `pressed ${String(step.key)}`
  }
  if (step.scroll !== undefined) {
    const dy = Number(step.scroll)
    await page.wheel({ x: VIEW.width / 2, y: VIEW.height / 2, dy })
    return `scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}`
  }
  if (step.wait_text !== undefined) {
    const needle = JSON.stringify(String(step.wait_text))
    const ok = await until(page, `document.body ? document.body.innerText.includes(${needle}) : false`, Number(step.timeout ?? 8000))
    return ok ? `saw ${String(step.wait_text)}` : stuck(`did not see ${String(step.wait_text)}`)
  }
  if (step.wait_gone !== undefined) {
    const needle = JSON.stringify(String(step.wait_gone))
    const ok = await until(page, `document.body ? !document.body.innerText.includes(${needle}) : true`, Number(step.timeout ?? 8000))
    return ok ? `${String(step.wait_gone)} went away` : stuck(`${String(step.wait_gone)} stayed`)
  }
  if (step.wait_url !== undefined) {
    const needle = JSON.stringify(String(step.wait_url))
    const ok = await until(page, `location.href.includes(${needle})`, Number(step.timeout ?? 8000))
    return ok ? `at ${String(step.wait_url)}` : stuck(`still at a different address`)
  }
  if (step.open !== undefined) {
    const landed = await page.navigate(String(step.open))
    return `opened ${landed?.url ?? String(step.open)}`
  }
  if (step.eval !== undefined) {
    const value = await evaluate(page, String(step.eval))
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `eval ${String(text).slice(0, 300)}`
  }
  if (step.sleep_ms !== undefined) {
    await wait(Math.min(10_000, Number(step.sleep_ms)))
    return `waited ${String(step.sleep_ms)} ms`
  }
  if (step.wait_idle !== undefined) {
    await settle(page, Number(step.timeout ?? 5000))
    return 'idle'
  }
  return 'nothing to do'
}

/**
 * Read the page and keep the previous read, so `changed_only` has something to
 * compare against.
 * @param {any} page - sidecar page.
 * @param {{refs: any[], at: number, last?: any}} refs - read state for this page.
 * @param {{mode?: string, maxChars?: number}} options - narrowing.
 * @returns {Promise<any>} the read.
 */
/** A read with nothing in it often means the document is still being built:
 * samples of real pages showed zero controls when the read landed before
 * hydration, and the model then calls the page broken. */
function looksEmpty(read) {
  return (read?.controls?.length ?? 0) === 0 && String(read?.text ?? '').trim().length < 40
}

/** @param {string} url - what the page claims to be. @returns {boolean} true when waiting can still help. */
function canFill(url) {
  const said = String(url ?? '')
  return said.startsWith('http://') || said.startsWith('https://')
}

async function remember(page, refs, options) {
  let read = await readPage(page, options)
  if (looksEmpty(read) && canFill(read.url)) {
    /* Hydration and client-side rendering finish a few hundred milliseconds
       after the address does. Read again until the page has something, but
       never longer than a person would wait for a page that stays empty. */
    const deadline = Date.now() + 1500
    while (looksEmpty(read) && canFill(read.url) && Date.now() < deadline) {
      await wait(120)
      const again = await readPage(page, options)
      if (!looksEmpty(again)) {
        read = again
        break
      }
      read = again
    }
  }
  refs.refs = read.controls
  refs.at = Date.now()
  return read
}

/**
 * Two reads of the same page in the same shape say the same thing. Saying it
 * again costs tokens and teaches nothing, so the second read can be one line.
 * @param {any} before - the earlier read.
 * @param {any} after - the read now.
 * @returns {boolean} true when nothing a read would show has changed.
 */
export function sameRead(before, after) {
  if (before === undefined || before === null || after === undefined || after === null) return false
  if (before.url !== after.url || before.title !== after.title) return false
  if (before.text !== after.text) return false
  if (JSON.stringify(before.controls) !== JSON.stringify(after.controls)) return false
  if ((before.focused?.ref ?? null) !== (after.focused?.ref ?? null)) return false
  return true
}

/**
 * Where two readings of a page differ, said in one line. A counter moving, one
 * row appearing, a word edited: the page is mostly the same, and sending all of
 * it again is what makes a long session expensive.
 * @param {string} before - the text earlier.
 * @param {string} after - the text now.
 * @returns {string} a short line, or '' when the two have nothing in common.
 */
export function textChange(before, after) {
  const was = String(before ?? '')
  const now = String(after ?? '')
  let head = 0
  const shortest = Math.min(was.length, now.length)
  while (head < shortest && was[head] === now[head]) head += 1
  let tail = 0
  while (tail < shortest - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1
  const gone = was.slice(head, was.length - tail)
  const came = now.slice(head, now.length - tail)
  /* A page that changed in one place is worth a line; one that shares almost no
     text is a different page, and a diff of it would be as long as the page. */
  if (head + tail < 12) return ''
  const clip = (text) => (text.length > 160 ? `${text.slice(0, 157)}…` : text)
  const near = clip(was.slice(Math.max(0, head - 24), head))
  const far = clip(now.slice(now.length - tail, now.length - tail + 24))
  const line = `${near === '' ? '' : `…${near} `}${gone === '' ? '' : `[${clip(gone)}] `}→ ${came === '' ? '' : `[${clip(came)}] `}${far === '' ? '' : `${far}…`}`
  return line.trim()
}

/**
 * Say only what changed since the previous read.
 * @param {any} previous - the read before.
 * @param {any} next - the read now.
 * @param {{maxChars?: number}} options - narrowing.
 * @returns {string} a diff, small by construction.
 */
export function diffRead(previous, next, options = {}) {
  const maxChars = Number(options.maxChars ?? 2000)
  const before = new Map(previous.controls.map((control) => [control.ref, control]))
  const after = new Map(next.controls.map((control) => [control.ref, control]))
  const lines = [previous.url === next.url ? next.url : `address ${next.url}`]
  const added = next.controls.filter((control) => !before.has(control.ref))
  const removed = previous.controls.filter((control) => !after.has(control.ref))
  const changed = next.controls.filter((control) => {
    const old = before.get(control.ref)
    if (old === undefined) return false
    return old.name !== control.name || old.value !== control.value || old.checked !== control.checked || old.disabled !== control.disabled
  })
  for (const control of added.slice(0, 40)) lines.push(`+ ${control.ref} [${control.kind}] ${control.name}`)
  for (const control of removed.slice(0, 40)) lines.push(`- ${control.ref} ${control.name}`)
  for (const control of changed.slice(0, 40)) {
    const old = before.get(control.ref)
    lines.push(`~ ${control.ref} ${control.name}${old?.value !== control.value ? `: ${old?.value ?? ''} → ${control.value}` : ''}${old?.checked !== control.checked ? (control.checked ? ' (now checked)' : ' (now unchecked)') : ''}`)
  }
  if (added.length + removed.length + changed.length === 0) lines.push('no control changed')
  if (previous.text !== next.text) {
    const said = textChange(previous.text, next.text)
    const room = Math.max(200, Math.min(1200, maxChars - 200))
    if (said !== '') lines.push(`text: ${said}`)
    else {
      const head = next.text.slice(0, room)
      lines.push('', 'text now:', head)
      if (next.text.length > head.length) lines.push(`… ${next.text.length - head.length} more characters`)
    }
  }
  if (next.focused !== null && previous.focused?.ref !== next.focused.ref) lines.push(`focus ${next.focused.ref} ${next.focused.name}`)
  return lines.join('\n')
}

/**
 * The tool surface.
 * @param {any} sidecar - the sidecar browser.
 * @param {{refs: any[], at: number, last?: any}} refs - read state.
 * @param {{logger?: any}} [host] - host services. // ui-copy-ignore
 * @returns {any[]} tool definitions.
 */
/**
 * Read what a selector matches as one line per item.
 * A list read this way costs a fraction of the whole page and keeps the model on
 * the items it came for: the text, plus the link when the item has one.
 * @param {any} page - sidecar page.
 * @param {any} args - select, ref, limit.
 * @returns {Promise<string>} one line per row, and how many there were.
 */
export async function extractRows(page, args) {
  const select = typeof args?.select === 'string' ? args.select.trim() : ''
  if (select === '') return 'Give a selector: what to read, for example "ul.results > li".'
  const ref = Math.trunc(Number(args?.ref ?? 0)) || 0
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(args?.limit ?? 40)) || 40))
  const expression = `(() => {
    const reg = window.__dshRead
    let scope = document
    if (${ref} > 0) {
      const hit = reg !== undefined && typeof reg.find === 'function' ? reg.find(${ref}) : null
      if (hit === null || hit === undefined || hit.el === null || hit.el === undefined) return { gone: true }
      scope = hit.el
    }
    let nodes
    try { nodes = scope.querySelectorAll(${JSON.stringify(select)}) }
    catch { return { bad: true } }
    const rows = []
    for (const node of nodes) {
      if (rows.length >= ${limit}) break
      const raw = typeof node.innerText === 'string' && node.innerText !== '' ? node.innerText : String(node.textContent ?? '')
      const text = raw.replace(/\\s+/g, ' ').trim().slice(0, 200)
      const own = node.matches !== undefined && node.matches('a[href]') === true ? node : null
      const link = own ?? (typeof node.querySelector === 'function' ? node.querySelector('a[href]') : null)
      const full = link !== null && link !== undefined && typeof link.href === 'string' ? link.href : ''
      /* A row on this site says the same with the path alone; the origin is
         already in the result and would be repeated thirty times. */
      const href = full.startsWith(location.origin) ? full.slice(location.origin.length) : full
      rows.push({ text, href })
    }
    return { rows, total: nodes.length }
  })()`
  const out = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true }).catch((error) => ({ error: String(error?.message ?? error) }))
  if (out?.error !== undefined && out.error !== null && typeof out.error === 'string') return `the page did not answer: ${out.error}`
  const value = out?.result?.value
  if (value === undefined || value === null || value === '') return 'the page did not answer; try again, or read the page with browser_view.'
  if (value.gone === true) return `ref ${ref} is gone. Read the page again and use a new number.`
  if (value.bad === true) return `${select} is not a selector this browser understands.`
  const rows = Array.isArray(value.rows) ? value.rows : []
  if (rows.length === 0) return `nothing matched ${select} — the page may still be loading, or the selector is off.`
  const said = rows.map((row, index) => `${index + 1}. ${row.text === '' ? '(empty)' : row.text}${row.href === '' ? '' : ` · ${row.href}`}`)
  const more = Number(value.total) > rows.length ? `\n… ${Number(value.total) - rows.length} more rows` : ''
  return `${rows.length} of ${Number(value.total)} rows matching ${select}:\n${said.join('\n')}${more}`
}

/**
 * Say one thing to a box in the page and take the answer back. The wait ends
 * when the answer has stopped changing, so a streaming reply is not cut off and
 * a page that never answers does not hold the call open forever.
 * @param {any} page - sidecar page.
 * @param {{text?: string, ref?: number, submit?: boolean, timeout_ms?: number}} args - what to say.
 * @returns {Promise<string>} the answer, or why there is none.
 */
/**
 * Whether a box on the page still holds the words that were typed.
 * A box that keeps them never sent them, which is what a signed-out page does.
 * @param {any} page - sidecar page.
 * @param {string} words - what was typed.
 * @returns {Promise<boolean>} true when the words are still in a box.
 */
async function boxHolds(page, words) {
  const wanted = String(words).slice(0, 24)
  if (wanted === '') return false
  const held = await evaluate(page, `(() => {
  const wanted = ${JSON.stringify(wanted)}
  for (const el of document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], input[type="text"], input[type="search"], input:not([type])')) {
    if (String(el.value ?? el.innerText ?? '').trim().includes(wanted)) return true
  }
  return false
})()`)
  return held === true
}

/**
 * Sends a line to whatever chat the page holds and waits for the answer to stop
 * growing. The ref is followed the same way a click follows it, so a reply box
 * that was redrawn since the read still gets the text.
 * @param {any} page - sidecar page.
 * @param {any} args - text, optional ref, optional timeout.
 * @returns {Promise<string>} the answer.
 */
export async function askInPage(page, args) {
const said = String(args?.text ?? '').trim()
if (said === '') return 'Give me something to say.'
const budget = Math.max(3000, Math.min(180_000, Math.trunc(Number(args?.timeout_ms ?? 60_000)) || 60_000))
const before = await readPage(page, { mode: 'text', maxChars: 4000 })
let point = null
if (args?.ref !== undefined) {
  const spot = await followRef(page, Number(args.ref))
  if (spot.gone === true) return spot.why ?? REF_GONE
  point = { x: Number(spot.x), y: Number(spot.y) }
} else {
  const at = await evaluate(page, `(() => {
    let best = null
    for (const el of document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"], input[type="text"], input[type="search"], input:not([type])')) {
      const b = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none' || b.width < 80 || b.height < 18) continue
      if (b.bottom < 0 || b.top > innerHeight) continue
      if (best === null || b.width * b.height > best.area) best = { area: b.width * b.height, x: b.x + Math.min(24, b.width / 2), y: b.y + b.height / 2, name: String(el.getAttribute('placeholder') ?? el.getAttribute('aria-label') ?? '').slice(0, 40) }
    }
    return best === null ? null : { x: Math.round(best.x), y: Math.round(best.y), name: best.name }
  })()`)
  if (at === null || at === undefined) return 'No box to type in on this page. Call browser_view to see what is there.'
  point = { x: Number(at.x), y: Number(at.y) }
}
await page.mouse('mouseMoved', point)
await page.mouse('mousePressed', { ...point, clickCount: 1 })
await page.mouse('mouseReleased', { ...point, clickCount: 1 })
await wait(60)
await page.humanType(said)
if (args?.submit !== false) await pressKey(page, 'Enter')
await wait(500)
if (args?.submit !== false && (await boxHolds(page, said))) {
  return `the words are still in the box 0.5s after pressing Enter: the page did not take the message. If it is waiting for a sign-in, sign in in the column, then ask again.`
}
const started = Date.now()
const deadline = started + budget
let last = before.text
let fresh = ''
let steady = 0
let quiet = 0
while (Date.now() < deadline) {
  await wait(500)
  const now = await readPage(page, { mode: 'text', maxChars: 4000 })
  if (now.text !== last) {
    last = now.text
    fresh = now.text
    steady = 0
    quiet = 0
    continue
  }
  if (fresh !== '') {
    steady += 1
    if (steady >= 3) break
  } else {
    quiet += 1
    if (quiet >= 4 && Date.now() - started > 4000) break
  }
}
const took = Date.now() - started
/* A page that shows neither the words in a box nor the message itself never
   took it: the chips moved, the menu redrew, and none of that is an answer. */
const echo = String(said.slice(0, 24))
if (fresh !== '' && echo.length >= 8 && !fresh.includes(echo)) {
  const asking = /(sign in|log in|登录|注册)/i.test(fresh)
  return `the page changed but does not show the message: it did not take what was sent.${asking ? ' It is asking for a sign-in — sign in in the column, then ask again.' : ' Try browser_view to see what is in the way.'}`
}
/* A box that still holds the words is the page saying it did not take them:
   a signed-out page leaves them there, and the old wording sent the reader
   looking for an answer that was never asked for. */
const stuck = fresh === '' && (await boxHolds(page, said))
if (fresh === '') {
  if (stuck) return `sent it — no answer after ${Math.round(took / 100) / 10}s, and the words are still in the box: the page did not take the message. If it is waiting for a sign-in, sign in in the column, then ask again.`
  return `sent it — no answer after ${Math.round(took / 100) / 10}s; the page still says: ${before.text.slice(0, 400)}`
}
/* The answer may replace the words that were there, so cut at the last
   character the two reads share, not at the old length. */
let shared = 0
while (shared < fresh.length && shared < before.text.length && fresh[shared] === before.text[shared]) shared += 1
const added = fresh.slice(shared)
/* Lines are kept: a reviewer's list is one point per line, and flattening it
   would leave the next round with a paragraph instead of items. */
const words = added.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500)
return `the answer came back in ${Math.round(took / 100) / 10}s:\n${words}`
}

export function sidecarTools(sidecar, refs, host = {}) { // ui-copy-ignore
  /* A ref belongs to the page it was read from, and two chats read two pages.
     One shared read state meant chat B's read replaced chat A's baseline, so A's
     next "what changed" was a diff against a page it never saw and a number from
     A could be matched against B's control. Each chat now keeps its own. */
  const byChat = new Map()
  /**
   * The read state of the chat this call speaks for.
   * @param {string} [id] - chat id; the current one by default.
   * @returns {{refs: any[], at: number, last?: any, lastShape?: string}} its state.
   */
  const refsFor = (id = currentSession()) => readStateFor(byChat, id, refs)
  /* Reading, clicking and typing on Chrome's own error page is not driving the
     site: the text there is Chrome talking, the buttons reload. Those calls are
     refused with the error code instead. The tools that report the browser
     itself — the tab list, the console, failed requests, the address — still
     run, because they are how a stuck person finds out what happened. */
  const withRawPage = async (work) => {
    if (!sidecar.alive) return { text: SIDECAR_OFF }
    const page = await sidecar.ensure({ session: currentSession() })
    const text = await work(page)
    return { text: text + personNote(sidecar) }
  }
  /** Looking is still useful while the person has the page. */
  const withRead = async (work) => {
    /* A call starting means the last click is over: a tab that opens now is not
       going to be followed under this call's feet. */
    try {
      sidecar.page?.disarmFollow?.()
    } catch {
      /* the page is already gone */
    }
    /* A plugin reload makes a new driver while the browser it started keeps
       running. Refusing every read until someone opens a page again would throw
       away a browser that is still there: attach to it instead. */
    if (!sidecar.alive) {
      /* A renderer crash can take the whole browser with it, and the first
         relaunch sometimes loses the race with the old process exiting. One
         more try turns that into a fresh tab instead of a refusal. */
      try {
        await sidecar.ensure({ session: currentSession() })
      } catch {
        await wait(300)
        try {
          await sidecar.ensure({ session: currentSession() })
        } catch {
          return { text: SIDECAR_OFF }
        }
      }
    }
    const page = await sidecar.ensure({ session: currentSession() })
    const dead = await unreachable(page)
    if (dead !== '') return { text: dead + personNote(sidecar) }
    const text = await work(page)
    /* Why a page stopped working is usually in its own log, and looking it up
       costs another call. This is the one place every read passes through, so
       say what went wrong since the previous one, once. */
    const trouble = typeof page.troubleOf === 'function' ? page.troubleOf() : ''
    return { text: text + (trouble === '' ? '' : `\n${trouble}`) + personNote(sidecar) }
  }
  const withPage = async (work) => {
    if (!sidecar.alive) return { text: SIDECAR_OFF }
    const hold = holdText(sidecar)
    if (hold !== '') return { text: hold }
    return withRead(work)
  }
  const look = async (page, options) => {
    const read = await remember(page, refsFor(), options)
    /* A read already showed the address: the next action does not repeat it. */
    if (String(read.url ?? '') !== '') saidUrls.set(page, String(read.url))
    const said = renderPage(read, options)
    return isCheckPage(read) ? `${said}\n${CHECK_NOTE}` : said
  }

  /**
   * Where the control behind a ref is now, following it across a re-render.
   *
   * A ref is a number for an element; a framework that redraws its list throws
   * every element away and makes new ones with a fresh number, so the next call
   * with the old number finds nothing. The page did not become unusable — the
   * control is on screen, saying the same words, usually in the same place.
   * Handing back REF_GONE costs the model a whole round: one read to find the
   * number and one more call to use it. So look the control up by what it is,
   * and only say it is gone when what it is, is gone too.
   * @param {any} page - sidecar page.
   * @param {number} ref - the number the caller used.
   * @returns {Promise<{x?: number, y?: number, gone?: boolean, followed?: boolean, was?: string}>} where it is.
   */
  const findAgain = async (page, ref) => {
    const spot = await locate(page, ref)
    const known = (refsFor().refs ?? []).find((control) => Number(control.ref) === Number(ref))
    if (spot.gone !== true) {
      const drift = differs(known, spot)
      return drift === '' ? spot : { gone: true, why: drift }
    }
    if (known === undefined) return spot
    const want = identityOf(known)
    if (want.name === '') return spot
    const read = await readPage(page, { mode: 'text', maxChars: 600, max: 400 })
    const again = read.controls.filter((control) => sameThing(want, control))
    /* Same words twice on one page is a choice only the person can make: two
       "Delete" buttons in different rows are not interchangeable. */
    if (again.length !== 1) return spot
    const next = await locate(page, Number(again[0].ref))
    if (next.gone === true) return spot
    follows.count += 1
    return { ...next, followed: true, was: want.name }
  }

  return [
    {
      name: 'browser_open', // ui-copy-ignore
      description: 'Start (or reuse) the background browser — a real Chrome with its own persistent profile — and open a URL in it. It is not the host\'s own browser tab: this Chrome runs on its own and only its picture is mirrored into this chat\'s right column, so it keeps working while the person looks elsewhere. Logins survive restarts. Use it only when the person explicitly asked for a browser this turn; reading a URL, a document or checking whether a site answers is `web_fetch`\'s job, not this one.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open. Omit to reuse the current page.' },
          headless: { type: 'boolean', description: 'Run without a window. Default true; turn off only if a site refuses a windowless browser.' },
          flash: {
            type: 'boolean',
            description: 'Play the page in the Flash-era browser instead of Chrome — for a site whose game is a Flash movie that never got an HTML5 version. Default off; switching either way restarts the browser.',
          },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @param {any} exec - tool run. @returns {Promise<{text: string}>} what the page is. */
      execute: async (args, exec) => {
        const who = String(exec?.agent?.id ?? '')
        const page = await sidecar.ensure({ url: args?.url, headless: args?.headless, flash: args?.flash, session: who })
        if (args?.url === undefined) await page.readTitle()
        /* A window on the person's screen is their business, not a surprise: say
           it, so nobody wonders what popped up. A site that refuses a windowless
           browser is the only reason this happens. */
        /* The Flash runtime is windowless even when headless is false: its window
           is never shown, so nothing popped up to explain. */
        const windowed = sidecar.headless === false && sidecar.flash !== true ? 'The browser is showing a window this time — a site only opens for a windowed one. Same profile, same logins.\n' : ''
        /* The tab appears in the calling chat and nowhere else: the person may
           be reading a different chat, and a browser there would be a surprise. */
        if (who !== '') host.want?.(who) // ui-copy-ignore
        await settle(page, 8000)
        const dead = await unreachable(page)
        if (dead !== '') return { text: dead }
        /* The column may still be drawing nothing: say so here, where the
           person is looking for a picture, rather than only in browser_state. */
        const unseen = who === '' ? '' : viewerNote(await watchForViewer(sidecar, page, 1200))
        return { text: windowed + (unseen === '' ? '' : `${unseen}\n`) + await look(page, { mode: 'text' }) + (await pdfNote(page)) }
      },
    },
    {
      name: 'browser_mode', // ui-copy-ignore
      description: 'Choose how this chat acts from now on. "human" moves the real mouse and presses real keys, which no page can tell from a person — games and pages that watch pointer movement need this. "dom" clicks and fills the controls the page registered, which reaches one that an overlay covers and leaves key handlers alone. A call can also pass its own mode, which wins for that call only.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mode: { type: 'string', enum: ['human', 'dom'], description: 'Which way to act.' },
        },
        required: ['mode'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} which way is set. */
      execute: async (args) => {
        const said = String(args?.mode ?? '')
        if (!WAYS.has(said)) return 'Pass "human" or "dom".'
        const chat = currentSession()
        if (said === 'human') chatWays.delete(chat)
        else chatWays.set(chat, said)
        return said === 'human'
          ? 'Real mouse and real keys from now on: pages cannot tell it from a person.'
          : "The page's own controls from now on: clicks and typing go through its DOM, so an overlay cannot swallow them."
      },
    },
    {
      name: 'browser_prepare', // ui-copy-ignore
      description: 'Get a game or a heavy app page ready to play, in one call: read what is on it, find the surface that takes input, say whether it needs a Flash player this browser does not have, measure its real frame rate, and test whether keys reach it. Ends with what to do next instead of a blank page and no explanation.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          seconds: { type: 'number', description: 'How long to count frames for. Default 1.2, at most 5.' },
          focus: { type: 'boolean', description: 'Click the surface to put keyboard focus in it. Default true.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 45_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @param {any} exec - tool run. @returns {Promise<{text: string}>} what the page is ready for. */
      execute: async (args, exec) => {
        const who = String(exec?.agent?.id ?? '')
        const page = await sidecar.ensure({ session: who })
        await settle(page, 8000)
        const seconds = Math.min(5, Math.max(0.5, Number(args?.seconds) || 1.2))
        const ms = Math.round(seconds * 1000)
        /* A page that never arrived is not a game that is not ready: say which. */
        const dead = await unreachable(page)
        if (dead !== '') return { text: dead }
        const read = await readPage(page, { mode: 'text', maxChars: 1500 })
        const said = asSpot(await evaluate(page, `(() => {
          const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }
          const shown = (el) => {
            const r = el.getBoundingClientRect()
            const st = getComputedStyle(el)
            return r.width >= 120 && r.height >= 80 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05
          }
          const spot = (el, tag) => {
            const first = box(el)
            const seen = first.y > 0 && first.y < innerHeight && first.x > 0 && first.x < innerWidth
            if (!seen) {
              /* A surface below the fold is not where the person is looking, and
                 a click at its coordinate would land somewhere else. */
              el.scrollIntoView({ block: 'center', inline: 'center' })
              return { tag, src: String(el.getAttribute('src') ?? ''), ...box(el), scrolled: true }
            }
            return { tag, src: String(el.getAttribute('src') ?? ''), ...first }
          }
          const canvases = Array.from(document.querySelectorAll('canvas')).filter(shown).map((el) => spot(el, 'canvas'))
          const frames = Array.from(document.querySelectorAll('iframe')).filter(shown).map((el) => spot(el, 'frame'))
          const movies = document.querySelectorAll('embed, object').length
          return JSON.stringify({ canvases, frames, movies })
        })()`))
        const surface = said?.canvases?.[0] ?? said?.frames?.[0] ?? null
        /* Give a game the click a person gives it: some of them only start
           listening for keys once the surface has been touched. */
        let clicked = ''
        if (args?.focus !== false && surface !== null) {
          await page.mouse('mouseMoved', { x: surface.x - 6, y: surface.y - 4 }).catch(() => {})
          await wait(40)
          await page.mouse('mousePressed', { x: surface.x, y: surface.y, clickCount: 1 }).catch(() => {})
          await wait(30)
          await page.mouse('mouseReleased', { x: surface.x, y: surface.y, clickCount: 1 }).catch(() => {})
          clicked = `clicked the ${surface.tag} at ${surface.x},${surface.y}`
        }
        /* Count the page's own frames and listen for a key, in the page and in
           the biggest frame, because a game is usually not in the page itself. */
        const frames = await page.frameList().catch(() => [])
        const routeOfFrame = (frame) => {
          if (frame === undefined) return null
          const sessionId = frame.contextId === undefined && typeof page.childSession === 'function' ? page.childSession(frame.frameId) : undefined
          if (frame.contextId === undefined && sessionId === undefined) return null
          return { contextId: frame.contextId, sessionId }
        }
        const countFrames = `new Promise((done) => {
          window.__dshKeys = 0
          if (window.__dshKeyUp === undefined) {
            window.__dshKeyUp = true
            addEventListener('keydown', () => { window.__dshKeys += 1 }, true)
          }
          let n = 0
          const t0 = performance.now()
          const tick = () => { n += 1; if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick) }
          requestAnimationFrame(tick)
          setTimeout(() => done(JSON.stringify({ fps: Math.round((n * 1000) / Math.max(1, performance.now() - t0)), keys: window.__dshKeys })), ${ms + 60})
        })`
        const mainRate = asSpot(await evaluate(page, countFrames))
        let frameRate = null
        const childFrames = frames.slice(1).filter((frame) => String(frame.url ?? '') !== 'chrome-error://chromewebdata/')
        const biggest = childFrames[0]
        const route = routeOfFrame(biggest)
        if (route !== null) frameRate = asSpot(await evaluate(page, countFrames, route))
        let keys = route === null ? 'none arrived — there is no frame to test' : 'none arrived in the frame'
        const keyDown = { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16 }
        await page.cdp.send('Input.dispatchKeyEvent', keyDown, route?.sessionId).catch(() => {})
        await page.cdp.send('Input.dispatchKeyEvent', { ...keyDown, key: 'Shift', type: 'keyUp' }, route?.sessionId).catch(() => {})
        await wait(80)
        const after = asSpot(await evaluate(page, 'JSON.stringify({ keys: window.__dshKeys ?? 0 })', route))
        const mainAfter = asSpot(await evaluate(page, 'JSON.stringify({ keys: window.__dshKeys ?? 0 })'))
        const arrived = Number(after?.keys ?? 0) + Number(mainAfter?.keys ?? 0) - Number(frameRate?.keys ?? 0) - Number(mainRate?.keys ?? 0)
        if (arrived > 0) keys = `arrived in the frame (${arrived} keydown event${arrived === 1 ? '' : 's'} from a real key)`
        else if (route !== null) keys = 'not in the frame — click inside it once, or the game only listens after it starts'
        const lines = []
        lines.push(`page: ${read.title === '' ? read.url : read.title} — ${read.controls.length} control(s), ${read.textChars} character(s)`)
        lines.push(surface === null ? 'surface: no canvas or frame takes the screen — the page itself takes input' : `surface: ${surface.tag} ${surface.w}x${surface.h} at ${surface.x},${surface.y}${surface.scrolled === true ? ' (scrolled it into view)' : ''}${clicked === '' ? '' : ` (${clicked})`}`)
        if (read.blind?.flash > 0 && sidecar.flash !== true) lines.push(`flash: ${read.blind.flash} movie(s) — open the same page with flash:true and it runs in this plugin's own player, in the column, with no window on the desktop`) // ui-copy-ignore
        else if (read.blind?.flash > 0) lines.push(`flash: ${read.blind.flash} movie(s) running on this plugin's own player`)
        else lines.push('flash: none found')
        lines.push(`frames: ${Math.max(0, frames.length - 1)} (${childFrames.filter((frame) => String(frame.url ?? '') === 'about:blank').length} of them about:blank)`)
        const rates = []
        if (mainRate !== null) rates.push(`page ${mainRate.fps} fps`)
        if (frameRate !== null) rates.push(`frame ${frameRate.fps} fps`)
        lines.push(`frame rate: ${rates.length === 0 ? 'the page could not count' : rates.join(', ')} over ${ms} ms`)
        lines.push(`keys: ${keys}`)
        lines.push(`mode: human${surface === null ? '' : ' — a game watches the mouse and the keys, and only real ones arrive trusted'}`)
        const trouble = read.blind?.flash > 0 && sidecar.flash !== true
          ? 'call open with flash:true to run it here'
          : read.blind?.flash > 0
            ? 'the movie needs a click inside it before it starts'
          : surface === null && Number(mainRate?.fps ?? 0) === 0
            ? 'nothing on this page is animating — it may be waiting for a click, or the game is behind a login'
            : surface === null
              ? 'ready to read and act on, though there is no canvas or frame to watch'
              : `ready: ${surface.tag} is live at ${mainRate?.fps ?? frameRate?.fps ?? 0} fps`
        lines.push(trouble)
        return { text: lines.join('\n') }
      },
    },
    {
      name: 'browser_find', // ui-copy-ignore
      description: 'Find words on the page without reading it all: returns matching numbered controls (click the ref) and matching text (click x/y), each with whether it is on screen. A phone-sized page has hundreds of lines; this answers "where does it say X" in one compact result.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          query: { type: 'string', description: 'Words to look for; case does not matter.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
          limit: { type: 'integer', description: 'Matches to return. Default 12, at most 40.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the matches. */
      execute: async (args) => withRead(async (page) => {
        const query = String(args?.query ?? '').trim()
        if (query === '') return 'Give the words to look for.'
        const found = await findOnPage(page, query, { regex: args?.regex === true, limit: Number(args?.limit ?? 12) })
        if (found.fault !== undefined) return `the page did not answer when searched — ${String(found.fault).split('\n')[0].slice(0, 200)}`
        const matches = Array.isArray(found.matches) ? found.matches : []
        if (matches.length === 0) return `nothing on this page says ${JSON.stringify(query)} — try other words, or call browser_view for the whole page.`
        const lines = matches.map((one) => `${one.ref === 0 ? `at ${one.x},${one.y}` : one.ref} [${one.tag}] ${one.name}${one.view === true ? '' : ' (off screen)'}`)
        return `${matches.length} match(es) for ${JSON.stringify(query)}:\n${lines.join('\n')}`
      }),
    },
    {
      name: 'browser_read', // ui-copy-ignore
      description: 'Read the page as a person does: one Markdown block of headings, paragraphs, lists and links, no controls and no markup. Far fewer tokens than browser_view on long pages (articles, docs, threads, issue trackers), and it keeps links so a follow-up can be opened by address. Use browser_view when you need numbers to click or type; use browser_read when you only need the words.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          max_chars: { type: 'integer', description: 'Character ceiling. Default 6000; the result says when it was cut.' },
          query: { type: 'string', description: 'What you want to know. With a query, only the passages that answer it come back, ranked — the cheapest way to read a long page. Without one, the whole page comes back.' },
          force: { type: 'boolean', description: 'Read again even if the page has not changed since this chat last read it.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the words, as Markdown. */
      execute: async (args) => withRead(async (page) => {
        const asked = String(args?.query ?? '').trim()
        const ceiling = Number(args?.max_chars ?? (asked === '' ? 6000 : 4000))
        const mark = await pageMark(page)
        const key = mark === '' ? '' : `${mark}|${asked}|${ceiling}`
        const seen = page === null || page === undefined ? undefined : readSeen.get(page)
        /* The text this chat already has is not worth sending twice: a page that
           looks the same answers with where it is, not the same four thousand
           characters. force is for a caller that lost the earlier answer. */
        if (args?.force !== true && key !== '' && seen !== undefined && seen.key === key) {
          return `${mark.split('|')[1] ?? ''} · unchanged since this chat last read it (${String(seen.text.length)} chars) — the text is the one above. Call browser_view with changed_only to see what moved, or pass force for it again.`
        }
        const keep = (text) => {
          if (key !== '' && page !== null && page !== undefined) readSeen.set(page, { key, text })
          return text
        }
        if (asked !== '') {
          const found = await readRelevant(page, asked, { maxChars: ceiling })
          if (found.fault !== undefined) return `the page did not answer when read — ${String(found.fault).split('\n')[0].slice(0, 200)}`
          if (found.text === '') {
            /* The question missed every block: the page is still the answer, so
               hand it over whole rather than make the caller guess again. */
            const whole = await readArticle(page, { maxChars: ceiling })
            if (whole.fault === undefined && whole.text !== '') {
              return keep(`${whole.url}\n# ${whole.title === '' ? '(untitled)' : whole.title}\n\nnothing here answers ${JSON.stringify(asked)} (${String(found.total)} blocks read), so the whole page follows:\n\n${whole.text}${whole.truncated ? `\n\n(cut at ${String(whole.chars)} characters; raise max_chars for more)` : ''}`)
            }
            return `${found.url}\n# ${found.title === '' ? '(untitled)' : found.title}\n\nnothing here answers ${JSON.stringify(asked)} (${String(found.total)} blocks read). Call browser_view for the whole page, or try other words.`
          }
          return keep(`${found.url}\n# ${found.title === '' ? '(untitled)' : found.title}\n\n${found.text}\n\n(${String(found.matched)} of ${String(found.total)} blocks, ranked for ${JSON.stringify(asked)})`)
        }
        const read = await readArticle(page, { maxChars: ceiling })
        if (read.fault !== undefined) return `the page did not answer when read — ${read.fault.split('\n')[0].slice(0, 200)}`
        if (read.text === '') {
          const pdf = await pdfNote(page)
          if (pdf !== '') return `${read.url}\n# ${read.title === '' ? '(untitled)' : read.title}${pdf}`
          return `${read.url}\n# ${read.title === '' ? '(untitled)' : read.title}\n\nnothing to read here: the page draws its content, or it is still loading. Call browser_view to see what is on screen.`
        }
        const head = `${read.url}\n# ${read.title === '' ? '(untitled)' : read.title}`
        const tail = read.truncated ? `\n\n(cut at ${String(read.chars)} characters; raise max_chars for more)` : ''
        return keep(`${head}\n\n${read.text}${tail}`)
      }),
    },
    {
      name: 'browser_view', // ui-copy-ignore
      description: 'Read the sidecar browser: numbered controls and the words on screen. Numbers stay valid across reads and actions until the page navigates. Narrow it with mode (text, links, forms, full, map) and max_chars; ask for changed_only after an action to spend fewer tokens. Use map first on a page too big to read.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mode: { type: 'string', enum: ['text', 'links', 'forms', 'full', 'map'], description: 'What to include. Default text: controls plus the visible words. map: a landmark summary of a big page — how many controls of each kind, the distinct ones with their numbers, and how many words there are, without the words.' },
          max_chars: { type: 'integer', description: 'Character budget for the page text. Default 4600.' },
          changed_only: { type: 'boolean', description: 'Only what changed since the last read.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the read. */
      execute: async (args) => withRead(async (page) => {
        const options = { mode: String(args?.mode ?? 'text'), maxChars: Number(args?.max_chars ?? 4600) }
        /* Each chat keeps its own read state: a shared one let another chat's
           read replace this chat's baseline, so its numbers and its "what
           changed" answered about a page it never saw. */
        const state = refsFor()
        const read = await remember(page, state, options)
        const note = isCheckPage(read) ? `\n${CHECK_NOTE}` : ''
        if (args?.changed_only === true && state.last !== undefined) {
          /* The diff becomes the new baseline: a page that moved zero -> one
             should not report that move again on the next read. */
          const text = diffRead(state.last, read, options) + note
          state.last = read
          state.lastShape = JSON.stringify(options)
          return text
        }
        /* The read before this one answers two questions: what is new on this
           one, and whether the page moved at all. Keep it before either answer
           is overwritten. */
        const before = state.last
        state.last = read
        const fresh = freshRefs(before, read)
        const freshLine = fresh.length === 0 || fresh.length > 12 ? '' : `\nnew since the read before: ${fresh.map(String).join(', ')}`
        /* Same page, same shape, same words: the numbers above still work, and
           repeating the page would only spend tokens. */
        if (sameRead(before, read) && state.lastShape === JSON.stringify(options)) {
          const moved = Number(before.scroll?.y ?? 0) !== Number(read.scroll?.y ?? 0) ? `, scrolled to ${Math.round(Number(read.scroll?.y ?? 0))}` : ''
          /* The address was said with the read above; "here" is the whole of it. */
          const where = saidUrls.get(page) === String(read.url ?? '') ? 'here' : read.url
          saidUrls.set(page, String(read.url ?? ''))
          return `still ${where}${moved} — nothing changed since the last read; the numbers above still work${note}`
        }
        state.lastShape = JSON.stringify(options)
        const said = withoutSeenAddress(page, read.url, renderPage(read, options))
        saidUrls.set(page, String(read.url ?? ''))
        return said + freshLine + note + (await pdfNote(page))
      }),
    },
    {
      name: 'browser_click', // ui-copy-ignore
      description: 'Click a numbered control, a point, or the first control whose words contain `text` — the last needs no read first. The click is real mouse input and the mirror shows where it landed.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from browser_view.' },
          text: { type: 'string', description: 'Words on the control, when its number is not known.' },
          x: { type: 'integer', description: 'Viewport x, when clicking a point.' },
          y: { type: 'integer', description: 'Viewport y, when clicking a point.' },
          double: { type: 'boolean', description: 'Double-click.' },
          right: { type: 'boolean', description: 'Right-click, opening a context menu.' },
          hold_ms: { type: 'integer', description: 'Keep the button down this long before releasing: a press-and-hold a game or a drag handle needs.' },
          mode: { type: 'string', enum: ['human', 'dom'], description: '"human" moves the real mouse and is what a page cannot tell from a person; "dom" fires the page\'s own click on the numbered control, which reaches one an overlay covers. Omit to use what this chat set with browser_mode.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        let point = { x: Number(args?.x ?? NaN), y: Number(args?.y ?? NaN) }
        let label = args?.ref === undefined ? `${point.x},${point.y}` : String(args.ref)
        let followed = ''
        if (args?.ref !== undefined) {
          const spot = await findAgain(page, Number(args.ref))
          if (spot.gone === true) return spot.why ?? REF_GONE
          if (spot.followed === true) followed = `the page redrew, so "${String(spot.was).slice(0, 50)}" has a new number — used where it is now`
          point = { x: Number(spot.x), y: Number(spot.y) }
        } else if (String(args?.text ?? '') !== '') {
          const hit = await findWords(page, String(args.text), refsFor().refs)
          if (hit === null) return `No control says ${JSON.stringify(String(args.text))}. Call browser_view to see what is there.`
          point = { x: hit.x, y: hit.y }
          label = `"${hit.name.slice(0, 60)}"`
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'Give a ref from browser_view, or both x and y.'
        if (wayOf(args) === 'dom') {
          if (args?.ref === undefined) return 'Acting on the page itself needs a number from browser_view: pass ref, or leave mode out to click like a person.'
          const pressedAt = Date.now()
          const said = await evaluate(page, clickInDom(Number(args.ref), { double: args?.double === true, right: args?.right === true })).catch(() => undefined)
          const hit = asSpot(said)
          if (hit?.ok !== true) return REF_GONE
          await settle(page, 5000, pressedAt)
          const called = await acted(page, args, () => look(page, { mode: 'text', maxChars: 3000 }), `click ${label} on the page itself`)
          return called + (followed === '' ? '' : ` (${followed})`)
        }
        const button = args?.right === true ? 'right' : 'left'
        let cover = ''
        if (args?.ref !== undefined && button === 'left') {
          const gate = await clearCover(page, Number(args.ref))
          cover = gate.note
          /* An overlay that would not go away leaves the control underneath:
             the click would land on the overlay, so it is not sent. */
          if (gate.cleared !== true) {
            return `${cover.trim()}\nNot clicked: the control is still covered. Call browser_view and handle the overlay first.`
          }
          if (gate.cleared && cover !== '') {
            const again = await locate(page, Number(args.ref))
            if (again.gone !== true) point = { x: Number(again.x), y: Number(again.y) }
          }
        }
        const before = args?.read === true ? '' : await pageMark(page)
        const pressedAt = Date.now()
        await page.mouse('mouseMoved', point)
        await page.mouse('mousePressed', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        const hold = Math.max(0, Math.min(60_000, Number(args?.hold_ms ?? 0)))
        if (hold > 0) await new Promise((settle) => setTimeout(settle, hold))
        await page.mouse('mouseReleased', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        await settle(page, 5000, pressedAt)
        const said = await acted(page, args, () => look(page, { mode: 'text', maxChars: 3000 }), `click ${label}`)
        return said + cover + (followed === '' ? '' : ` (${followed})`) + (await outcome(page, before))
      }),
    },
    {
      name: 'browser_type', // ui-copy-ignore
      description: 'Type text into the sidecar browser — Chinese included — optionally pressing Enter. Pass a ref to focus that control first. With clear, the field is emptied first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          ref: { type: 'integer', description: 'Control to click before typing.' },
          field: { type: 'string', description: 'The field is called this on screen, when you have no number for it.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          clear: { type: 'boolean', description: 'Select all and delete before typing.' },
          mode: { type: 'string', enum: ['human', 'dom'], description: '"human" presses real keys and is what a page cannot tell from a person; "dom" sets the field and fires its input events, which leaves key handlers untouched. Omit to use what this chat set with browser_mode.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['text'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        let cover = ''
        let followed = ''
        if (wayOf(args) === 'dom') {
          let target = Number.isInteger(args?.ref) ? Number(args.ref) : undefined
          if (target === undefined && args?.field !== undefined) {
            const found = await fieldByName(page, String(args.field), refsFor().refs)
            if (found === null) return `${String(args.field)}: ${REF_GONE}`
            if (!Number.isInteger(found.ref)) return `${String(args.field)}: read the page and pass its number, since a field found by its label has none.`
            target = Number(found.ref)
            cover = found.lead
          }
          if (target === undefined) return 'Acting on the page itself needs a number from browser_view: pass ref, or leave mode out to type like a person.'
          const said = await evaluate(page, writeInDom(target, String(args?.text ?? ''), { clear: args?.clear === true, submit: args?.submit === true })).catch(() => undefined)
          const wrote = asSpot(said)
          if (wrote?.ok !== true) return REF_GONE
          await settle(page)
          const called = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type on the page itself')
          return `${called} (field now "${String(wrote.value).slice(0, 40)}")` + cover
        }
        if (args?.field !== undefined && args?.ref === undefined) {
          const target = await fieldByName(page, String(args.field), refsFor().refs)
          if (target === null) return `${String(args.field)}: ${REF_GONE}`
          cover = target.lead
          const dated = await writeAt(page, { x: target.x, y: target.y }, String(args?.text ?? ''), { clear: args?.clear, submit: args?.submit === true, hint: target.name })
          if (dated !== '') return dated + cover
          await settle(page)
          const called = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type')
          return called + cover + ` (typed into "${target.name.slice(0, 50)}")` // ui-copy-ignore
        }
        if (args?.ref !== undefined) {
          const gate = await clearCover(page, Number(args.ref))
          cover = gate.note
          if (gate.cleared !== true) {
            return `${cover.trim()}\nNot typed into: the field is still covered. Call browser_view and handle the overlay first.`
          }
          const spot = await findAgain(page, Number(args.ref))
          if (spot.gone === true) return spot.why ?? REF_GONE + cover
          if (spot.followed === true) followed = `the page redrew, so "${String(spot.was).slice(0, 50)}" has a new number — typed where it is now`
          const point = { x: Number(spot.x), y: Number(spot.y) }
          await page.mouse('mouseMoved', point)
          await page.mouse('mousePressed', { ...point, clickCount: 1 })
          await page.mouse('mouseReleased', { ...point, clickCount: 1 })
          await wait(80)
        }
        if (args?.clear === true) await clearFocus(page)
        if (await dateLikeFocus(page) !== '') return (await fillDateLike(page, String(args?.text ?? ''))) + cover
        const words = String(args?.text ?? '')
        const before = args?.read === true ? '' : await pageMark(page)
        await typeInto(page, words, String(args?.field ?? ''))
        const dated = await fillDateLike(page, words)
        if (dated !== '') return dated + cover
        if (args?.submit === true) await pressKey(page, 'Enter')
        await settle(page)
        const said = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type')
        return said + cover + (followed === '' ? '' : ` (${followed})`) + (await outcome(page, before)) // ui-copy-ignore
      }),
    },
    {
      name: 'browser_ask', // ui-copy-ignore
      description: 'Say something to a chat that is open in the page — a model, a support window, a search box — and read its answer back in the same call. Types into the box, presses Enter, then waits until the answer stops growing. Use it to get a review or a picture prompt answered without a read between every step.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'What to say.' },
          ref: { type: 'integer', description: 'The box to type in, from browser_view. Omit to use the page\u2019s own chat box.' },
          submit: { type: 'boolean', description: 'Press Enter to send. Default true.' },
          timeout_ms: { type: 'integer', description: 'How long to wait for the answer. Default 60000.' },
        },
        required: ['text'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the answer. */
      execute: async (args) => withPage((page) => askInPage(page, args)),
    },
    {
      name: 'browser_review', // ui-copy-ignore
      description: 'Ask the chat in the page to review a repository and take its review back as a list: builds the message, sends it, waits for the answer, and writes the round down so the next round knows what was already said. Use it for a review round, not for a one-off question (that is browser_ask).',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          repo: { type: 'string', description: 'Address of the repository to review.' },
          commit: { type: 'string', description: 'The commit the review is about. Omit for the newest one.' },
          focus: { type: 'string', description: 'One thing to look at especially.' },
          diff: { type: 'string', description: 'The change to review, as a diff. Include it when the reviewer cannot open the repository itself.' },
          ref: { type: 'integer', description: 'The box to type in, from browser_view. Omit to use the page\u2019s own chat box.' },
          timeout_ms: { type: 'integer', description: 'How long to wait for the review. Default 120000.' },
        },
        required: ['repo'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 240_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the review. */
      execute: async (args) => withPage(async (page) => {
        const repo = String(args?.repo ?? '').trim()
        if (repo === '') return 'Which repository should the reviewer look at?'
        const commit = String(args?.commit ?? '').trim()
        /* What was settled last time travels with the question. */
        const before = lastRound()
        const already = Array.isArray(before?.marks) ? before.marks : []
        const asked = askBrief({ repo, commit, focus: String(args?.focus ?? ''), diff: String(args?.diff ?? ''), already })
        const started = Date.now()
        const told = await askInPage(page, { text: asked, ref: args?.ref, timeout_ms: args?.timeout_ms ?? 120_000 })
        const tookMs = Date.now() - started
        if (!String(told).startsWith('the answer came back in')) return told
        const answer = String(told).split('\n').slice(1).join('\n').trim()
        const { round } = recordRound({ commit, question: asked, answer, tookMs })
        /* A wall answers too, and its words are not advice: name it rather than
           call the login screen prose. */
        const wall = /(sign in|log in|登录|注册|verif|checking your browser)/i.test(answer)
        /* The question sitting there unanswered is not prose: say that instead. */
        const busy = asked.slice(0, 24)
        const waiting = round.points.length === 0 && busy.length >= 8 && answer.includes(busy)
        const list = round.points.length > 0
          ? round.points.map((point, at) => `${at + 1}. ${point}`).join('\n')
          : waiting
            ? `the page has the message but has not answered yet; it shows: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`
            : wall
            ? `the page is asking to sign in first, so there is no review yet: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`
            : `It answered in prose; no list to work from. It said: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`
        const settled = already.filter((mark) => mark.status !== 'open').length
        const carried = settled === 0 ? '' : `\n(${settled} earlier point${settled === 1 ? '' : 's'} left out as already handled)`
        return `review round: ${commit === '' ? 'newest commit' : commit.slice(0, 12)} in ${Math.round(tookMs / 100) / 10}s\n${list}${carried}`
      }),
    },
    {
      name: 'browser_review_verdict', // ui-copy-ignore
      description: 'Record what happened to each point of the last review round, so the next round leaves settled points out: point numbers are the ones browser_review printed, and each mark is fixed, verified (checked in the code and the point does not apply), invalid, or open.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mark: { // ui-copy-ignore
            type: 'array',
            description: 'One entry per point: which point, its status, and the evidence that backs it.',
            items: { // ui-copy-ignore
              type: 'object', // ui-copy-ignore
              properties: { // ui-copy-ignore
                point: { type: 'integer', description: 'The point number browser_review printed, starting at 1.' },
                status: { type: 'string', enum: MARK_STATUS, description: 'fixed, verified, invalid, or open.' },
                evidence: { type: 'string', description: 'Where the code shows it: file, test, or commit.' },
              },
              required: ['point', 'status'], // ui-copy-ignore
              additionalProperties: false,
            },
          },
        },
        required: ['mark'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what was recorded. */
      execute: async (args) => {
        const written = markRound({ marks: Array.isArray(args?.mark) ? args.mark : [] })
        if (written === null) return 'No review round to mark: play one with browser_review first.'
        const counts = new Map()
        for (const mark of written.marks) counts.set(mark.status, (counts.get(mark.status) ?? 0) + 1)
        const said = [...counts].map(([status, n]) => `${n} ${status}`).join(', ')
        return `review round ${String(written.round.commit || 'newest').slice(0, 12)}: recorded ${written.marks.length} of ${written.round.points.length} points (${said}).`
      },
    },
    {
      name: 'browser_key', // ui-copy-ignore
      description: 'Press one key in the background browser: Enter, Tab, Escape, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, Space, F1-F12, the numeric keypad (Numpad0-Numpad9, NumpadEnter, NumpadAdd, ...), printable characters and every symbol on a US keyboard (including shifted ones such as ? : @), plus the keys with a name (ContextMenu, CapsLock, PrintScreen, media keys). Join keys with + to hold them together (ArrowLeft+ArrowUp, Shift+Tab), and hold_ms to keep them down. Modifiers accept Ctrl, Alt, Shift, Meta/Cmd, or Mod for the platform command key; Ctrl+C/X/V/A/Z/Y run the real copy, cut, paste, select-all, undo and redo.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          key: { type: 'string', description: 'Key name, or several joined by + to hold them together (ArrowLeft+ArrowUp, Shift+ArrowLeft). Letters, digits, punctuation and shifted symbols work too.' },
          modifiers: { type: 'string', description: 'Held while pressing: Ctrl, Alt, Shift, Meta/Cmd, or Mod (Command on macOS, Control on Windows and Linux), joined by +.' },
          hold_ms: { type: 'integer', description: 'Keep the key down this long before releasing. Games move while a key is held.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['key'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const name = String(args?.key ?? 'Enter')
        const chord = splitChord(name, modifierBits(args?.modifiers))
        const mods = chord.modifiers
        const hold = Math.max(0, Math.min(60_000, Number(args?.hold_ms ?? 0)))
        if (chord.names.length === 0) throw new Error(`sidecar: ${name} holds no key, only modifiers`) // ui-copy-ignore
        /* One key goes through the plain path so an editing shortcut is sent as
           the browser command it is; a chord holds every key down together. */
        if (chord.names.length > 1) await pressChord(page, chord.names, mods, hold)
        else await pressKey(page, chord.names[0], mods, hold)
        /* A held key is game input: waiting for the page to fall quiet after one
           costs more than the frame it was meant to drive. */
        if (hold === 0) await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `key ${name}`)
      }),
    },
    {
      name: 'browser_scroll', // ui-copy-ignore
      description: 'Scroll the sidecar browser by wheel at its centre (negative goes up), then return what it shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          dy: { type: 'integer', description: 'Wheel delta: 600 is about a screen down.' },
          x: { type: 'integer', description: 'Viewport x for the wheel.' },
          y: { type: 'integer', description: 'Viewport y for the wheel.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        await page.wheel({ x: Number(args?.x ?? VIEW.width / 2), y: Number(args?.y ?? VIEW.height / 2), dy: Number(args?.dy ?? 600) })
        /* A wheel is a request, not a result: a list that loads more rows on
           scroll has not answered yet when the wheel returns. Give the scroll
           handler its turn, then let the page fall quiet. */
        await wait(200)
        const delta = Number(args?.dy ?? 600)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 4000 }), `scroll ${delta > 0 ? '+' : ''}${delta}`)
      }),
    },
    {
      name: 'browser_hover', // ui-copy-ignore
      description: 'Move the pointer onto a numbered control, so hover-only menus and tooltips open, then return what the page shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from browser_view.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['ref'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const spot = await findAgain(page, Number(args?.ref))
        if (spot.gone === true) return spot.why ?? REF_GONE
        const cursor = await page.hover({ x: Number(spot.x), y: Number(spot.y) })
        await wait(400)
        const said = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2500 }), `hover ${String(args?.ref)} · ${cursor}`)
        return said + (spot.followed === true ? ` (the page redrew, so "${String(spot.was).slice(0, 50)}" has a new number — hovered where it is now)` : '')
      }),
    },
    {
      name: 'browser_nav', // ui-copy-ignore
      description: 'Change the sidecar browser\'s address: open a url, go back, go forward, or reload. Use this instead of clicking the browser chrome.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open.' },
          back: { type: 'boolean', description: 'Go back one history entry.' },
          forward: { type: 'boolean', description: 'Go forward one entry.' },
          reload: { type: 'boolean', description: 'Reload the current page.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withRawPage(async (page) => {
        if (typeof args?.url === 'string' && args.url !== '') await page.navigate(args.url)
        else if (args?.back === true) await page.history(-1)
        else if (args?.forward === true) await page.history(1)
        else if (args?.reload === true) await page.reload()
        else return 'Give a url, or ask to go back, forward or reload.'
        await settle(page, 8000)
        const dead = await unreachable(page)
        if (dead !== '') return dead
        return acted(page, args, () => look(page, { mode: 'text' }), 'navigate') // ui-copy-ignore
      }),
    },
    {
      name: 'browser_do', // ui-copy-ignore
      description: 'Run several steps in one call and report one compact result: the whole of "click search, type a query, press Enter, wait for results" is one call instead of five. Steps run in order and stop at the first that cannot proceed. Each step: {ref, tap | text, submit}, {tap: "x,y"}, {tap: "Sign in"}, {field: "Email", text}, {text}, {key}, {scroll}, {wait_text}, {wait_gone}, {wait_url}, {wait_idle}, {eval}, {open}, {sleep_ms}. Waits know when the page has settled. A step that names a control clears a cookie banner in its way first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          steps: { // ui-copy-ignore
            type: 'array', // ui-copy-ignore
            description: 'Steps, in order.',
            items: { // ui-copy-ignore
              type: 'object', // ui-copy-ignore
              properties: {
                ref: { type: 'integer', description: 'Control number for tap or text.' },
                tap: { type: 'string', description: 'Click: a ref number, "x,y", or the words on the control.' },
                text: { type: 'string', description: 'Type this text (into ref, into field, or wherever focus is).' },
                field: { type: 'string', description: 'Words on the field to fill before typing.' },
                submit: { type: 'boolean', description: 'Press Enter after typing.' },
                clear: { type: 'boolean', description: 'Empty the field before typing.' },
                key: { type: 'string', description: 'Key name.' },
                scroll: { type: 'integer', description: 'Wheel delta.' },
                wait_text: { type: 'string', description: 'Wait for this text to appear.' },
                wait_gone: { type: 'string', description: 'Wait for this text to disappear.' },
                wait_url: { type: 'string', description: 'Wait for the address to contain this.' },
                wait_idle: { type: 'boolean', description: 'Wait for the page to settle.' },
                eval: { type: 'string', description: 'Run JavaScript in the page.' },
                open: { type: 'string', description: 'Open an address.' },
                sleep_ms: { type: 'integer', description: 'Wait a fixed time.' },
                timeout: { type: 'integer', description: 'Ceiling for this step\'s wait, in milliseconds.' },
              },
              additionalProperties: false,
            },
          },
          read: { type: 'string', enum: ['none', 'text', 'links', 'forms', 'changed'], description: 'What to read at the end. Default text.' },
          max_chars: { type: 'integer', description: 'Character budget for that final read.' },
        },
        required: ['steps'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what happened and the page after. */
      execute: async (args) => withPage(async (page) => {
        const steps = Array.isArray(args?.steps) ? args.steps : []
        if (steps.length === 0) return 'Give at least one step.'
        const report = []
        for (const [index, step] of steps.entries()) {
          const stepAt = Date.now()
          const said = await runStep(page, step ?? {}, refsFor().refs)
          const text = typeof said === 'string' ? said : said.text
          report.push(`${index + 1}. ${text}`)
          /* A step that never landed makes every later step a guess, so the
             batch ends here instead of typing into a page that is not there. */
          if (typeof said !== 'string' && said.blocked === true) {
            return `${report.join('\n')}\nStopped after step ${index + 1}. Call browser_view and plan again from what the page shows now.`
          }
          /* A step can navigate straight onto Chrome's error page — a mistyped
             address, or a site that does not answer. The rest of the batch
             would then type into "This site can't be reached", so it stops
             here and says what really happened. */
          if (isErrorPage(page)) return `${report.join('\n')}\nStopped after step ${index + 1}: ${await unreachable(page)}`
          if (step?.sleep_ms === undefined && step?.wait_text === undefined && step?.wait_gone === undefined && step?.wait_url === undefined && step?.wait_idle === undefined) {
            await settle(page, Number(step?.timeout ?? 5000), stepAt)
          }
        }
        const mode = String(args?.read ?? 'text')
        if (mode === 'none') return report.join('\n')
        const options = { mode: mode === 'changed' ? 'text' : mode, maxChars: Number(args?.max_chars ?? 3000) }
        const state = refsFor()
        const read = await remember(page, state, options)
        if (mode === 'changed' && state.last !== undefined) {
          const diff = diffRead(state.last, read, options)
          state.last = read
          return `${report.join('\n')}\n${diff}`
        }
        state.last = read
        return `${report.join('\n')}\n\n${renderPage(read, options)}`
      }),
    },
    {
      name: 'browser_extract', // ui-copy-ignore
      description: 'Read the items a selector matches as one compact line each — lists, search results, tables, menus — instead of the whole page. Each row keeps its link when it has one. Use it when a page has more rows than the read budget allows; it costs a fraction of a full read.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          select: { type: 'string', description: 'CSS selector for the items, for example "ul.results > li".' },
          ref: { type: 'integer', description: 'Only look inside this control, as numbered by the last browser_view.' },
          limit: { type: 'integer', description: 'Most rows to return. Default 40, at most 200.' },
        },
        required: ['select'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the rows. */
      execute: async (args) => withRead((page) => extractRows(page, args)),
    },
    {
      name: 'browser_eval', // ui-copy-ignore
      description: 'Run JavaScript in the sidecar page and return its value. For what the numbered controls cannot express: reading a table, setting storage, filling a widget. The page must be opened first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          code: { type: 'string', description: 'Expression or statements. A returned value is handed back, trimmed.' },
          await: { type: 'boolean', description: 'Await the result if it is a promise.' },
        },
        required: ['code'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the value. */
      execute: async (args) => withRead(async (page) => {
        const code = String(args?.code ?? '')
        if (code === '') return 'Give code to run.'
        const wrapped = args?.await === true ? `(async () => { ${code} })()` : code
        const { result, exceptionDetails } = await page.cdp.send('Runtime.evaluate', {
          expression: wrapped,
          returnByValue: true,
          awaitPromise: args?.await === true,
          userGesture: true,
        })
        if (exceptionDetails !== undefined) return String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed').slice(0, 2000)
        const value = result?.value
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        if (text === undefined) return 'undefined'
        return text.length > 4000 ? `${text.slice(0, 4000)}\n… ${text.length - 4000} more characters` : text
      }),
    },
    {
      name: 'browser_select', // ui-copy-ignore
      description: 'Choose an option in a dropdown, by visible label or value, then return the page.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the select control from browser_view.' },
          field: { type: 'string', description: 'The dropdown is called this on screen, when you have no number for it.' },
          value: { type: 'string', description: 'Option label or value to choose.' },
        },
        required: ['value'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        let use = args
        /* One dropdown on the page needs no naming: the value alone says which
           one, and asking costs the caller a whole read. */
        if (use?.ref === undefined && use?.field === undefined) {
          const read = await readPage(page, { mode: 'text', maxChars: 1200, max: 200 })
          const drops = read.controls.filter((control) => control.view !== false && ['select', 'combobox', 'listbox'].includes(String(control.kind)))
          if (drops.length === 1) use = { ...use, ref: Number(drops[0].ref) }
          else if (drops.length > 1) return `which dropdown: ${drops.slice(0, 5).map((one) => `${String(one.name).slice(0, 30)} (${String(one.ref)})`).join(' · ')}`
          else return 'the page has no dropdown to choose in.' // ui-copy-ignore
        }
        if (use?.ref === undefined) {
          const field = String(use.field)
          const chosen = await evaluate(page, selectSpot(field, String(use?.value ?? '')))
          const said = typeof chosen === 'string' ? chosen : chosen?.error === undefined ? '' : String(chosen.error)
          if (said === '' || said.startsWith('no dropdown')) return said === '' ? 'the page did not answer; read it and try again.' : said // ui-copy-ignore
          await settle(page, 3000)
          if (use?.read === true) return `${said}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
          return `${said} · ${await brief(page)}`
        }
        const spot = await findAgain(page, Number(use?.ref))
        if (spot.gone === true) return spot.why ?? REF_GONE
        const wanted = JSON.stringify(String(use?.value ?? ''))
        const route = await contextFor(page, Number(use?.ref))
        const local = route?.local ?? Number(use?.ref)
        const said = await evaluate(page, `(() => {
  const reg = window.__dshRead
  const hit = reg && reg.find(${local})
  if (!hit || hit.el.tagName !== 'SELECT') return 'that control is not a dropdown'
  const select = hit.el
  const wanted = ${wanted}
  const option = Array.from(select.options).find((item) => item.value === wanted || item.text.trim() === wanted || item.text.trim().toLowerCase() === wanted.toLowerCase())
  if (!option) return 'no option ' + wanted + '; options are ' + Array.from(select.options).slice(0, 12).map((item) => item.text.trim()).join(' | ')
  select.value = option.value
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return 'chose ' + option.text.trim()
})()`, route)
        await settle(page, 3000)
        if (use?.read === true) return `${String(said)}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
        return `${String(said)} · ${await brief(page)}`
      }),
    },
    {
      name: 'browser_upload', // ui-copy-ignore
      description: 'Put files into a file input on the page, by absolute path, then return the page. The file chooser never opens.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the file input from browser_view.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths on this machine.' },
        },
        required: ['ref', 'files'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const ref = Number(args?.ref)
        const files = Array.isArray(args?.files) ? args.files.map(String) : []
        if (files.length === 0) return 'Give at least one absolute path.'
        const route = await contextFor(page, ref)
        const uploadParams = { expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${route?.local ?? ref}); return hit ? hit.el : null })()` }
        if (route?.contextId !== undefined) uploadParams.contextId = route.contextId
        const handle = await page.cdp.send('Runtime.evaluate', uploadParams, route?.sessionId)
        const objectId = handle.result?.objectId
        if (objectId === undefined) return spot.why ?? REF_GONE
        const node = await page.cdp.send('DOM.describeNode', { objectId }, route?.sessionId)
        const backendNodeId = node?.node?.backendNodeId
        if (backendNodeId === undefined) return 'That control cannot take a file.'
        await page.cdp.send('DOM.setFileInputFiles', { files, backendNodeId }, route?.sessionId)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `upload ${String(files.length)} file`) // ui-copy-ignore
      }),
    },
    {
      name: 'browser_shot', // ui-copy-ignore
      description: 'Save a PNG of the sidecar browser into the session folder and return its absolute path; when the current model accepts images the picture comes back in the same call, so a captcha, a chart or a broken layout can be looked at instead of guessed. Default is the visible screen; full takes the whole page, ref takes one control, region takes one box of it.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          name: { type: 'string', description: 'File name without extension.' },
          full: { type: 'boolean', description: 'The whole page, not just the screen.' },
          ref: { type: 'integer', description: 'One control from browser_view.' },
          region: { type: 'array', items: { type: 'number' }, description: 'One box instead of the whole screen: [x, y, width, height] in page pixels, the same numbers browser_prepare and browser_find report.' },
          scale: { type: 'integer', description: 'Pixel ratio. Default 1; 2 is sharper and heavier.' },
        },
        additionalProperties: false,
      },
      output: SHOT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /**
       * A picture nobody can look at is only a file path: when the route declares
       * image input, the same call carries the PNG as an attachment so the next
       * step can be planned from what is actually on screen instead of guessing.
       * @param {any} args - arguments.
       * @param {any} [exec] - call context, for the route and its attachments.
       * @returns {Promise<any>} the saved path, and the picture when available.
       */
      execute: async (args, exec) => {
        /** @type {{data: string, file: string}|undefined} */
        let taken
        const said = await withRead(async (page) => {
        const scale = Math.max(1, Math.min(3, Number(args?.scale ?? 1)))
        let clip = undefined
        /* A game or a chart does not need the whole screen: one box costs a
           fraction of the picture, and a picture is billed by area. */
        if (args?.ref === undefined && Array.isArray(args?.region) && args.region.length === 4) {
          const box = args.region.map((part) => Number(part))
          clip = {
            x: Math.max(0, Math.round(Number.isFinite(box[0]) ? box[0] : 0)),
            y: Math.max(0, Math.round(Number.isFinite(box[1]) ? box[1] : 0)),
            width: Math.max(8, Math.min(4000, Math.round(Number.isFinite(box[2]) ? box[2] : 0) || 8)),
            height: Math.max(8, Math.min(4000, Math.round(Number.isFinite(box[3]) ? box[3] : 0) || 8)),
          }
        }
        if (args?.ref !== undefined) {
          const spot = await findAgain(page, Number(args.ref))
          if (spot.gone === true) return spot.why ?? REF_GONE
          /* The picture is of the control, not of a guess around its middle:
             a canvas can be most of the page, a checkbox a few pixels. */
          const box = await evaluate(page, bounds(Number(args.ref)))
          const rect = typeof box === 'string' ? JSON.parse(box) : box
          if (rect?.gone === true) return spot.why ?? REF_GONE
          const pad = 8
          clip = {
            x: Math.max(0, Math.round(Number(rect.x) - pad)),
            y: Math.max(0, Math.round(Number(rect.y) - pad)),
            width: Math.max(8, Math.round(Number(rect.width) + pad * 2)),
            height: Math.max(8, Math.round(Number(rect.height) + pad * 2)),
          }
        }
        const data = await page.shot({ full: args?.full === true, rect: clip, scale })
        const file = await saveArtifact('shots', data, { name: args?.name, prefix: 'shot' })
        taken = { data, file }
        return file
        })
        if (taken === undefined) return said
        let image
        try {
          image = await host.showShot?.(taken.data, taken.file.split('/').pop() ?? 'shot.png', exec) // ui-copy-ignore
        } catch {
          image = undefined
        }
        /* The route may not carry pictures at all: then the file path is all
           this call can give, and saying so is better than a silent path the
           next step assumes was looked at. */
        if (image === undefined) return { text: `${said.text}\nno picture reached this result — browser_view reads the words here, browser_grab returns a picture as a file` }
        return { text: said.text, image }
      },
    },
    {
      name: 'browser_grab', // ui-copy-ignore
      description: 'Save the picture on the page as a file: an image, a chart, a drawing surface. Picks the largest one, or the one inside a given control.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Only the picture at or inside this control.' },
          name: { type: 'string', description: 'File name without extension.' },
          count: { type: 'integer', description: 'How many, largest first. Default 1, at most 4.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<string>} the saved paths, one per line. */
      execute: async (args) => withRead(async (page) => {
        const said = await evaluate(page, pictures(args?.ref, args?.count))
        let found
        try {
          found = JSON.parse(typeof said === 'string' ? said : JSON.stringify(said))
        } catch {
          found = { pictures: [] }
        }
        const rows = []
        const base = String(args?.name ?? '').replace(/[^\w.-]/g, '')
        const list = Array.isArray(found?.pictures) ? found.pictures : []
        for (let index = 0; index < list.length; index += 1) {
          const item = list[index]
          const body = String(item?.data ?? '')
          const mark = body.indexOf(',')
          if (mark < 0) continue
          const type = String(item?.type ?? 'image/png')
          const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('svg') ? 'svg' : 'png'
          const file = await saveArtifact('pictures', body.slice(mark + 1), {
            name: base === '' ? '' : `${base}${list.length > 1 ? `-${index + 1}` : ''}`,
            ext: `.${ext}`,
            prefix: 'picture',
          })
          const size = `${Math.round(Number(item.width) || 0)}x${Math.round(Number(item.height) || 0)}`
          /* Say what the picture looks like in words: a model that cannot open
             a file still needs to know a chart came back blank. */
          const flat = Number(item.flat) || 0
          const colors = Number(item.colors) || 0
          const look = flat >= 0.9 ? 'mostly one colour' : colors <= 3 ? 'a few colours' : 'a picture with detail'
          rows.push(`${file} ${size} ${look}`)
        }
        if (rows.length === 0) {
          return list.length === 0 ? 'There is no picture on the page.' : 'That picture could not be saved.'
        }
        return rows.join('\n')
      }),
    },
    {
      name: 'browser_state', // ui-copy-ignore
      description: 'Report the sidecar browser: whether it runs, its profile, address, title, how many people are watching its mirror, and how many times a call had to find a control again after the page redrew it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} the state. */
      execute: async () => {
        const state = await sidecar.state()
        const owner = String(host.owner?.() ?? '') // ui-copy-ignore
        const session = currentSession()
        const seats = String(host.seats?.() ?? '?') // ui-copy-ignore
        const mine = sidecar.pageFor(session)
        const rows = [
          state.alive ? 'running' : 'stopped',
          `chat ${session === '' ? '(no chat id)' : session}`,
          `this chat's tab ${mine === null ? 'none' : String(mine.url)}`, // ui-copy-ignore
          `tabs in the browser ${String(sidecar.pages.size)}`,
          `tab list ${[...sidecar.pages.entries()].map(([key, each]) => `${key.slice(-8)}=${String(each.url)}=${each.cdp?.closed === true ? 'closed' : 'open'}`).join(' | ')}`, // ui-copy-ignore
          `default tab ${String(sidecar.page?.url)}`, // ui-copy-ignore
          state.headless === false ? 'showing a window' : 'no window',
          sidecar.flash ? 'Flash-era runtime' : 'Chrome runtime',
          `profile ${String(state.profile)}`,
          `url ${String(state.url)}`,
          `title ${String(state.title)}`,
          `viewers ${String(state.viewers)}`,
          `listening chats ${seats}`, // ui-copy-ignore
          `mirror owner ${owner === '' ? 'none' : owner}`, // ui-copy-ignore
          owner === '' ? 'no owner' : `owner ${owner}`,
          `refs followed ${String(follows.count)}`,
          /* What it costs and when it would let go: the two facts that decide
             whether to keep using it or let it rest. */
          state.alive === true ? `memory ${Math.max(1, Math.round(Number(state.memory ?? 0) / 1048576))} MB` : 'memory 0 MB',
          state.closesIn > 0 ? `closes in ${Math.max(1, Math.round(Number(state.closesIn) / 60_000))} min unless used` : 'no close scheduled',
          holdText(sidecar) === '' ? 'person free' : `person using it (${String(Math.ceil(Number(sidecar.holding()) / 1000))} s left)`,
        ]
        if (state.alive === true && viewerNote(state.viewers) !== '') rows.push(NO_VIEWER)
        return { text: rows.join('\n') }
      },
    },

    {
      name: 'browser_login', // ui-copy-ignore
      description: 'Sign-ins belong to the browser, not to a chat: every chat uses them and they survive a restart. "save" keeps the sign-in showing right now under a name, "list" shows what is kept, "use" signs the browser back in as that account and reopens the page, "drop" forgets it. What is written is sealed, and the key is the one in the system keystore. One site can hold several accounts: save them under different names and switch with "use".',
      parameters: { // ui-copy-ignore
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'save', 'use', 'drop'], description: 'list, save, use or drop.' },
          name: { type: 'string', description: 'Account name, for example "work" or "personal". Needed by save, use and drop.' },
        },
        required: ['action'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 25_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - action and name. @returns {Promise<{text: string}>} what happened. */
      execute: async (args) => {
        const action = String(args?.action ?? '')
        if (action === 'list') {
          const rows = listLogins()
          const shape = vaultState()
          if (rows.length === 0) {
            return { text: 'Nothing saved yet. Sign in on the site, then browser_login {action:"save", name:"work"}.' }
          }
          const head = `${rows.length} kept sign-in${rows.length === 1 ? '' : 's'}, ${Math.max(1, Math.round(shape.bytes / 1024))} KB sealed${shape.keyInKeychain ? ', key in the system keystore' : ''}`
          const lines = rows.map((row) => {
            const sites = row.origins.length === 0 ? '' : `, ${row.origins.join(' ')}`
            return `${row.name} — ${row.cookieCount} cookies${sites}, saved ${new Date(row.savedAt).toLocaleString()}`
          })
          return { text: [head, ...lines].join('\n') }
        }
        const name = String(args?.name ?? '').trim()
        if (name === '') return { text: 'Name the account: browser_login {action:"save", name:"work"}.' }
        if (action === 'drop') {
          return { text: dropLogin(name) ? `Forgot "${name}".` : `Nothing saved as "${name}".` }
        }
        if (action === 'save') {
          const page = await sidecar.ensure({ session: currentSession() })
          const cookies = await page.cookies()
          const storage = await storageOf(page)
          const kept = saveLogin(name, { cookies, storage, url: String(page.url ?? '') })
          const sites = kept.origins.length === 0 ? '' : ` and ${kept.origins.length} site${kept.origins.length === 1 ? '' : 's'} of local storage`
          return { text: `Saved "${kept.name}": ${kept.cookieCount} cookies${sites}, sealed on disk.` }
        }
        if (action === 'use') {
          const held = readLogin(name)
          if (held === null) return { text: `Nothing saved as "${name}". browser_login {action:"list"} shows what is kept.` }
          const page = await sidecar.ensure({ session: currentSession() })
          let put = 0
          for (const cookie of (Array.isArray(held.cookies) ? held.cookies : []).slice(0, 400)) {
            const domain = String(cookie?.domain ?? '').replace(/^\./u, '')
            if (domain === '' || cookie?.name === undefined) continue
            try {
              await page.setCookie({
                name: String(cookie.name),
                value: String(cookie.value ?? ''),
                domain,
                path: String(cookie.path ?? '/'),
                secure: cookie.secure === true,
                httpOnly: cookie.httpOnly === true,
                sameSite: cookie.sameSite,
                expires: cookie.session === true ? undefined : Number(cookie.expires) || undefined,
              })
              put += 1
            } catch {
              /* one cookie a site refuses is not a reason to stop */
            }
          }
          let stored = 0
          for (const row of (Array.isArray(held.storage) ? held.storage : []).slice(0, 4)) stored += await restoreStorage(page, row)
          const back = String(held.url ?? '')
          if (back !== '') await page.navigate(back)
          else await page.reload()
          const said = stored === 0 ? '' : `, ${stored} local storage entries`
          return { text: `Signed in as "${name}": ${put} cookies${said}, page reopened.` }
        }
        return { text: 'Pass action "list", "save", "use" or "drop".' }
      },
    },

    {
      name: 'browser_resume', // ui-copy-ignore
      description: 'Take the page back from the person at the mirror: clears the hold so the next action is sent at once, instead of waiting the few seconds out.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} confirmation. */
      execute: async () => {
        sidecar.release()
        return { text: 'ok — the page is the agent\'s again' }
      },
    },
    {
      name: 'browser_downloads', // ui-copy-ignore
      description: 'List what this browser has downloaded, newest first, with the file name, its size and when it arrived.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} the files. */
      execute: async () => {
        const files = sidecar.downloads()
        if (files.length === 0) return { text: 'no downloads yet' }
        return { text: files.map((file) => `${String(file.name)} · ${String(file.bytes)} B · ${String(file.at)}`).join('\n') }
      },
    },

    {
      name: 'browser_drag', // ui-copy-ignore
      description: 'Drag from one place to another with real mouse steps: from a ref or a point, to a point or offset. Use it for sliders, dashboards and drag-and-drop lists.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          from: { type: 'integer', description: 'Ref to start on.' },
          x: { type: 'integer', description: 'Start x, when not using from.' },
          y: { type: 'integer', description: 'Start y, when not using from.' },
          to_x: { type: 'integer', description: 'Where to let go, x.' },
          to_y: { type: 'integer', description: 'Where to let go, y.' },
          steps: { type: 'integer', description: 'Mouse moves along the way. Default 12.' },
          read: { type: 'boolean', description: 'Read the page after the drag.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what happened. */
      execute: async (args) => withRawPage(async (page) => {
        let start = { x: Number(args?.x ?? NaN), y: Number(args?.y ?? NaN) }
        if (args?.from !== undefined) {
          const spot = await findAgain(page, Number(args.from))
          if (spot.gone === true) return spot.why ?? REF_GONE
          start = { x: Number(spot.x), y: Number(spot.y) }
        }
        const end = { x: Number(args?.to_x ?? NaN), y: Number(args?.to_y ?? NaN) }
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return 'Give from (or x and y) and to_x and to_y.'
        const count = Math.max(2, Math.min(40, Number(args?.steps ?? 12)))
        await page.mouse('mouseMoved', start)
        await page.mouse('mousePressed', start)
        for (let index = 1; index <= count; index += 1) {
          await page.mouse('mouseMoved', {
            x: Math.round(start.x + ((end.x - start.x) * index) / count),
            y: Math.round(start.y + ((end.y - start.y) * index) / count),
          })
        }
        await page.mouse('mouseReleased', end)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `drag ${start.x},${start.y} → ${end.x},${end.y}`)
      }),
    },
    {
      name: 'browser_check', // ui-copy-ignore
      description: 'Set a checkbox, radio or switch to a known state, and say whether it took. Clicking blindly flips a control that is already right; this one looks first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Control number from browser_view.' },
          checked: { type: 'boolean', description: 'Wanted state. Omit to flip it.' },
          read: { type: 'boolean', description: 'Read the page after.' },
        },
        required: ['ref'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the state now. */
      execute: async (args) => withRawPage(async (page) => {
        const checkRoute = await contextFor(page, Number(args?.ref))
        const checkParams = {
          expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${checkRoute?.local ?? Number(args?.ref)}); if (!hit) return null; const el = hit.el; return { checked: Boolean(el.checked), name: String(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.name || '').trim().slice(0, 60) } })()`,
          returnByValue: true,
        }
        if (checkRoute?.contextId !== undefined) checkParams.contextId = checkRoute.contextId
        const probe = await page.cdp.send('Runtime.evaluate', checkParams, checkRoute?.sessionId)
        const now = probe.result?.value
        if (now === null || now === undefined) return spot.why ?? REF_GONE
        const want = args?.checked === undefined ? !Boolean(now.checked) : args.checked === true
        if (Boolean(now.checked) !== want) {
          const spot = await findAgain(page, Number(args.ref))
          if (spot.gone === true) return spot.why ?? REF_GONE
          await page.mouse('mouseMoved', { x: Number(spot.x), y: Number(spot.y) })
          await page.mouse('mousePressed', { x: Number(spot.x), y: Number(spot.y) })
          await page.mouse('mouseReleased', { x: Number(spot.x), y: Number(spot.y) })
          await settle(page, 3000)
        }
        const line = `${now.name} is now ${want ? 'on' : 'off'}`
        if (args?.read === true) return `${line}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
        return line
      }),
    },
    {
      name: 'browser_wait', // ui-copy-ignore
      description: 'Wait until the page shows a piece of text, stops showing it, reaches an address, or goes quiet. Cheaper than reading in a loop.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to wait for.' },
          gone: { type: 'string', description: 'Text to wait to disappear.' },
          url: { type: 'string', description: 'Address piece to wait for.' },
          idle: { type: 'boolean', description: 'Wait for the page to settle.' },
          timeout: { type: 'integer', description: 'Ceiling in milliseconds. Default 8000.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} whether it happened. */
      execute: async (args) => withRead(async (page) => {
        const timeout = Math.max(500, Math.min(30_000, Number(args?.timeout ?? 8000)))
        if (typeof args?.text === 'string' && args.text !== '') {
          const seen = await until(page, `document.body !== null && document.body.innerText.includes(${JSON.stringify(String(args.text))})`, timeout)
          return seen ? `saw ${String(args.text)}` : `did not see ${String(args.text)} within ${timeout} ms`
        }
        if (typeof args?.gone === 'string' && args.gone !== '') {
          const gone = await until(page, `document.body === null || !document.body.innerText.includes(${JSON.stringify(String(args.gone))})`, timeout)
          return gone ? `${String(args.gone)} is gone` : `${String(args.gone)} is still there after ${timeout} ms`
        }
        if (typeof args?.url === 'string' && args.url !== '') {
          const at = await until(page, `location.href.includes(${JSON.stringify(String(args.url))})`, timeout)
          return at ? `at ${String(await evaluate(page, 'location.href'))}` : `address never contained ${String(args.url)}`
        }
        const quiet = await quietInPage(page, timeout)
        if (typeof page.adoptOpened === 'function') await page.adoptOpened().catch(() => '')
        return quiet ? 'idle' : 'still moving'
      }),
    },
    {
      name: 'browser_dialog', // ui-copy-ignore
      description: 'Answer the alert, confirm or prompt the page is showing, or read what it asks. A dialog blocks the page until it is answered, so nothing else works while one is open.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          accept: { type: 'boolean', description: 'Yes or OK. Default true; false dismisses it.' },
          text: { type: 'string', description: 'What to answer a prompt with.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what the dialog said. */
      execute: async (args) => withRawPage(async (page) => {
        const dialog = page.dialog
        if (dialog === null || dialog === undefined) return 'no dialog is open'
        const said = `${String(dialog.type ?? '')}: ${String(dialog.message ?? '')}`
        await page.cdp.send('Page.handleJavaScriptDialog', {
          accept: args?.accept !== false,
          promptText: String(args?.text ?? ''),
        })
        page.dialog = null
        await settle(page, 3000)
        return said
      }),
    },
    {
      name: 'browser_console', // ui-copy-ignore
      description: 'The console lines and errors this page has produced, newest last. Use it when a click seemed to do nothing.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { limit: { type: 'integer', description: 'How many lines. Default 30.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the lines. */
      execute: async (args) => withRawPage(async (page) => {
        const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 30)))
        const lines = page.console.slice(-limit).map((entry) => `${entry.type}: ${entry.text}`)
        return lines.length === 0 ? 'no console output' : lines.join('\n')
      }),
    },
    {
      name: 'browser_failed', // ui-copy-ignore
      description: 'Requests this page tried and that failed, newest last. A blank area is often one of these.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { limit: { type: 'integer', description: 'How many. Default 20.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the failures. */
      execute: async (args) => withRawPage(async (page) => {
        const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20)))
        const rows = page.failed.slice(-limit).map((row) => `${row.type}: ${row.error}`)
        return rows.length === 0 ? 'no request failed' : rows.join('\n')
      }),
    },
    {
      name: 'browser_cookie',
      description: 'Read or change the cookies this browser keeps. Login state is a cookie, so this is how you check a sign-in and how you keep one.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Only cookies this address would send.' },
          set: { type: 'string', description: 'Write one cookie as name=value, for the current address or domain.' },
          domain: { type: 'string', description: 'Domain for a cookie being written.' },
          clear: { type: 'boolean', description: 'Drop every cookie in this browser.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      /* Reading the jar is safe; writing one is not, and the tool can do both. */
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what the jar holds now. */
      execute: async (args) => withRawPage(async (page) => {
        if (args?.clear === true) {
          await page.clearCookies()
          return 'every cookie is gone'
        }
        if (typeof args?.set === 'string' && args.set !== '') {
          const at = args.set.indexOf('=')
          if (at < 1) return 'write one cookie as name=value'
          const name = args.set.slice(0, at)
          const value = args.set.slice(at + 1)
          const answer = await page.setCookie({
            name,
            value,
            domain: typeof args.domain === 'string' && args.domain !== '' ? args.domain : undefined,
          })
          return answer.ok ? `kept ${name}` : `the browser refused ${name}: ${answer.reason}`
        }
        const url = typeof args?.url === 'string' && args.url !== '' ? [args.url] : undefined
        const jar = await page.cookies(url)
        if (jar.length === 0) return 'no cookies'
        return jar
          .slice(0, 40)
          .map((c) => `${c.domain}${c.path ?? '/'} ${c.name}=${String(c.value).slice(0, 60)}`)
          .join('\n')
      }),
    },
    {
      name: 'browser_clipboard', // ui-copy-ignore
      description: 'Read the sidecar browser\'s clipboard, or put text on it and paste it with a key press. For a page that only copies through a button, click it then read here.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          set: { type: 'string', description: 'Text to put on the clipboard.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} clipboard text. */
      execute: async (args) => withRawPage(async (page) => {
        if (typeof args?.set === 'string') {
          await page.clipboardWrite(args.set)
          return `clipboard set, ${String(args.set.length)} characters`
        }
        const text = await page.clipboardRead()
        return text === '' ? 'clipboard is empty, or the page did not allow reading it' : text
      }),
    },
    {
      name: 'browser_network', // ui-copy-ignore
      description: 'List the responses the page has received, newest first: method, status, type and address. Use it when a page fills itself from the network and the screen does not say why.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          filter: { type: 'string', description: 'Only rows whose address contains this text.' },
          limit: { type: 'integer', description: 'How many rows. Default 20, at most 60.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the requests. */
      execute: async (args) => {
        const want = String(args?.filter ?? '').toLowerCase()
        const limit = Math.min(60, Math.max(1, Number(args?.limit ?? 20) || 20))
        const rows = sidecar.network()
          .filter((row) => want === '' || String(row.url).toLowerCase().includes(want))
          .slice(0, limit)
        if (rows.length === 0) return { text: 'no responses yet' }
        return { text: rows.map((row) => `${String(row.status)} ${String(row.method)} ${String(row.type)} ${String(row.url)}`).join('\n') }
      },
    },

    {
      name: 'browser_tabs', // ui-copy-ignore
      description: 'List the pages open in the browser, switch the mirror to another one, or close one. Use it when a site opens a link in a tab of its own.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          action: { type: 'string', enum: ['list', 'switch', 'close'], description: 'Default list.' },
          index: { type: 'integer', description: 'A row from the list, counting from 0. Needed for switch and close.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the tabs or what happened. */
      execute: async (args) => withRawPage(async (page) => {
        const action = String(args?.action ?? 'list')
        if (action === 'list') {
          const rows = await sidecar.tabs(currentSession())
          if (rows.length === 0) return 'no tabs'
          return rows.map((row, i) => `${i}${row.current ? ' *' : ''} ${row.title || row.url} · ${row.url}`).join('\n')
        }
        const index = Number(args?.index ?? 0)
        if (action === 'switch') {
          const next = await sidecar.useTab(index, currentSession())
          return `tab ${index} · ${String(next?.url ?? '')}`
        }
        if (action === 'close') {
          /* Say what was closed, not what is left: after the close the page
             that was at that row is gone and reads back as about:blank. */
          const before = await sidecar.tabs(currentSession())
          const gone = String(before[index]?.url ?? '')
          await sidecar.closeTab(index, currentSession())
          return `closed tab ${index} · ${gone}`
        }
        throw new Error(`sidecar: unknown action ${action}`)
      }),
    },

    {
      name: 'browser_media', // ui-copy-ignore
      description: 'What this page played, and how to keep it: lists the video and sound requests the page already made, the one its own player shows first, with sizes; save one by row number, by part of its address, or save: main. Ads and measurement beacons stay out of the list unless all: true. A stream playlist is followed to its pieces and joined, so nothing has to be installed. watch: false stops remembering this page.',
      parameters: {
        type: 'object',
        properties: {
          find: { type: 'string', description: 'Only rows whose address contains this.' },
          save: { type: ['integer', 'string'], description: 'Row number from the list, part of its address, or main for the first row.' },
          all: { type: 'boolean', description: 'Include ads and beacons too (default false).' },
          watch: { type: 'boolean', description: 'false stops remembering what this page plays and empties the list; true resumes.' },
          height: { type: 'number', description: 'Tallest version to take when one address offers several (default 1080).' },
          name: { type: 'string', description: 'File name without extension.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      /** @returns {Promise<{text: string}>} the list, or where the file went. */
      execute: async (args) => withRawPage(async (page) => {
        if (typeof args?.watch === 'boolean') {
          const on = typeof page.mediaWatch === 'function' ? page.mediaWatch(args.watch) : false
          if (!on) return 'Off: this page keeps nothing from now on. watch: true puts it back.'
          if (args.save === undefined || args.save === null || args.save === '') return 'On: ask again once it has played something.'
        }
        const known = typeof page.mediaList === 'function' ? page.mediaList() : []
        const players = known.length === 0 ? [] : await playersOf(page)
        const ranked = coreRows(known, players, args?.all === true)
        const needle = String(args?.find ?? '').toLowerCase()
        const rows = needle === '' ? ranked : ranked.filter((each) => `${String(each.url)} ${String(each.mime)}`.toLowerCase().includes(needle))
        const save = args?.save
        if (save === undefined || save === null || save === '') {
          if (rows.length === 0) {
            if (known.length === 0) return 'Nothing to save yet: play the video or sound once, then ask again — the request it makes is the file.'
            if (needle !== '') return `Nothing matches ${String(args?.find)}; ${String(known.length)} played here, the ones worth keeping are gone.`
            return `Only ads and beacons played here (${String(known.length)}); all: true shows them.`
          }
          const hidden = known.length - ranked.length
          const lines = rows.slice(0, 12).map((each, at) => {
            const mine = players.find((one) => one.url === each.url || String(one.url).startsWith(String(each.url)) || String(each.url).startsWith(String(one.url)))
            const mark = at === 0 && mine !== undefined ? 'main ' : ''
            const length = mine !== undefined && mine.dur > 0 ? ` ${clockOf(mine.dur)}` : ''
            return `${String(at + 1)}. ${mark}${String(each.kind)}${length} ${sizeText(each.bytes)} · ${String(each.url).slice(0, 160)}`
          })
          if (rows.length > 12) lines.push(`… ${String(rows.length - 12)} more; narrow it with find`)
          if (hidden > 0) lines.push(`… ${String(hidden)} ad or beacon kept out; all: true shows them`)
          lines.push('save: <row> or main')
          return lines.join('\n')
        }
        const named = typeof save === 'string' && save.toLowerCase() === 'main'
        const wanted = named ? rows[0] : typeof save === 'number' ? rows[save - 1] : rows.find((each) => String(each.url).includes(String(save)))
        if (wanted === undefined) {
          return `No media row ${String(save)}. ${rows.length === 0 ? 'Nothing to save yet.' : 'Call browser_media without save to see the rows; all: true includes ads.'}`
        }
        const cookieAnswer = await page.cdp.send('Network.getCookies', { urls: [String(wanted.url)] }).catch(() => ({ cookies: [] }))
        const cookie = (cookieAnswer?.cookies ?? []).map((each) => `${String(each.name)}=${String(each.value)}`).join('; ')
        const headers = { 'user-agent': DESKTOP_UA, accept: '*/*' }
        if (cookie !== '') headers.cookie = cookie
        if (/^https?:/i.test(String(page.url ?? ''))) headers.referer = String(page.url)
        const started = Date.now()
        const getBinary = async (address) => {
          const answer = await fetch(address, { headers, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
          if (!answer.ok) throw new Error(`${String(answer.status)} for ${address.slice(0, 120)}`)
          return Buffer.from(await answer.arrayBuffer())
        }
        const cap = Number(args?.height ?? 1080)
        const wantedSize = cap > 0 ? { height: cap } : {}
        let parts
        let ext = extensionOf(wanted.url, wanted.mime)
        try {
          let body = await getBinary(String(wanted.url))
          parts = [body]
          const playlist = /\.m3u8(\?|#|$)/i.test(String(wanted.url)) || /mpegurl/i.test(String(wanted.mime ?? ''))
          if (playlist) {
            let plan = null
            let from = String(wanted.url)
            for (let hop = 0; hop < 2; hop += 1) {
              plan = planOf(from, body.toString('utf8'), wantedSize)
              if (plan.kind !== 'hls' || plan.variant === null) break
              from = plan.variant.url
              body = await getBinary(from)
            }
            if (plan.encrypted === true) return 'That stream is encrypted: the browser can play it, but the pieces are not a file to keep.'
            if (plan.parts.length === 0) return 'That playlist names no pieces. Play the movie first, then ask again.'
            const init = plan.init === '' ? [] : [await getBinary(plan.init)]
            parts = [...init, ...(await gather(plan.parts, getBinary, 6))]
            ext = plan.init !== '' ? '.mp4' : (/\.ts(\?|#|$)/i.test(plan.parts[0]) ? '.ts' : '.m4s')
          }
        } catch (error) {
          return `Could not fetch it: ${String(error?.message ?? error)}`
        }
        const body = Buffer.concat(parts)
        const dir = artifactDir('media')
        await mkdir(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const safe = String(args?.name ?? '').replace(/[^\w.-]/g, '').replace(/\.{2,}/g, '.').replace(/^\.+/, '')
        const file = join(dir, `${safe === '' ? `media-${stamp}` : safe}${ext}`)
        await writeFile(file, body)
        return `${file} — ${sizeText(body.length)} in ${String(Date.now() - started)} ms${parts.length > 1 ? ` (${String(parts.length)} parts joined)` : ''}`
      }),
    },

    {
      name: 'browser_pdf', // ui-copy-ignore
      description: 'Print the page to a PDF and return its path. Useful when the person wants the document rather than a picture of it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @returns {Promise<{text: string}>} where the PDF is. */
      execute: async () => withRawPage(async (page) => {
        const data = await page.pdf()
        return saveArtifact('pdf', data, { ext: '.pdf', prefix: 'page' })
      }),
    },
  ]
}
