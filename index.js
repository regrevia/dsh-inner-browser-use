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

/** Route prefix owned by this plugin. Never under `/api`, which is the Host's own channel. */ // ui-copy-ignore
export const ROUTE = '/dsh-inner-browser-use'

/** Largest uplink frame accepted. Frames are DOM observations, not screenshots. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** How long one page operation may take before the Host gives up on it. */ // ui-copy-ignore
const DEFAULT_TIMEOUT_MS = 25_000

/** Navigation waits on the page itself, which is slower than reading it. */
const NAVIGATE_TIMEOUT_MS = 60_000

/** Shown when a tool runs without the tab that owns the guest. */
const NO_TAB = 'This chat has no 内置浏览器 tab open. Open it in the right sidebar, then call again.'

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
class Bridge {
  constructor() {
    /** @type {Map<string, {res: import('node:http').ServerResponse, sessionId: string}>} */
    this.seats = new Map()
    /** @type {Map<string, {resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
    this.waiters = new Map()
    /** @type {{at: string, frame: unknown} | undefined} */
    this.client = undefined
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
    const seat = this.seats.get(sessionId) ?? (this.seats.size === 1 ? [...this.seats.values()][0] : undefined)
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
  call(sessionId, tool, args, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    if (!this.push(sessionId, { type: 'call', id, tool, args })) return Promise.reject(new Error(NO_TAB))
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
      if (frame?.type === 'client-alive') bridge.client = { at: new Date().toISOString(), frame }
      bridge.settle(frame)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
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
      res.end(JSON.stringify({ connected: bridge.connected(), pending: bridge.waiters.size, client: bridge.client }))
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
