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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Where screenshots land inside the chat's working directory. */
const SHOT_DIR = '.dsh-inner-browser-use'

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

/** How long a tool waits for the tab it asked for. */
const OPEN_WAIT_MS = 8_000

/** Shown when a tool runs without the tab that owns the guest. */
const ASK_GAP_MS = 3_000
const CLIENT_TTL_MS = 60_000
const ASK_ALIAS_MS = 30_000
const NO_TAB = 'No 内置浏览器 tab answered. Open it in the right sidebar from the tab strip, then call again.'

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
      }, 120)
      poll.unref?.()
      const abort = () => done(false)
      signal?.addEventListener('abort', abort)
      setTimeout(() => done(this.hasSeat(sessionId)), ms).unref?.()
    })
  }

  /** @param {string} sessionId - owning chat. @param {import('node:http').ServerResponse} res - open SSE response. */
  attach(sessionId, res) {
    const previous = this.seats.get(sessionId)
    if (previous !== undefined && previous.res !== res) previous.res.end()
    this.seats.set(sessionId, { res, sessionId })
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
      this.want(sessionId)
      await this.waitSeat(sessionId, this.openWaitMs, signal)
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
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
function tools(bridge) {
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
        const dir = join(exec.agent?.cwd ?? process.cwd(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const file = join(dir, `shot-${Date.now()}.png`)
        await writeFile(file, decodeBase64(png))
        return asValue(file)
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
  if (Number.isInteger(config.openWaitMs)) bridge.openWaitMs = config.openWaitMs
  ctx.effect(() => () => bridge.dispose(), 'dsh-inner-browser-use: bridge lifetime')

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
      bridge.attach(sessionId, res)
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

    if (path === '/state' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ connected: bridge.connected(), pending: bridge.waiters.size, client: clientState(bridge.client) }))
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-inner-browser-use: bridge route')

  ctx.inject(['tools'], (scope) => {
    const disposers = tools(bridge).map((definition) => scope.tools.register(definition))
    scope.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-inner-browser-use: tool surface')
  })

  ctx.logger?.info?.('dsh-inner-browser-use: bridge on %s', ROUTE)
}
