/**
 * The model-facing half: what a call can do to the sidecar browser, and what it
 * says back.
 *
 * Two costs decide whether this is usable: the tokens a read spends, and the
 * round trips a task spends. The tool surface here is shaped around both — a
 * read can be narrowed (`mode`, `max_chars`) and diffed (`changed_only`), and
 * `sidecar_do` runs a run of steps in one call with waits that know when a page
 * has settled.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { VIEW } from './sidecar.js?v=1'
import { readPage, renderPage, locate, covering, contextFor, identityOf, sameThing, differs, labelSpot, selectSpot, bounds, pictures, REF_GONE } from './read.js?v=1'
import { brief as askBrief, recordRound, lastRoundNote, lastRound, markRound, MARK_STATUS } from './review.js?v=1'

/** Which chat the running call belongs to, so each gets its own tab. */
export const sessionScope = new AsyncLocalStorage()

/** @returns {string} the chat id of the running call. */
function currentSession() {
  return String(sessionScope.getStore() ?? '')
}

/** Where a screenshot from `sidecar_shot` lands, under the user's home. */
export const SHOT_DIR = join('.dsh-inner-browser-use', 'screenshots')

/** How many times a call found a control again after the page redrew it. */
const follows = { count: 0 }

/** Shown when the sidecar has never been started in this run. */
export const SIDECAR_OFF = 'The sidecar browser is not running. Call sidecar_open with the address first.'

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
async function acted(page, args, look, label) {
  if (args?.read === true) return await look()
  return `ok ${label} · ${await brief(page)}`
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

const CHECK_NOTE = 'That is the site asking a browser to prove a person is there, and a windowless one never gets past it. sidecar_open with headless false opens a window on the same profile, with the same logins.'

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
  let detail = String(page.title ?? '')
  try {
    const said = await evaluate(page, `(() => {
      const text = String(document.body ? document.body.innerText : '')
      const code = (String(text).match(/ERR_[A-Z0-9_]+/) || [''])[0]
      return code === '' ? String(document.title || '') : code
    })()`)
    if (typeof said === 'string' && said.trim() !== '') detail = said.trim()
  } catch {
    /* The error page itself refused to be read; the address still says enough. */
  }
  return `the network could not reach that address — the browser stopped on its own error page (${detail === '' ? 'no details' : detail}), which is not the site. Nothing on it is page content. Use sidecar_nav with another address, or fix the connection this machine needs.`
}

/** Key names this driver can press, spelled as a model would. */
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/**
 * Press a key: keyDown, then keyUp, with the character when the key types one.
 * @param {any} page - sidecar page.
 * @param {string} name - key name.
 * @param {number} [modifiers] - CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 * @returns {Promise<void>} done.
 */
export async function pressKey(page, name, modifiers = 0) {
  const key = KEYS[name] ?? KEYS[name.charAt(0).toUpperCase() + name.slice(1)]
  if (key === undefined) throw new Error(`sidecar: no such key ${name}`) // ui-copy-ignore
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers }
  await page.key('keyDown', key.text === undefined ? base : { ...base, text: key.text })
  await page.key('keyUp', base)
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
  return `the person is using the mirror (${String(Math.ceil(left / 1000))} s more) — nothing was sent. Let them finish, then repeat this call; sidecar_resume takes the page back now.`
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
function coverNote(probe) {
  if (probe === null || probe === undefined) return ''
  const what = probe.tag === 'div' || probe.tag === 'section' ? 'an overlay' : `a ${probe.tag}`
  return `
${what} covers it${probe.name === '' ? '' : `: ${probe.name}`} — the click landed beneath it`
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
  const note = coverNote(probe)
  const away = probe.dismiss
  if (away === null) return { note, cleared: false, name: '' }
  await page.mouse('mouseMoved', { x: away.x, y: away.y })
  await page.mouse('mousePressed', { x: away.x, y: away.y, clickCount: 1 })
  await page.mouse('mouseReleased', { x: away.x, y: away.y, clickCount: 1 })
  await wait(150)
  const again = await coverProbe(page, ref)
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
async function evaluate(page, expression, route) {
  const params = { expression, returnByValue: true, awaitPromise: true }
  if (route?.contextId !== undefined) params.contextId = route.contextId
  const call = page.cdp.send('Runtime.evaluate', params, route?.sessionId)
  const raced = await Promise.race([call, wait(2000).then(() => 'timeout')])
  if (raced === 'timeout') return undefined
  const { result, exceptionDetails } = raced
  if (exceptionDetails !== undefined) {
    return { error: String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed') }
  }
  return result?.value
}

/**
 * Wait until the page has settled: loading finished and the address stopped
 * changing. Acting on a page mid-navigation is how a driver clicks the old page.
 * @param {any} page - sidecar page.
 * @param {number} [timeout] - ceiling in milliseconds.
 * @returns {Promise<string>} the address it settled on.
 */
export async function settle(page, timeout = 5000) {
  /* A click may have opened a tab. The mirror follows it, so every tool that
     waited on a page ends up on the page the person would be looking at. */
  const opened = typeof page.adoptOpened === 'function' ? await page.adoptOpened().catch(() => '') : ''
  const deadline = Date.now() + timeout
  let last = ''
  let steady = 0
  while (Date.now() < deadline) {
    if (page.dialog !== null && page.dialog !== undefined) return String(page.url ?? '')
    const state = await evaluate(page, '({ ready: document.readyState, href: location.href })')
    const key = `${String(state?.ready)}|${String(state?.href)}`
    steady = key === last ? steady + 1 : 0
    last = key
    if (state?.ready !== 'loading' && steady >= 2) return String(state?.href ?? '')
    await wait(60)
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
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await evaluate(page, expression)
    if (value === true) return true
    await wait(100)
  }
  return false
}

/**
 * One step of a batch. Kept small on purpose: every step is one thing a person
 * would do with a mouse or a keyboard.
 * @param {any} page - sidecar page.
 * @param {any} step - the step.
 * @returns {Promise<string>} a compact report.
 */
/** The first control whose words match, scrolled into view. Text can beat a number: it costs no read. */
async function findWords(page, words) {
  const read = await readPage(page, { mode: 'text', maxChars: 1200, max: 200 })
  const shown = read.controls.filter((control) => control.view !== false)
  /* The words may sit in separate inline nodes: <span>Sign</span><span>in</span>
     reads as "Signin" to the page, so compare with the spaces taken out too. */
  const squeeze = (text) => String(text).toLowerCase().replace(/\s+/g, '')
  const wanted = squeeze(words)
  const found = shown.find((control) => squeeze(control.name) === wanted) ?? shown.find((control) => squeeze(control.name).includes(wanted))
  if (found === undefined) return null
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
 * @returns {Promise<{x: number, y: number, name: string, lead: string}|null>} the click.
 */
async function fieldByName(page, words) {
  const hit = await findWords(page, words)
  const lead = hit === null ? '' : await coverLead(page, hit.ref)
  if (hit !== null && EDITABLE_KINDS.includes(String(hit.kind))) {
    const spot = await locate(page, hit.ref)
    if (spot.gone !== true) return { x: Number(spot.x), y: Number(spot.y), name: String(hit.name), lead }
  }
  const field = await fieldSpot(page, words)
  if (field !== null) return { ...field, lead }
  if (hit === null) return null
  const spot = await locate(page, hit.ref)
  if (spot.gone === true) return null
  return { x: Number(spot.x), y: Number(spot.y), name: String(hit.name), lead }
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
  await page.mouse('mouseMoved', drift(-14 - Math.round(Math.random() * 10)))
  await wait(40 + Math.round(Math.random() * 45))
  await page.mouse('mouseMoved', drift(-4 - Math.round(Math.random() * 4)))
  await wait(25 + Math.round(Math.random() * 35))
  await page.mouse('mouseMoved', point)
  await wait(35 + Math.round(Math.random() * 60))
  await page.mouse('mousePressed', { ...point, clickCount: 1 })
  await wait(20 + Math.round(Math.random() * 40))
  await page.mouse('mouseReleased', { ...point, clickCount: 1 })
  await wait(90 + Math.round(Math.random() * 120))
  if (options.clear === true) await clearFocus(page)
  if (options.human === false) await page.insertText(text)
  else await page.humanType(text)
  if (options.submit === true) await pressKey(page, 'Enter')
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
    const hit = await findWords(page, String(step.tap))
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
    const target = await fieldByName(page, String(step.field))
    if (target === null) return stuck(`${String(step.field)}: ${REF_GONE}`)
    await writeAt(page, { x: target.x, y: target.y }, String(step.text ?? ''), { clear: step.clear, submit: step.submit })
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
async function remember(page, refs, options) {
  const read = await readPage(page, options)
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
  const lines = [next.url]
  if (previous.url !== next.url) lines.push(`address changed to ${next.url}`)
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
    const head = next.text.slice(0, Math.max(200, Math.min(1200, maxChars - 800)))
    lines.push('', 'text now:', head)
    if (next.text.length > head.length) lines.push(`… ${next.text.length - head.length} more characters`)
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
  if (value === undefined || value === null || value === '') return 'the page did not answer; try again, or read the page with sidecar_view.'
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
  if (at === null || at === undefined) return 'No box to type in on this page. Call sidecar_view to see what is there.'
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
  return `the page changed but does not show the message: it did not take what was sent.${asking ? ' It is asking for a sign-in — sign in in the column, then ask again.' : ' Try sidecar_view to see what is in the way.'}`
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
    /* A plugin reload makes a new driver while the browser it started keeps
       running. Refusing every read until someone opens a page again would throw
       away a browser that is still there: attach to it instead. */
    if (!sidecar.alive) {
      try {
        await sidecar.ensure({ session: currentSession() })
      } catch {
        return { text: SIDECAR_OFF }
      }
    }
    const page = await sidecar.ensure({ session: currentSession() })
    const dead = await unreachable(page)
    if (dead !== '') return { text: dead + personNote(sidecar) }
    const text = await work(page)
    return { text: text + personNote(sidecar) }
  }
  const withPage = async (work) => {
    if (!sidecar.alive) return { text: SIDECAR_OFF }
    const hold = holdText(sidecar)
    if (hold !== '') return { text: hold }
    return withRead(work)
  }
  const look = async (page, options) => {
    const read = await remember(page, refsFor(), options)
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
      name: 'sidecar_open', // ui-copy-ignore
      description: 'Start (or reuse) the sidecar browser — a real Chrome with its own persistent profile — and open a URL in it. It runs in the background and its screen appears in this chat\'s sidebar tab, so it keeps working while the person looks elsewhere. Logins survive restarts.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open. Omit to reuse the current page.' },
          headless: { type: 'boolean', description: 'Run without a window. Default true; turn off only if a site refuses a windowless browser.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @param {any} exec - tool run. @returns {Promise<{text: string}>} what the page is. */
      execute: async (args, exec) => {
        const who = String(exec?.agent?.id ?? '')
        const page = await sidecar.ensure({ url: args?.url, headless: args?.headless, session: who })
        if (args?.url === undefined) await page.readTitle()
        /* A window on the person's screen is their business, not a surprise: say
           it, so nobody wonders what popped up. A site that refuses a windowless
           browser is the only reason this happens. */
        const windowed = sidecar.headless === false ? 'The browser is showing a window this time — a site only opens for a windowed one. Same profile, same logins.\n' : ''
        /* The tab appears in the calling chat and nowhere else: the person may
           be reading a different chat, and a browser there would be a surprise. */
        if (who !== '') host.want?.(who) // ui-copy-ignore
        await settle(page, 8000)
        const dead = await unreachable(page)
        if (dead !== '') return { text: dead }
        /* The column may still be drawing nothing: say so here, where the
           person is looking for a picture, rather than only in sidecar_state. */
        const unseen = who === '' ? '' : viewerNote(await watchForViewer(sidecar, page, 1200))
        return { text: windowed + (unseen === '' ? '' : `${unseen}\n`) + await look(page, { mode: 'text' }) }
      },
    },
    {
      name: 'sidecar_view', // ui-copy-ignore
      description: 'Read the sidecar browser: numbered controls and the words on screen. Numbers stay valid across reads and actions until the page navigates. Narrow it with mode (text, links, forms, full) and max_chars; ask for changed_only after an action to spend fewer tokens.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mode: { type: 'string', enum: ['text', 'links', 'forms', 'full'], description: 'What to include. Default text: controls plus the visible words.' },
          max_chars: { type: 'integer', description: 'Character budget for the page text. Default 6000.' },
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
        const read = await remember(page, refs, options)
        const note = isCheckPage(read) ? `\n${CHECK_NOTE}` : ''
        if (args?.changed_only === true && state.last !== undefined) {
          /* The diff becomes the new baseline: a page that moved zero -> one
             should not report that move again on the next read. */
          const text = diffRead(state.last, read, options) + note
          state.last = read
          state.lastShape = JSON.stringify(options)
          return text
        }
        const before = state.last
        state.last = read
        /* Same page, same shape, same words: the numbers above still work, and
           repeating the page would only spend tokens. */
        if (sameRead(before, read) && state.lastShape === JSON.stringify(options)) {
          const moved = Number(before.scroll?.y ?? 0) !== Number(read.scroll?.y ?? 0) ? `, scrolled to ${Math.round(Number(read.scroll?.y ?? 0))}` : ''
          return `still at ${read.url}${moved} — nothing changed since the last read; the numbers above still work${note}`
        }
        state.lastShape = JSON.stringify(options)
        return renderPage(read, options) + note
      }),
    },
    {
      name: 'sidecar_click', // ui-copy-ignore
      description: 'Click a numbered control, a point, or the first control whose words contain `text` — the last needs no read first. The click is real mouse input and the mirror shows where it landed.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from sidecar_view.' },
          text: { type: 'string', description: 'Words on the control, when its number is not known.' },
          x: { type: 'integer', description: 'Viewport x, when clicking a point.' },
          y: { type: 'integer', description: 'Viewport y, when clicking a point.' },
          double: { type: 'boolean', description: 'Double-click.' },
          right: { type: 'boolean', description: 'Right-click, opening a context menu.' },
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
          const hit = await findWords(page, String(args.text))
          if (hit === null) return `No control says ${JSON.stringify(String(args.text))}. Call sidecar_view to see what is there.`
          point = { x: hit.x, y: hit.y }
          label = `"${hit.name.slice(0, 60)}"`
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'Give a ref from sidecar_view, or both x and y.'
        const button = args?.right === true ? 'right' : 'left'
        let cover = ''
        if (args?.ref !== undefined && button === 'left') {
          const gate = await clearCover(page, Number(args.ref))
          cover = gate.note
          /* An overlay that would not go away leaves the control underneath:
             the click would land on the overlay, so it is not sent. */
          if (gate.cleared !== true) {
            return `${cover.trim()}\nNot clicked: the control is still covered. Call sidecar_view and handle the overlay first.`
          }
          if (gate.cleared && cover !== '') {
            const again = await locate(page, Number(args.ref))
            if (again.gone !== true) point = { x: Number(again.x), y: Number(again.y) }
          }
        }
        await page.mouse('mouseMoved', point)
        await page.mouse('mousePressed', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        await page.mouse('mouseReleased', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        await settle(page)
        const said = await acted(page, args, () => look(page, { mode: 'text', maxChars: 3000 }), `click ${label}`)
        return said + cover + (followed === '' ? '' : ` (${followed})`)
      }),
    },
    {
      name: 'sidecar_type', // ui-copy-ignore
      description: 'Type text into the sidecar browser — Chinese included — optionally pressing Enter. Pass a ref to focus that control first. With clear, the field is emptied first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          ref: { type: 'integer', description: 'Control to click before typing.' },
          field: { type: 'string', description: 'The field is called this on screen, when you have no number for it.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          clear: { type: 'boolean', description: 'Select all and delete before typing.' },
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
        if (args?.field !== undefined && args?.ref === undefined) {
          const target = await fieldByName(page, String(args.field))
          if (target === null) return `${String(args.field)}: ${REF_GONE}`
          cover = target.lead
          await writeAt(page, { x: target.x, y: target.y }, String(args?.text ?? ''), { clear: args?.clear, submit: args?.submit === true })
          await settle(page)
          const called = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type')
          return called + cover + ` (typed into "${target.name.slice(0, 50)}")` // ui-copy-ignore
        }
        if (args?.ref !== undefined) {
          const gate = await clearCover(page, Number(args.ref))
          cover = gate.note
          if (gate.cleared !== true) {
            return `${cover.trim()}\nNot typed into: the field is still covered. Call sidecar_view and handle the overlay first.`
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
        await page.humanType(String(args?.text ?? ''))
        if (args?.submit === true) await pressKey(page, 'Enter')
        await settle(page)
        const said = await acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type')
        return said + cover + (followed === '' ? '' : ` (${followed})`) // ui-copy-ignore
      }),
    },
    {
      name: 'sidecar_ask', // ui-copy-ignore
      description: 'Say something to a chat that is open in the page — a model, a support window, a search box — and read its answer back in the same call. Types into the box, presses Enter, then waits until the answer stops growing. Use it to get a review or a picture prompt answered without a read between every step.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'What to say.' },
          ref: { type: 'integer', description: 'The box to type in, from sidecar_view. Omit to use the page\u2019s own chat box.' },
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
      name: 'sidecar_review', // ui-copy-ignore
      description: 'Ask the chat in the page to review a repository and take its review back as a list: builds the message, sends it, waits for the answer, and writes the round down so the next round knows what was already said. Use it for a review round, not for a one-off question (that is sidecar_ask).',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          repo: { type: 'string', description: 'Address of the repository to review.' },
          commit: { type: 'string', description: 'The commit the review is about. Omit for the newest one.' },
          focus: { type: 'string', description: 'One thing to look at especially.' },
          diff: { type: 'string', description: 'The change to review, as a diff. Include it when the reviewer cannot open the repository itself.' },
          ref: { type: 'integer', description: 'The box to type in, from sidecar_view. Omit to use the page\u2019s own chat box.' },
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
      name: 'sidecar_review_verdict', // ui-copy-ignore
      description: 'Record what happened to each point of the last review round, so the next round leaves settled points out: point numbers are the ones sidecar_review printed, and each mark is fixed, verified (checked in the code and the point does not apply), invalid, or open.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mark: { // ui-copy-ignore
            type: 'array',
            description: 'One entry per point: which point, its status, and the evidence that backs it.',
            items: { // ui-copy-ignore
              type: 'object', // ui-copy-ignore
              properties: { // ui-copy-ignore
                point: { type: 'integer', description: 'The point number sidecar_review printed, starting at 1.' },
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
        if (written === null) return 'No review round to mark: play one with sidecar_review first.'
        const counts = new Map()
        for (const mark of written.marks) counts.set(mark.status, (counts.get(mark.status) ?? 0) + 1)
        const said = [...counts].map(([status, n]) => `${n} ${status}`).join(', ')
        return `review round ${String(written.round.commit || 'newest').slice(0, 12)}: recorded ${written.marks.length} of ${written.round.points.length} points (${said}).`
      },
    },
    {
      name: 'sidecar_key', // ui-copy-ignore
      description: 'Press one key in the sidecar browser: Enter, Tab, Escape, Backspace, Delete, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Home, End, PageUp, PageDown, Space.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          key: { type: 'string', description: 'Key name.' },
          modifiers: { type: 'string', description: 'Held while pressing: Ctrl, Alt, Shift or Meta, joined by +.' },
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
        const held = String(args?.modifiers ?? '')
        const mods = (held.includes('Alt') ? 1 : 0) + (held.includes('Ctrl') ? 2 : 0) + (held.includes('Meta') ? 4 : 0) + (held.includes('Shift') ? 8 : 0)
        await pressKey(page, name, mods)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `key ${name}`)
      }),
    },
    {
      name: 'sidecar_scroll', // ui-copy-ignore
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
        await wait(200)
        const delta = Number(args?.dy ?? 600)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 4000 }), `scroll ${delta > 0 ? '+' : ''}${delta}`)
      }),
    },
    {
      name: 'sidecar_hover', // ui-copy-ignore
      description: 'Move the pointer onto a numbered control, so hover-only menus and tooltips open, then return what the page shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from sidecar_view.' },
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
      name: 'sidecar_nav', // ui-copy-ignore
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
      name: 'sidecar_do', // ui-copy-ignore
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
          const said = await runStep(page, step ?? {}, refsFor().refs)
          const text = typeof said === 'string' ? said : said.text
          report.push(`${index + 1}. ${text}`)
          /* A step that never landed makes every later step a guess, so the
             batch ends here instead of typing into a page that is not there. */
          if (typeof said !== 'string' && said.blocked === true) {
            return `${report.join('\n')}\nStopped after step ${index + 1}. Call sidecar_view and plan again from what the page shows now.`
          }
          /* A step can navigate straight onto Chrome's error page — a mistyped
             address, or a site that does not answer. The rest of the batch
             would then type into "This site can't be reached", so it stops
             here and says what really happened. */
          if (isErrorPage(page)) return `${report.join('\n')}\nStopped after step ${index + 1}: ${await unreachable(page)}`
          if (step?.sleep_ms === undefined && step?.wait_text === undefined && step?.wait_gone === undefined && step?.wait_url === undefined && step?.wait_idle === undefined) {
            await settle(page, Number(step?.timeout ?? 5000))
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
      name: 'sidecar_extract', // ui-copy-ignore
      description: 'Read the items a selector matches as one compact line each — lists, search results, tables, menus — instead of the whole page. Each row keeps its link when it has one. Use it when a page has more rows than the read budget allows; it costs a fraction of a full read.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          select: { type: 'string', description: 'CSS selector for the items, for example "ul.results > li".' },
          ref: { type: 'integer', description: 'Only look inside this control, as numbered by the last sidecar_view.' },
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
      name: 'sidecar_eval', // ui-copy-ignore
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
      name: 'sidecar_select', // ui-copy-ignore
      description: 'Choose an option in a dropdown, by visible label or value, then return the page.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the select control from sidecar_view.' },
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
        if (args?.ref === undefined) {
          if (args?.field === undefined) return 'name the dropdown: pass its number from sidecar_view, or the words on screen that name it.' // ui-copy-ignore
          const chosen = await evaluate(page, selectSpot(String(args.field), String(args?.value ?? '')))
          const said = typeof chosen === 'string' ? chosen : chosen?.error === undefined ? '' : String(chosen.error)
          if (said === '' || said.startsWith('no dropdown')) return said === '' ? 'the page did not answer; read it and try again.' : said // ui-copy-ignore
          await settle(page, 3000)
          if (args?.read === true) return `${said}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
          return `${said} · ${await brief(page)}`
        }
        const spot = await findAgain(page, Number(args?.ref))
        if (spot.gone === true) return spot.why ?? REF_GONE
        const wanted = JSON.stringify(String(args?.value ?? ''))
        const route = await contextFor(page, Number(args?.ref))
        const local = route?.local ?? Number(args?.ref)
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
        if (args?.read === true) return `${String(said)}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
        return `${String(said)} · ${await brief(page)}`
      }),
    },
    {
      name: 'sidecar_upload', // ui-copy-ignore
      description: 'Put files into a file input on the page, by absolute path, then return the page. The file chooser never opens.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the file input from sidecar_view.' },
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
      name: 'sidecar_shot', // ui-copy-ignore
      description: 'Save a PNG of the sidecar browser into the session folder and return its absolute path; when the current model accepts images the picture comes back in the same call, so a captcha, a chart or a broken layout can be looked at instead of guessed. Default is the visible screen; full takes the whole page, ref takes one control.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          name: { type: 'string', description: 'File name without extension.' },
          full: { type: 'boolean', description: 'The whole page, not just the screen.' },
          ref: { type: 'integer', description: 'One control from sidecar_view.' },
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
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const name = String(args?.name ?? '').replace(/[^\w.-]/g, '') || `sidecar-${Date.now()}`
        const file = join(dir, name.endsWith('.png') ? name : `${name}.png`)
        await writeFile(file, Buffer.from(data, 'base64'))
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
        if (image === undefined) return { text: `${said.text}\nno picture reached this result — sidecar_view reads the words here, sidecar_grab returns a picture as a file` }
        return { text: said.text, image }
      },
    },
    {
      name: 'sidecar_grab', // ui-copy-ignore
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
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const base = String(args?.name ?? '').replace(/[^\w.-]/g, '') || `sidecar-picture-${Date.now()}`
        const list = Array.isArray(found?.pictures) ? found.pictures : []
        for (let index = 0; index < list.length; index += 1) {
          const item = list[index]
          const body = String(item?.data ?? '')
          const mark = body.indexOf(',')
          if (mark < 0) continue
          const type = String(item?.type ?? 'image/png')
          const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('svg') ? 'svg' : 'png'
          const file = join(dir, `${base}${list.length > 1 ? `-${index + 1}` : ''}.${ext}`)
          await writeFile(file, Buffer.from(body.slice(mark + 1), 'base64'))
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
      name: 'sidecar_state', // ui-copy-ignore
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
          `profile ${String(state.profile)}`,
          `url ${String(state.url)}`,
          `title ${String(state.title)}`,
          `viewers ${String(state.viewers)}`,
          `listening chats ${seats}`, // ui-copy-ignore
          `mirror owner ${owner === '' ? 'none' : owner}`, // ui-copy-ignore
          owner === '' ? 'no owner' : `owner ${owner}`,
          `refs followed ${String(follows.count)}`,
          holdText(sidecar) === '' ? 'person free' : `person using it (${String(Math.ceil(Number(sidecar.holding()) / 1000))} s left)`,
        ]
        if (state.alive === true && viewerNote(state.viewers) !== '') rows.push(NO_VIEWER)
        return { text: rows.join('\n') }
      },
    },

    {
      name: 'sidecar_resume', // ui-copy-ignore
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
      name: 'sidecar_downloads', // ui-copy-ignore
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
      name: 'sidecar_drag', // ui-copy-ignore
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
      name: 'sidecar_check', // ui-copy-ignore
      description: 'Set a checkbox, radio or switch to a known state, and say whether it took. Clicking blindly flips a control that is already right; this one looks first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Control number from sidecar_view.' },
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
      name: 'sidecar_wait', // ui-copy-ignore
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
        await settle(page, timeout)
        return 'idle'
      }),
    },
    {
      name: 'sidecar_dialog', // ui-copy-ignore
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
      name: 'sidecar_console', // ui-copy-ignore
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
      name: 'sidecar_failed', // ui-copy-ignore
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
      name: 'sidecar_cookie',
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
      name: 'sidecar_clipboard', // ui-copy-ignore
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
      name: 'sidecar_network', // ui-copy-ignore
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
      name: 'sidecar_tabs', // ui-copy-ignore
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
          await sidecar.closeTab(index, currentSession())
          return `closed tab ${index} · ${String((sidecar.pageFor(currentSession()) ?? sidecar.page)?.url ?? '')}`
        }
        throw new Error(`sidecar: unknown action ${action}`)
      }),
    },

    {
      name: 'sidecar_pdf', // ui-copy-ignore
      description: 'Print the page to a PDF and return its path. Useful when the person wants the document rather than a picture of it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @returns {Promise<{text: string}>} where the PDF is. */
      execute: async () => withRawPage(async (page) => {
        const data = await page.pdf()
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const file = join(dir, `sidecar-${Date.now()}.pdf`)
        await writeFile(file, Buffer.from(data, 'base64'))
        return file
      }),
    },
  ]
}
