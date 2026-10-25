/**
 * dsh-inner-browser-use — host half. // ui-copy-ignore
 *
 * The sidebar browser lives in the Client: a `<webview>` leased from the
 * Desktop main process, one partition per workspace. A tool runs on the Host, // ui-copy-ignore
 * so the Host needs a way to reach that guest. This file owns that wire, and // ui-copy-ignore
 * the tool surface the model sees.
 *
 * Transport is same-origin HTTP through the product document:
 *
 * - the Client `POST`s frames to `/dsh-inner-browser-use/uplink`;
 * - the Host pushes frames down `/dsh-inner-browser-use/downlink` as // ui-copy-ignore
 *   server-sent events on one long-lived response;
 * - a tool call on the Host waiting for a round trip resolves when its reply // ui-copy-ignore
 *   frame arrives on the uplink.
 *
 * Same-origin is what makes this work on both faces of the product. In the Web
 * build the page already sits on the Host origin. In the Desktop build the // ui-copy-ignore
 * product document is `dsh-app://app`, whose protocol handler forwards any path
 * it does not serve itself to the Host with the Host cookie attached — so a // ui-copy-ignore
 * relative `fetch` from the page reaches these routes without CORS and without
 * the Client learning a port or a token. // ui-copy-ignore
 *
 * One transport, two faces, no port, no secret: that is the whole design. // ui-copy-ignore
 */

import { createWriteStream, readFileSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Everything this plugin writes lands under this one folder of the chat's working
 * directory, so a project's root gains nothing but a single hidden name.
 */
const WORK_DIR = '.dsh-inner-browser-use'

/** Screenshots of the page. */
const SHOT_DIR = join(WORK_DIR, 'screenshots')

/** Files the page offers. */
const DOWNLOAD_DIR = join(WORK_DIR, 'downloads')

/** Makes that folder keep itself out of the project's own version control. */
const KEEP = '# written by the chat while it reads pages\n*\n'

/**
 * Sign-in cookies wait here between app runs: one file per workspace key, in the
 * user's profile rather than the project, readable by that user only.
 * @returns {string} folder that holds them.
 */
function cookieDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'inner-browser-use', 'cookies')
}

/** What the guest may keep: more than this is a page resetting itself, not a sign-in. */
const MAX_COOKIES = 600
const MAX_COOKIE_BYTES = 512 * 1024

/** Largest file the plugin will push into a page. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/** Types the guest needs for the common cases; the page rarely checks. */
const TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
}

/** @param {string} file - absolute path. @returns {string} media type for the guest. */
function mediaType(file) {
  const dot = file.lastIndexOf('.')
  return TYPES[file.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/** Route prefix owned by this plugin. Never under `/api`, which is the Host's own channel. */ // ui-copy-ignore
export const ROUTE = '/dsh-inner-browser-use'

/** Largest uplink frame accepted. Frames are DOM observations, not screenshots. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** How long one page operation may take before the Host gives up on it. */ // ui-copy-ignore
const DEFAULT_TIMEOUT_MS = 25_000

/** Navigation waits on the page itself, which is slower than reading it. */
const NAVIGATE_TIMEOUT_MS = 60_000

/** A file crosses the page, the bridge and the disk inside this budget. */
const DOWNLOAD_TIMEOUT_MS = 120_000

/** How long a tool waits for the tab it asked for. */
const OPEN_WAIT_MS = 8_000

/** Shown when a tool runs without the tab that owns the guest. */
const ASK_GAP_MS = 3_000
const CLIENT_TTL_MS = 60_000
const ASK_ALIAS_MS = 30_000
const NO_TAB = 'No 内置浏览器 tab answered. Open it in the right sidebar from the tab strip, then call again.'
const ELSEWHERE = "This chat's own tab is in the tab strip of the chat being read. Open that chat, then call again."
const NO_PANEL = 'The browser panel could not be taken here. Open the 内置浏览器 tab in the right sidebar, then call again.'
const NOT_DRAWN = "This chat's page is not the one being read. Open this chat, then call again; browser_script reads the page as it is." 

/** @type {string} */
let proofLog = process.env.DSH_INNER_BROWSER_PROOF ?? '/tmp/dsh-inner-browser-use.log'

/**
 * Read a request body with a hard ceiling.
 * @param {import('node:http').IncomingMessage} req - request carrying the frame.
 * @returns {Promise<string>} decoded body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_FRAME_BYTES) {
        reject(new Error('frame too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * One Client connection is one seat: the tab that currently holds the guest.
 * Tools route to the seat of the session that asked, and fall back to the only
 * seat when exactly one tab is open.
 */
/**
 * The file a workspace's cookies live in. The key is a workspace name, so the user
 * can delete one file and sign in again for that workspace only.
 * @param {string} key - workspace key the guest was leased with.
 * @returns {string} absolute path of its cookie file.
 */
export function cookiePath(key) {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 24)
  return join(cookieDir(), `${digest}.json`)
}

/**
 * Keep only what a cookie is: a name, a value, and where it belongs. Anything else
 * a page reports is dropped rather than handed back to the guest.
 * @param {unknown} list - what the page sent.
 * @returns {Record<string, unknown>[]} cookie fields worth keeping.
 */
export function keptCookies(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const each of list) {
    if (each === null || typeof each !== 'object') continue
    const one = /** @type {Record<string, unknown>} */ (each)
    if (typeof one.name !== 'string' || typeof one.value !== 'string') continue
    if (typeof one.domain !== 'string' && typeof one.url !== 'string') continue
    out.push(one)
    if (out.length >= MAX_COOKIES) break
  }
  return out
}

/**
 * Read the cookies kept for a workspace.
 * @param {string} key - workspace key.
 * @returns {Promise<Record<string, unknown>[]>} cookies, empty when none were kept.
 */
export async function readCookies(key) {
  try {
    const text = await readFile(cookiePath(key), 'utf8')
    if (text.length > MAX_COOKIE_BYTES) return []
    return keptCookies(JSON.parse(text))
  } catch {
    return []
  }
}

/**
 * Replace the cookies kept for a workspace.
 * @param {string} key - workspace key.
 * @param {unknown} list - cookies the page reported.
 * @returns {Promise<number>} how many were kept.
 */
export async function writeCookies(key, list) {
  const kept = keptCookies(list)
  await mkdir(cookieDir(), { recursive: true })
  const file = cookiePath(key)
  if (kept.length === 0) {
    await writeFile(file, '[]', { mode: 0o600 })
    return 0
  }
  const text = JSON.stringify(kept)
  if (text.length > MAX_COOKIE_BYTES) return 0
  await writeFile(file, text, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return kept.length
}

/**
 * One heartbeat as the state route reports it: the page half is fresh while it
 * answered within `CLIENT_TTL_MS`, and a stale beat is kept, not erased — it is
 * the only clue that a page loaded earlier and then stopped.
 * @param {{ms: number, frame: Record<string, unknown>} | undefined} beat - last heartbeat.
 * @param {number} [now] - current time in ms.
 * @returns {Record<string, unknown> | null} - the reported client, or null before any beat.
 */
export function clientState(beat, now = Date.now()) {
  if (beat === undefined) return null
  return { ...beat.frame, at: new Date(beat.ms).toISOString(), fresh: now - beat.ms < CLIENT_TTL_MS }
}

export class Bridge {
  constructor() {
    /** @type {Map<string, {res: import('node:http').ServerResponse, sessionId: string}>} */
    this.seats = new Map()
    /** @type {Map<string, {resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
    this.waiters = new Map()
    /** @type {Map<string, string>} */
    this.refused = new Map()
    /** @type {{at: string, frame: unknown} | undefined} */
    this.client = undefined
    /** @type {Set<import('node:http').ServerResponse>} open watch streams: the page's listener that can open tabs. */
    this.watchers = new Set()
    /** When each chat last asked for a tab, so one ask per call burst. @type {Map<string, number>} */
    this.asked = new Map()
    /** @type {Map<string, string>} chat id the tool layer uses → tab id the page reported. */
    this.aliases = new Map()
    /** Named in every heartbeat reply: a page whose stream predates this bridge
     * still looks connected and reaches nothing, so the reply tells it to reopen. */
    this.epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    /** @type {{chat: string, at: number} | undefined} the ask still waiting for a tab. */
    this.asking = undefined
    /** @type {number} how long a call waits for the tab it asked for. */
    this.openWaitMs = OPEN_WAIT_MS
  }

  /**
   * Take one watch stream: the Client half that can open a tab on request.
   * @param {import('node:http').ServerResponse} res - open SSE response.
   */
  watch(res) {
    this.watchers.add(res)
  }

  /**
   * Learn which tab answers this chat: the page reports the id it opened right
   * after the ask, and that id is what the tab's own stream arrives under.
   * @param {Record<string, unknown>} frame - one heartbeat.
   */
  /**
   * A page that will not answer this chat says why, so the call need not wait.
   * @param {{phase?: string, step?: string, session?: string}} frame - heartbeat from the page.
   * @returns {void}
   */
  noteStep(frame) {
    if (frame?.phase !== 'open' || typeof frame.session !== 'string' || frame.session === '') return
    if (frame.step === 'other-chat') this.refused.set(frame.session, ELSEWHERE)
    if (frame.step === 'rightbar') this.refused.set(frame.session, NO_PANEL)
  }

  noteOpen(frame) {
    const asking = this.asking
    if (asking === undefined) return
    if (frame?.opened !== 'current' && frame?.opened !== 'session') return
    if (Date.now() - asking.at > ASK_ALIAS_MS) return
    this.asking = undefined
    this.alias(asking.chat, String(frame.session ?? ''))
  }

  /** @param {import('node:http').ServerResponse} res - closed SSE response. */
  unwatch(res) {
    this.watchers.delete(res)
  }

  /**
   * Ask every listening page to open this chat's tab.
   * @param {string} sessionId - chat that needs a tab.
   */
  want(sessionId) {
    const now = Date.now()
    const last = this.asked.get(sessionId)
    if (last !== undefined && now - last < ASK_GAP_MS) return
    if (this.watchers.size === 0) return
    this.asked.set(sessionId, now)
    this.asking = { chat: sessionId, at: now }
    const frame = `data: ${JSON.stringify({ type: 'wanted', session: sessionId })}\n\n`
    for (const res of this.watchers) res.write(frame)
  }

  /**
   * The page names the tab it opened, and that name is not always the id the
   * tool layer uses for this chat. One ask maps to the tab it produced.
   * @param {string} chatId - id the tool layer used.
   * @param {string} tabId - id the page reported for its tab.
   */
  alias(chatId, tabId) {
    if (chatId === '' || tabId === '' || chatId === tabId) return
    this.aliases.set(chatId, tabId)
  }

  /** @param {string} sessionId - chat asking. @returns {object | undefined} the tab that can take it. */
  seatFor(sessionId) {
    const direct = this.seats.get(sessionId)
    if (direct !== undefined) return direct
    const aliased = this.seats.get(this.aliases.get(sessionId) ?? '')
    if (aliased !== undefined) return aliased
    return this.seats.size === 1 ? [...this.seats.values()][0] : undefined
  }

  /** @param {string} sessionId - chat asking. @returns {boolean} whether a tab can take the call now. */
  hasSeat(sessionId) {
    return this.seatFor(sessionId) !== undefined
  }

  /**
   * Wait for a tab to appear after it was asked for.
   * @param {string} sessionId - chat waiting.
   * @param {number} ms - ceiling.
   * @param {AbortSignal | undefined} signal - tool cancellation.
   * @returns {Promise<boolean>} whether a tab arrived.
   */
  waitSeat(sessionId, ms, signal) {
    if (this.hasSeat(sessionId)) return Promise.resolve(true)
    if (ms <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      const done = (value) => {
        clearInterval(poll)
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }
      const poll = setInterval(() => {
        if (this.hasSeat(sessionId)) done(true)
        else if (this.refused.has(sessionId)) done(false)
      }, 120)
      poll.unref?.()
      const abort = () => done(false)
      signal?.addEventListener('abort', abort)
      setTimeout(() => done(this.hasSeat(sessionId)), ms).unref?.()
    })
  }

  /**
   * @param {string} sessionId - owning chat.
   * @param {import('node:http').ServerResponse} res - open SSE response.
   * @param {string} workspace - lease key of the chat's workspace, as the tab reports it.
   */
  attach(sessionId, res, workspace) {
    const previous = this.seats.get(sessionId)
    if (previous !== undefined && previous.res !== res) previous.res.end()
    this.seats.set(sessionId, { res, sessionId, workspace })
  }

  /**
   * Make a folder under the chat's work root, keeping it out of the project's git.
   * @param {string} base - chat's working directory.
   * @param {string} inner - folder under the work root.
   * @returns {Promise<string>} absolute folder to write into.
   */
  async room(base, inner) {
    const dir = join(base, inner)
    await mkdir(dir, { recursive: true })
    await writeFile(join(base, WORK_DIR, '.gitignore'), KEEP).catch(() => {})
    return dir
  }

  /**
   * The folder the chat works in, when its tab said so.
   * @param {string} sessionId - chat asking.
   * @returns {string | undefined} absolute folder.
   */
  cwdOf(sessionId) {
    const key = String(this.seatFor(sessionId)?.workspace ?? '')
    if (key.startsWith('cwd:') !== true) return undefined
    const dir = key.slice(4)
    return dir === '' ? undefined : dir
  }

  folderOf(sessionId) {
    try {
      const dir = String(this.hostFolder?.(sessionId) ?? '')
      return dir === '' ? undefined : dir
    } catch {
      return undefined
    }
  }

  /** @param {string} sessionId - owning chat. @param {import('node:http').ServerResponse} res - response being closed. */
  detach(sessionId, res) {
    const seat = this.seats.get(sessionId)
    if (seat !== undefined && seat.res === res) this.seats.delete(sessionId)
  }

  /** @returns {string[]} chats with a live tab. */
  connected() {
    return [...this.seats.keys()]
  }

  /**
   * Push one frame to a session's tab.
   * @param {string} sessionId - target chat.
   * @param {unknown} frame - JSON frame.
   * @returns {boolean} whether a tab received it.
   */
  push(sessionId, frame) {
    const seat = this.seatFor(sessionId)
    if (seat === undefined) return false
    seat.res.write(`data: ${JSON.stringify(frame)}\n\n`)
    return true
  }

  /**
   * Ask the guest for something and wait for the matching reply.
   * @param {string} sessionId - target chat.
   * @param {string} tool - operation name the Client understands.
   * @param {Record<string, unknown>} args - operation arguments.
   * @param {AbortSignal | undefined} signal - cancellation from the tool layer.
   * @param {number} timeoutMs - how long the operation may take.
   * @returns {Promise<unknown>} the Client's reply value.
   */
  async call(sessionId, tool, args, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.hasSeat(sessionId)) {
      this.refused.delete(sessionId)
      this.want(sessionId)
      await this.waitSeat(sessionId, this.openWaitMs, signal)
      /* A page that cannot come says so at once, instead of letting the call
         wait out the whole opening window. */
      if (!this.hasSeat(sessionId)) {
        const why = this.refused.get(sessionId)
        if (why !== undefined) throw new Error(why)
      }
    }
    try {
      return await this.attempt(sessionId, tool, args, signal, timeoutMs)
    } catch (error) {
      /* One retry after the page came back. */
      if (!String(error?.message ?? error).includes('must be attached to the DOM')) throw error
      await new Promise((resolve) => setTimeout(resolve, 600))
      return this.attempt(sessionId, tool, args, signal, timeoutMs)
    }
  }

  /**
   * One round trip to the page.
   * @param {string} sessionId - target chat.
   * @param {string} tool - operation the Client understands.
   * @param {Record<string, unknown>} args - operation arguments.
   * @param {AbortSignal | undefined} signal - cancellation from the tool layer.
   * @param {number} timeoutMs - how long the operation may take.
   * @returns {Promise<unknown>} the Client's reply value.
   */
  async attempt(sessionId, tool, args, signal, timeoutMs) {
    /* A picture comes from a painted surface, and the surface belongs to the chat
       being read. Asking for one from elsewhere would have the page show itself,
       which takes the column away from whoever is reading; the answer names the
       chat instead. */
    if (tool === 'shot' && args?.offscreen !== true) {
      const screen = typeof this.client?.frame?.session === 'string' ? this.client.frame.session : ''
      if (screen !== '' && screen !== sessionId) throw new Error(NOT_DRAWN)
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!this.push(sessionId, { type: 'call', id, tool, args, session: sessionId })) throw new Error(NO_TAB)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`the page did not finish ${tool} in time`))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.set(id, { resolve, reject, timer })
      signal?.addEventListener('abort', () => {
        const waiter = this.waiters.get(id)
        if (waiter === undefined) return
        clearTimeout(waiter.timer)
        this.waiters.delete(id)
        reject(new Error('cancelled'))
      }, { once: true })
    })
  }

  /**
   * Resolve the waiter a reply frame belongs to.
   * @param {{id?: string, ok?: boolean, value?: unknown, error?: string}} frame - reply frame.
   * @returns {boolean} whether a waiter took it.
   */
  settle(frame) {
    if (typeof frame.id !== 'string') return false
    const waiter = this.waiters.get(frame.id)
    if (waiter === undefined) return false
    this.waiters.delete(frame.id)
    clearTimeout(waiter.timer)
    if (frame.ok === false) waiter.reject(new Error(frame.error ?? 'the page refused the call'))
    else waiter.resolve(frame.value)
    return true
  }

  /** Close every seat and reject every waiter. */
  dispose() {
    for (const { res } of this.seats.values()) res.end()
    this.seats.clear()
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('plugin stopped'))
    }
    this.waiters.clear()
    for (const res of this.watchers) res.end()
    this.watchers.clear()
  }
}

/** @returns {Promise<void>} resolves once the proof line is on disk. */
async function record(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(proofLog, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`).catch(() => {})
}

/**
 * Wrap one Client operation as a tool result.
 * @param {string} text - what the model reads.
 * @returns {{text: string}} tool value.
 */
/**
 * Turn base64 into bytes without naming a global the tool context may hide.
 * @param {string} value - base64 text.
 * @returns {Uint8Array} bytes a write accepts.
 */
function decodeBase64(value) {
  const binary = atob(String(value))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function asValue(text) {
  return { text }
}


/** The largest saved file the chat reads back in the same result. */
const INLINE_BYTES = 200_000 // ui-copy-ignore
/** The longest text the chat reads back in the same result. */
const INLINE_CHARS = 6_000 // ui-copy-ignore

/**
 * Read back a saved file when it is small and holds text, so the chat can quote
 * it straight away. A picture, an archive or a big file stays on disk.
 * @param {string} file - absolute path of the saved file.
 * @returns {Promise<string>} text to append, empty when the file is not text.
 */
async function readableTail(file) {
  if (file === '') return ''
  const info = await stat(file).catch(() => undefined)
  if (info === undefined || info.isFile() !== true || info.size === 0 || info.size > INLINE_BYTES) return ''
  const raw = await readFile(file).catch(() => undefined)
  if (raw === undefined) return ''
  if (raw.subarray(0, 512).includes(0) === true) return '' // ui-copy-ignore
  const text = raw.toString('utf8')
  if (text.includes('\uFFFD') === true) return ''
  const kept = text.length > INLINE_CHARS ? `${text.slice(0, INLINE_CHARS)}\n…` : text
  return `\n\n${kept}`
}

/** @param {string | null} raw - a name the page offered. @returns {string} one safe path segment. */
function safeName(raw) {
  const flat = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const clean = flat.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 120)
  return clean === '' || clean === '.' || clean === '..' ? 'download' : clean
}

/**
 * A name the page asked for, unless the folder already holds one.
 * @param {string} dir - target folder.
 * @param {string} name - wanted file name.
 * @returns {Promise<string>} a path no other file holds.
 */
async function freePath(dir, name) {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index < 1000; index += 1) {
    const candidate = join(dir, index === 1 ? name : `${stem}-${index}${ext}`)
    if ((await stat(candidate).catch(() => undefined)) === undefined) return candidate
  }
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

/** Every tool renders as plain text, and every schema is closed. */
const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  /** @param {unknown} _args - call arguments, unused. @param {unknown} value - tool value. @returns {Array<{type: string, text: string}>} blocks. */
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}

/**
 * Build the tool definitions over one bridge.
 * @param {Bridge} bridge - the live bridge.
 * @param {Map<string, { dir: string, file: string }>} sinks - folder per live file transfer.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
function tools(bridge, sinks) {
  /**
   * Run one Client operation for the calling chat.
   * @param {string} tool - Client operation.
   * @param {unknown} args - arguments.
   * @param {any} exec - tool run context.
   * @param {number} timeoutMs - operation budget.
   * @returns {Promise<{text: string}>} rendered value.
   */
  const run = async (tool, args, exec, timeoutMs) => {
    const value = await bridge.call(String(exec.agent?.id ?? ''), tool, args ?? {}, exec.signal, timeoutMs)
    return asValue(typeof value === 'string' ? value : (value?.text ?? JSON.stringify(value ?? null)))
  }

  return [
    {
      name: 'browser_navigate', // ui-copy-ignore
      description: 'Open a URL in the sidebar browser of this chat and return the page it shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { url: { type: 'string', description: 'Absolute http or https URL.' } },
        required: ['url'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: NAVIGATE_TIMEOUT_MS + 5_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} page state. */
      execute: (args, exec) => run('navigate', args, exec, NAVIGATE_TIMEOUT_MS),
    },
    {
      name: 'browser_view', // ui-copy-ignore
      description: 'Return what the sidebar browser of this chat shows now: address, title, visible text, and numbered controls.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} page state. */
      execute: (args, exec) => run('view', args, exec, DEFAULT_TIMEOUT_MS),
    },
    {
      name: 'browser_click', // ui-copy-ignore
      description: 'Click one numbered control in the sidebar browser of this chat and return the page it leads to.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { ref: { type: 'integer', description: 'Number shown by the latest browser_view.' } },
        required: ['ref'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: NAVIGATE_TIMEOUT_MS + 5_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} page state. */
      execute: (args, exec) => run('click', args, exec, NAVIGATE_TIMEOUT_MS),
    },
    {
      name: 'browser_type', // ui-copy-ignore
      description: 'Type into one numbered field in the sidebar browser of this chat, optionally pressing Enter.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number shown by the latest browser_view.' },
          text: { type: 'string', description: 'Text to enter. Replaces the field content.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
        required: ['ref', 'text'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: NAVIGATE_TIMEOUT_MS + 5_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} page state. */
      execute: (args, exec) => run('type', args, exec, NAVIGATE_TIMEOUT_MS),
    },
    {
      name: 'browser_selection', // ui-copy-ignore
      description: 'Return the text selected in the sidebar browser of this chat, so it can be quoted here.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} the selection. */
      execute: (args, exec) => run('selection', args, exec, DEFAULT_TIMEOUT_MS),
    },
    {
      name: 'browser_copy', // ui-copy-ignore
      description: 'Copy the page selection, or one numbered control\'s text, to the clipboard so it can be pasted into this chat.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { ref: { type: 'integer', description: 'Number shown by the latest browser_view. Omit to copy the selection.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} copy result. */
      execute: (args, exec) => run('copy', args, exec, DEFAULT_TIMEOUT_MS),
    },
    {
      name: 'browser_script', // ui-copy-ignore
      description: 'Evaluate JavaScript in the sidebar browser of this chat and return its last expression. Use it when no control reaches the data you need.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { code: { type: 'string', description: 'JavaScript source. The last expression is the result.' } },
        required: ['code'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: NAVIGATE_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      /** @param {any} args - call arguments. @param {any} exec - run context. @returns {Promise<{text: string}>} result. */
      execute: (args, exec) => run('script', args, exec, NAVIGATE_TIMEOUT_MS),
    },
    {
      name: 'browser_screenshot',
      description: 'Save a PNG of what the sidebar browser of this chat shows now, and return the file path.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          offscreen: {
            type: 'boolean', // ui-copy-ignore
            description: 'Take the image without bringing this chat to the front.',
          },
        },
        additionalProperties: false,
      }, // ui-copy-ignore
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      /**
       * @param {any} args - call arguments.
       * @param {any} exec - run context.
       * @returns {Promise<{text: string}>} absolute path of the saved PNG.
       */
      execute: async (args, exec) => {
        const value = await bridge.call(
          String(exec.agent?.id ?? ''),
          'shot',
          { offscreen: args?.offscreen === true },
          exec.signal,
          DEFAULT_TIMEOUT_MS,
        )
        const png = value?.png
        if (typeof png !== 'string' || png === '') throw new Error('the page returned no image')
        const chat = String(exec.agent?.id ?? '')
        const base = bridge.cwdOf(chat) ?? exec.agent?.cwd ?? bridge.folderOf(chat) ?? process.cwd()
        const dir = await bridge.room(base, SHOT_DIR)
        const file = join(dir, `shot-${Date.now()}.png`)
        await writeFile(file, decodeBase64(png))
        return asValue(file)
      },
    },
    {
      name: 'browser_download', // ui-copy-ignore
      description: "Save a file the sidebar browser of this chat offers into this chat's project folder and return its path.",
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address of the file, when the page shows one.' },
          ref: { type: 'integer', description: 'Number shown by the latest browser_view, for a control that links to the file.' },
          name: { type: 'string', description: 'File name to save under, when the page offers none.' },
        },
        additionalProperties: false,
      }, // ui-copy-ignore
      output: TEXT_OUTPUT,
      timeoutMs: DOWNLOAD_TIMEOUT_MS + 5_000,
      isConcurrencySafe: () => false,
      /**
       * @param {any} args - call arguments.
       * @param {any} exec - run context.
       * @returns {Promise<{text: string}>} absolute path of the saved file.
       */
      execute: async (args, exec) => {
        const chat = String(exec.agent?.id ?? '')
        const base = bridge.cwdOf(chat) ?? exec.agent?.cwd ?? bridge.folderOf(chat) ?? process.cwd()
        const dir = await bridge.room(base, DOWNLOAD_DIR)
        /* The page never names a folder: this ticket is the one folder its bytes
           may reach, and it dies with the call. */
        const ticket = randomUUID() // ui-copy-ignore
        sinks.set(ticket, { dir, file: '' })
        try {
          const value = await bridge.call(
            String(exec.agent?.id ?? ''),
            'download',
            { ticket, url: args?.url, ref: args?.ref, name: args?.name },
            exec.signal,
            DOWNLOAD_TIMEOUT_MS,
          )
          const saved = typeof value === 'string' ? value : String(value?.text ?? '')
          const file = typeof value === 'object' && value !== null && typeof value.path === 'string' ? value.path : ''
          const size = typeof value === 'object' && value !== null && Number.isFinite(value.bytes) ? value.bytes : undefined
          const line = file === ''
            ? saved
            : `Saved ${file} (${size ?? (await stat(file).catch(() => undefined))?.size ?? 0} bytes)`
          /* A page that saved a readable file hands it over here as well, so the
             chat can quote it without a second trip through the machine. */
          return asValue(line + (await readableTail(file)))
        } finally {
          sinks.delete(ticket)
        }
      },
    },
    {
      name: 'browser_upload', // ui-copy-ignore
      description: 'Attach a file from this machine to one numbered file field in the sidebar browser of this chat.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number shown by the latest browser_view.' },
          path: { type: 'string', description: 'Absolute path of the file to attach.' },
        },
        required: ['ref', 'path'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: NAVIGATE_TIMEOUT_MS + 5_000,
      isConcurrencySafe: () => false,
      /**
       * @param {any} args - call arguments.
       * @param {any} exec - run context.
       * @returns {Promise<{text: string}>} page state after the attach.
       */
      execute: async (args, exec) => {
        const file = resolve(String(args.path ?? ''))
        const info = await stat(file).catch(() => undefined)
        if (info === undefined || !info.isFile()) throw new Error(`no file at ${file}`)
        if (info.size > MAX_UPLOAD_BYTES) throw new Error(`the file is ${info.size} bytes; the limit is ${MAX_UPLOAD_BYTES}`)
        const bytes = await readFile(file)
        const name = file.slice(file.lastIndexOf('/') + 1)
        const value = await bridge.call(
          String(exec.agent?.id ?? ''),
          'upload',
          { ref: args.ref, name, type: mediaType(file), base64: bytes.toString('base64') },
          exec.signal,
          NAVIGATE_TIMEOUT_MS,
        )
        return asValue(typeof value === 'string' ? value : String(value?.text ?? ''))
      },
    },
  ]
}

export const name = 'dsh-inner-browser-use'
export const inject = ['webServer']

/**
 * Mount the bridge and the tool surface.
 * @param {any} ctx - plugin context.
 * @param {{ proofLog?: string }} [config] - optional overrides.
 */
export function apply(ctx, config = {}) {
  if (typeof config.proofLog === 'string' && config.proofLog !== '') proofLog = config.proofLog
  const bridge = new Bridge()
  /** @type {Map<string, { dir: string, file: string }>} */
  const sinks = new Map()
  /* Files a page saved on its own: one row per transfer, gone when the bytes are in. */
  const landings = new Map()
  if (Number.isInteger(config.openWaitMs)) bridge.openWaitMs = config.openWaitMs
  ctx.effect(() => () => bridge.dispose(), 'dsh-inner-browser-use: bridge lifetime')
  /* Each chat works in a folder the app already knows; asking it is cheaper
     than waiting for the page to say so. */
  bridge.hostFolder = (chat) => {
    try {
      const session = ctx.get('sessions')?.get?.(chat)
      if (session === undefined || session === null) return undefined
      const dir = String(ctx.get('workingDirectory')?.get?.(session) ?? '')
      return dir === '' ? undefined : dir
    } catch {
      return undefined
    }
  }

  /** @param {import('node:http').IncomingMessage} req - request. @param {import('node:http').ServerResponse} res - response. */
  const handler = async (req, res) => {
    const url = new URL(req.url ?? ROUTE, 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const sessionId = url.searchParams.get('session') ?? ''

    if (path === '/downlink' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      bridge.attach(sessionId, res, url.searchParams.get('workspace') ?? '')
      res.write(`data: ${JSON.stringify({ type: 'hello', session: sessionId, at: Date.now() })}\n\n`)
      void record({ kind: 'downlink-open', session: sessionId, origin: req.headers.origin ?? null })
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
      beat.unref?.()
      const close = () => {
        clearInterval(beat)
        bridge.detach(sessionId, res)
        void record({ kind: 'downlink-close', session: sessionId })
      }
      req.on('close', close)
      res.on('error', close)
      return
    }

    if (path === '/watch' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      bridge.watch(res)
      res.write(`data: ${JSON.stringify({ type: 'watch-alive', at: Date.now() })}\n\n`)
      void record({ kind: 'watch-open' })
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
      beat.unref?.()
      const close = () => {
        clearInterval(beat)
        bridge.unwatch(res)
      }
      req.on('close', close)
      res.on('error', close)
      return
    }

    if (path === '/uplink' && req.method === 'POST') {
      let frame
      try {
        frame = JSON.parse(await readBody(req))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(String(error?.message ?? error))
        return
      }
      await record({ kind: 'uplink', session: sessionId, frame })
      if (frame?.type === 'client-alive') {
      bridge.client = { ms: Date.now(), frame }
      bridge.noteOpen(frame)
      bridge.noteStep(frame)
    }
      bridge.settle(frame)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, epoch: bridge.epoch }))
      return
    }

    if (path === '/push' && req.method === 'POST') {
      let frame
      try {
        frame = JSON.parse(await readBody(req))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(String(error?.message ?? error))
        return
      }
      const delivered = bridge.push(sessionId, frame)
      res.writeHead(delivered ? 200 : 409, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ delivered }))
      return
    }

    if (path === '/cookies' && (req.method === 'GET' || req.method === 'POST')) {
      const key = url.searchParams.get('key') ?? ''
      if (key === '') {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('key required')
        return
      }
      if (req.method === 'GET') {
        const cookies = await readCookies(key)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cookies }))
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(String(error?.message ?? error))
        return
      }
      const kept = await writeCookies(key, body?.cookies)
      await record({ kind: 'cookies', at: new Date().toISOString(), kept })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ kept }))
      return
    }

    if (path === '/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        connected: bridge.connected(),
        pending: bridge.waiters.size,
        client: clientState(bridge.client),
        /* Where a chat's files would land, when its tab told us the folder. */
        folders: Object.fromEntries(bridge.connected().map((chat) => [chat, bridge.cwdOf(chat) ?? bridge.folderOf(chat) ?? ''])),
        /* Lets a page that is still running an older bundle replace itself. */
        clientBuild: clientBuild(),
      }))
      return
    }

    if (path === '/grab' && req.method === 'POST') {
      const sink = sinks.get(url.searchParams.get('ticket') ?? '')
      if (sink === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('unknown transfer')
        return
      }
      const offset = Number(url.searchParams.get('offset') ?? '0')
      if (sink.file === '') sink.file = await freePath(sink.dir, safeName(url.searchParams.get('name')))
      const stream = createWriteStream(sink.file, { flags: offset > 0 ? 'a' : 'w' })
      try {
        await new Promise((settle, fail) => {
          stream.on('finish', settle)
          stream.on('error', fail)
          req.on('error', fail)
          req.pipe(stream)
        })
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error?.message ?? error))
        return
      }
      const info = await stat(sink.file)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: sink.file, bytes: info.size }))
      return
    }

    if (path === '/land' && req.method === 'POST') {
      /* A file the page saved on its own, written where that chat works. The
         header keeps another site out; the chat names the folder it works in. */
      if (req.headers['x-dshib-land'] !== '1') {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      const chat = url.searchParams.get('session') ?? ''
      const id = url.searchParams.get('id') ?? ''
      const offset = Number(url.searchParams.get('offset') ?? '0')
      let landing = landings.get(id)
      if (landing === undefined) {
        const base = bridge.cwdOf(chat) ?? bridge.folderOf(chat) ?? process.cwd()
        const dir = await bridge.room(base, DOWNLOAD_DIR)
        landing = { dir, file: await freePath(dir, safeName(url.searchParams.get('name'))) }
        landings.set(id, landing)
        if (landings.size > 32) {
          const oldest = landings.keys().next()
          if (oldest.done !== true) landings.delete(oldest.value)
        }
      }
      const stream = createWriteStream(landing.file, { flags: offset > 0 ? 'a' : 'w' })
      try {
        await new Promise((settle, fail) => {
          stream.on('finish', settle)
          stream.on('error', fail)
          req.on('error', fail)
          req.pipe(stream)
        })
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(error?.message ?? error))
        return
      }
      const info = await stat(landing.file)
      if (url.searchParams.get('final') === '1') landings.delete(id)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: landing.file, bytes: info.size }))
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  /* The page compares this with what it last loaded: a page still running an
     older bundle reloads itself once instead of waiting for a manual refresh. */
  const clientFile = join(dirname(fileURLToPath(import.meta.url)), 'client.js')
  let buildMark = ''
  let buildStamp = -1
  const clientBuild = () => {
    try {
      const stamp = statSync(clientFile).mtimeMs
      if (stamp === buildStamp && buildMark !== '') return buildMark
      buildMark = createHash('sha256').update(readFileSync(clientFile)).digest('hex').slice(0, 16)
      buildStamp = stamp
    } catch {
      buildMark = buildMark === '' ? 'unknown' : buildMark
    }
    return buildMark
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-inner-browser-use: bridge route')

  ctx.inject(['tools'], (scope) => {
    const disposers = tools(bridge, sinks).map((definition) => scope.tools.register(definition))
    scope.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-inner-browser-use: tool surface')
  })

  ctx.logger?.info?.('dsh-inner-browser-use: bridge on %s', ROUTE)
}
