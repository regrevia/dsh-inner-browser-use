/**
 * dsh-inner-browser-use — host half. // ui-copy-ignore
 *
 * The browser this plugin drives is its own Chrome: a real process, started // ui-copy-ignore
 * with a profile directory outside the Host, so logins outlive a plugin // ui-copy-ignore
 * reload and a Host restart. The Host owns it and drives it over the DevTools // ui-copy-ignore
 * protocol, so a tool works whether or not a chat is on screen. // ui-copy-ignore
 *
 * The Client never touches that Chrome. It opens one server-sent event stream
 * of JPEG frames and posts input back:
 *
 * - `GET  /sidecar/frames` — the mirror, plus pointer messages; // ui-copy-ignore
 * - `GET  /sidecar/state` — what the browser is; // ui-copy-ignore
 * - `POST /sidecar/open` — start or reuse it, and ask for the tab; // ui-copy-ignore
 * - `POST /sidecar/input` — mouse, wheel, text and keys; // ui-copy-ignore
 * - `POST /sidecar/nav` — address, back, forward, reload; // ui-copy-ignore
 * - `POST /sidecar/stop` — close the browser and keep the profile. // ui-copy-ignore
 *
 * Every route is same-origin through the product document, so the Client
 * learns no port and no secret. // ui-copy-ignore
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { Sidecar, VIEW } from './sidecar.js?v=1'

/** Route prefix owned by this plugin. Never under `/api`, which is the Host's own channel. */ // ui-copy-ignore
export const ROUTE = '/dsh-inner-browser-use'

/** Largest request body accepted. */
const MAX_BODY_BYTES = 1024 * 1024

/** Where a screenshot from `sidecar_shot` lands, under the user's home. */
const SHOT_DIR = join('.dsh-inner-browser-use', 'screenshots')

/** Shown when the sidecar has never been started in this run. */
const SIDECAR_OFF = 'The sidecar browser is not running. Call sidecar_open with the address first.'

/**
 * Read a request body with a hard ceiling.
 * @param {import('node:http').IncomingMessage} req - request carrying the frame.
 * @returns {Promise<string>} decoded body.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
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
 * One Client connection per chat: the tab that receives pushes for it.
 * Nothing else lives here; the browser itself is the Host's. // ui-copy-ignore
 */
export class Bridge {
  constructor() {
    /** @type {Map<string, import('node:http').ServerResponse>} */
    this.seats = new Map()
  }

  /**
   * Take the chat's event stream.
   * @param {string} sessionId - chat the tab belongs to.
   * @param {import('node:http').ServerResponse} res - open SSE response.
   */
  attach(sessionId, res) {
    this.seats.get(sessionId)?.end()
    this.seats.set(sessionId, res)
  }

  /**
   * Drop a stream when its chat or its tab goes away.
   * @param {string} sessionId - chat the tab belonged to.
   * @param {import('node:http').ServerResponse} res - response being closed.
   */
  detach(sessionId, res) {
    if (this.seats.get(sessionId) === res) this.seats.delete(sessionId)
  }

  /**
   * Push one frame to a chat's tab.
   * @param {string} sessionId - target chat.
   * @param {unknown} frame - JSON frame.
   * @returns {boolean} whether a tab received it.
   */
  push(sessionId, frame) {
    const seat = this.seats.get(sessionId)
    if (seat === undefined) return false
    seat.write(`data: ${JSON.stringify(frame)}\n\n`)
    return true
  }

  /** @returns {string[]} chats with a live tab. */
  connected() {
    return [...this.seats.keys()]
  }

  /** Close every stream. */
  dispose() {
    for (const res of this.seats.values()) res.end()
    this.seats.clear()
  }
}

/** Page read: address, title, controls, then text, as JSON the Host parses. */ // ui-copy-ignore
const SNAPSHOT = `(() => {
  const text = (el) => String(el.innerText ?? el.value ?? el.getAttribute?.('aria-label') ?? el.getAttribute?.('placeholder') ?? '').replace(/\\s+/g, ' ').trim()
  const visible = (el) => {
    const box = el.getBoundingClientRect()
    if (box.width < 2 || box.height < 2) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05
  }
  const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]'))
  const controls = []
  for (const el of nodes) {
    if (controls.length >= 120) break
    if (!visible(el)) continue
    const label = text(el)
    if (label === '') continue
    const box = el.getBoundingClientRect()
    controls.push({
      tag: el.tagName.toLowerCase(),
      type: String(el.getAttribute?.('type') ?? ''),
      text: label.slice(0, 120),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    })
  }
  const main = document.querySelector('main, article, [role="main"]') ?? document.body
  return JSON.stringify({
    url: location.href,
    title: document.title,
    text: String(main?.innerText ?? '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 8000),
    controls,
  })
})()`

/**
 * Read the sidecar's page.
 * @param {import('./sidecar.js').SidecarPage} page - the driven page.
 * @returns {Promise<{url: string, title: string, text: string, controls: any[]}>} what it shows.
 */
async function readSidecar(page) {
  const { result } = await page.cdp.send('Runtime.evaluate', { expression: SNAPSHOT, returnByValue: true, awaitPromise: true })
  const parsed = JSON.parse(String(result?.value ?? '{"url":"","title":"","text":"","controls":[]}'))
  return {
    url: String(parsed.url ?? page.url),
    title: String(parsed.title ?? page.title),
    text: String(parsed.text ?? ''),
    controls: Array.isArray(parsed.controls) ? parsed.controls : [],
  }
}

/**
 * Render a page read the way the product's own browser read looks: address,
 * title, numbered controls, then the text.
 * @param {{url: string, title: string, text: string, controls: any[]}} read - page read.
 * @returns {string} the value a model sees.
 */
function renderSidecar(read) {
  const lines = [`${read.url}`, read.title === '' ? '' : `# ${read.title}`].filter((line) => line !== '')
  read.controls.forEach((control, index) => {
    const name = control.tag === 'input' && control.type !== '' ? `input:${control.type}` : control.tag
    lines.push(`${index + 1} [${name}] ${control.text}`)
  })
  lines.push('', read.text)
  return lines.join('\n').slice(0, 12_000)
}

/** Every tool returns one line of text, so the model reads a page, not JSON. */
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

/** Real key codes: a page that only listens for a code never sees zero. */
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
}

/**
 * One key press with the codes a page expects.
 * @param {import('./sidecar.js').SidecarPage} page - the driven page.
 * @param {string} name - key name.
 * @returns {Promise<void>} resolves once released.
 */
async function pressKey(page, name) {
  const known = KEYS[name]
  const spec = { key: name, code: known?.code ?? name, keyCode: known?.keyCode ?? 0 }
  await page.key('keyDown', { ...spec, text: known?.text })
  await page.key('keyUp', { ...spec, text: undefined })
}

/**
 * The tool surface. These run entirely on the Host: the page is a real Chrome // ui-copy-ignore
 * process, so no chat has to be on screen for them to work.
 * @param {Sidecar} sidecar - the Host's Chrome. // ui-copy-ignore
 * @param {{ refs: any[], at: number }} refs - controls of the last read.
 * @param {{ want?: (sessionId: string) => void }} host - ways back into the chat. // ui-copy-ignore
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
function sidecarTools(sidecar, refs, host = {}) { // ui-copy-ignore
  /**
   * @param {(page: import('./sidecar.js').SidecarPage) => Promise<string>} job - work on the page.
   * @returns {Promise<{text: string}>} rendered value.
   */
  const withPage = async (job) => {
    const page = await sidecar.ensure()
    return { text: await job(page) }
  }
  /** @returns {Promise<{text: string}>} the new page. */
  const view = async () => withPage(async (page) => {
    const read = await readSidecar(page)
    refs.refs = read.controls
    refs.at = Date.now()
    return renderSidecar(read)
  })
  return [
    {
      name: 'sidecar_open', // ui-copy-ignore
      description: 'Start (or reuse) the sidecar browser — a real Chrome with its own persistent profile — and open a URL in it. It runs in the background and its screen appears in this chat\'s sidebar tab, so it keeps working while the person looks elsewhere. Logins survive restarts.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open. Omit to reuse whatever the sidecar shows.' },
          headless: { type: 'boolean', description: 'Run without a window. Default true; turn off only if a site refuses a windowless browser.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @param {any} exec - tool run. @returns {Promise<{text: string}>} page read. */
      execute: async (args, exec) => {
        const page = await sidecar.ensure({ url: args?.url, headless: args?.headless })
        if (args?.url === undefined) await page.readTitle()
        /* The tab appears in the calling chat and nowhere else: the person may
           be reading a different chat, and a browser there would be a surprise. */
        const who = String(exec?.agent?.id ?? '')
        if (who !== '') host.want?.(who) // ui-copy-ignore
        return view()
      },
    },
    {
      name: 'sidecar_view', // ui-copy-ignore
      description: 'Return what the sidecar browser shows now: address, title, numbered controls and the visible text. Numbers are valid until the next read of this page.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 25_000,
      isConcurrencySafe: () => false,
      /** @returns {Promise<{text: string}>} page read. */
      execute: async () => {
        if (!sidecar.alive) return { text: SIDECAR_OFF }
        return view()
      },
    },
    {
      name: 'sidecar_click', // ui-copy-ignore
      description: 'Click a numbered control (or a point) in the sidecar browser. The click is real mouse input, and the sidebar mirror shows the pointer where it landed.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from the latest sidecar_view.' },
          x: { type: 'integer', description: 'Viewport x, if clicking a point instead of a control.' },
          y: { type: 'integer', description: 'Viewport y, if clicking a point instead of a control.' },
          double: { type: 'boolean', description: 'Double-click.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} page read. */
      execute: async (args) => withPage(async (page) => {
        let point = { x: Number(args?.x ?? NaN), y: Number(args?.y ?? NaN) }
        if (args?.ref !== undefined) {
          if (refs.refs.length === 0) return `${SIDECAR_OFF}\nCall sidecar_view first; a number means nothing without a read.`
          const control = refs.refs[Number(args.ref) - 1]
          if (control === undefined) return `No control ${String(args.ref)} on this page. Call sidecar_view for the current numbers.`
          point = { x: control.x, y: control.y }
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'Give a ref from sidecar_view, or both x and y.'
        await page.mouse('mouseMoved', point)
        await page.mouse('mousePressed', { ...point, clickCount: args?.double === true ? 2 : 1 })
        await page.mouse('mouseReleased', { ...point, clickCount: args?.double === true ? 2 : 1 })
        await new Promise((settle) => setTimeout(settle, 350))
        const read = await readSidecar(page)
        refs.refs = read.controls
        refs.at = Date.now()
        return renderSidecar(read)
      }),
    },
    {
      name: 'sidecar_type', // ui-copy-ignore
      description: 'Type text into the sidecar browser — Chinese included — optionally pressing Enter. Pass a control number to focus it first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          ref: { type: 'integer', description: 'Control to click before typing.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
        },
        required: ['text'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} page read. */
      execute: async (args) => withPage(async (page) => {
        if (args?.ref !== undefined) {
          const control = refs.refs[Number(args.ref) - 1]
          if (control === undefined) return `No control ${String(args.ref)} on this page. Call sidecar_view for the current numbers.`
          await page.mouse('mouseMoved', { x: control.x, y: control.y })
          await page.mouse('mousePressed', { x: control.x, y: control.y, clickCount: 1 })
          await page.mouse('mouseReleased', { x: control.x, y: control.y, clickCount: 1 })
          await new Promise((settle) => setTimeout(settle, 150))
        }
        await page.insertText(String(args?.text ?? ''))
        if (args?.submit === true) await pressKey(page, 'Enter')
        await new Promise((settle) => setTimeout(settle, 500))
        const read = await readSidecar(page)
        refs.refs = read.controls
        refs.at = Date.now()
        return renderSidecar(read)
      }),
    },
    {
      name: 'sidecar_key', // ui-copy-ignore
      description: 'Press one key in the sidecar browser: Enter, Tab, Escape, Backspace, or ArrowDown/ArrowUp/PageDown/PageUp/Home/End.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { key: { type: 'string', description: 'Key name.' } },
        required: ['key'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} page read. */
      execute: async (args) => withPage(async (page) => {
        await pressKey(page, String(args?.key ?? 'Enter'))
        await new Promise((settle) => setTimeout(settle, 250))
        const read = await readSidecar(page)
        refs.refs = read.controls
        return renderSidecar(read)
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
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} page read. */
      execute: async (args) => withPage(async (page) => {
        await page.wheel({ x: Number(args?.x ?? VIEW.width / 2), y: Number(args?.y ?? VIEW.height / 2), dy: Number(args?.dy ?? 600) })
        await new Promise((settle) => setTimeout(settle, 350))
        const read = await readSidecar(page)
        refs.refs = read.controls
        return renderSidecar(read)
      }),
    },
    {
      name: 'sidecar_shot', // ui-copy-ignore
      description: 'Save a full-size PNG screenshot of the sidecar browser into the session folder and return its absolute path.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { name: { type: 'string', description: 'File name without extension.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the saved path. */
      execute: async (args) => withPage(async (page) => {
        const data = await page.screenshot()
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const name = String(args?.name ?? '').replace(/[^\w.-]/g, '') || `sidecar-${Date.now()}`
        const file = join(dir, name.endsWith('.png') ? name : `${name}.png`)
        await writeFile(file, Buffer.from(data, 'base64'))
        return file
      }),
    },
    {
      name: 'sidecar_state', // ui-copy-ignore
      description: 'Report the sidecar browser: whether it runs, its profile, address, title, and how many people are watching its mirror.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} the state. */
      execute: async () => {
        const state = await sidecar.state()
        const rows = [
          state.alive ? `running · ${String(state.headless) === 'true' ? 'headless' : 'windowed'}` : 'stopped',
          `profile ${String(state.profile)}`,
          `url ${String(state.url)}`,
          `title ${String(state.title)}`,
          `viewers ${String(state.viewers)}`,
        ]
        return { text: rows.join('\n') }
      },
    },
  ]
}

export const name = 'dsh-inner-browser-use'
export const inject = ['webServer']

/**
 * Mount the mirror routes and the tool surface.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  const bridge = new Bridge()
  /* The sidecar is a browser the Host owns outright: a real Chrome with its own // ui-copy-ignore
     profile, shown in the column as a screencast. It outlives a plugin reload,
     and it does not need the chat to be on screen to do work. */
  const sidecar = new Sidecar({ logger: ctx.logger })
  /** @type {{refs: any[], at: number}} */
  const sidecarRefs = { refs: [], at: 0 }
  ctx.effect(() => () => bridge.dispose(), 'dsh-inner-browser-use: bridge lifetime')

  /** @param {import('node:http').IncomingMessage} req - request. @param {import('node:http').ServerResponse} res - response. */
  const handler = async (req, res) => {
    const url = new URL(req.url ?? ROUTE, 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const sessionId = url.searchParams.get('session') ?? ''

    /** @param {number} code - status. @param {unknown} value - body. */
    const json = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }

    if (path === '/sidecar/frames' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.socket?.setNoDelay?.(true)
      res.write('retry: 2000\n\n')
      /** @type {() => void} */
      let detach = () => {}
      const drop = () => detach()
      req.on('close', drop)
      res.on('error', drop)
      try {
        detach = await sidecar.watch((frame) => {
          /* A viewer that cannot keep up loses frames instead of making the
             page wait: the newest picture is the only one worth sending. */
          if (res.writableLength > 3 * 1024 * 1024) return
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        })
        const info = await sidecar.state()
        res.write(`data: ${JSON.stringify({ type: 'hello', ...info })}\n\n`)
      } catch (error) {
        res.write(`data: ${JSON.stringify({ type: 'failed', text: String(error?.message ?? error) })}\n\n`)
      }
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
      beat.unref?.()
      req.on('close', () => clearInterval(beat))
      return
    }

    if (path === '/sidecar/state' && req.method === 'GET') {
      json(200, await sidecar.state())
      return
    }

    if (path === '/sidecar/open' && req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        body = {}
      }
      try {
        const address = String(body.url ?? '')
        const who = String(body.session ?? sessionId)
        await sidecar.ensure({
          url: address === '' ? undefined : address,
          headless: body.headless === undefined ? undefined : body.headless === true,
        })
        /* The mirror belongs to the chat that asked for it, and only while
           that chat is the one on screen. */
        if (who !== '') bridge.push(who, { type: 'sidecar-wanted', session: who })
        json(200, { ok: true, ...(await sidecar.state()) })
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/input' && req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(400, { ok: false, text: 'bad frame' })
        return
      }
      try {
        const page = await sidecar.ensure()
        const kind = String(body.kind ?? '')
        const x = Number(body.x ?? 0)
        const y = Number(body.y ?? 0)
        let cursor
        if (kind === 'hover') cursor = await page.hover({ x, y })
        else if (kind === 'move') await page.mouse('mouseMoved', { x, y })
        else if (kind === 'click') {
          const clickCount = body.double === true ? 2 : 1
          await page.mouse('mouseMoved', { x, y })
          await page.mouse('mousePressed', { x, y, clickCount })
          await page.mouse('mouseReleased', { x, y, clickCount })
          if (body.double === true) {
            await page.mouse('mousePressed', { x, y, clickCount: 2 })
            await page.mouse('mouseReleased', { x, y, clickCount: 2 })
          }
        } else if (kind === 'wheel') await page.wheel({ x, y, dx: Number(body.dx ?? 0), dy: Number(body.dy ?? 0) })
        else if (kind === 'text') await page.insertText(String(body.text ?? ''))
        else if (kind === 'key') {
          const name = String(body.key ?? '')
          const known = KEYS[name]
          const spec = {
            key: name,
            code: String(body.code ?? known?.code ?? name),
            keyCode: Number(body.keyCode ?? 0) || known?.keyCode || 0,
            text: body.text === undefined ? known?.text : String(body.text),
            modifiers: Number(body.modifiers ?? 0),
          }
          await page.key('keyDown', spec)
          await page.key('keyUp', { ...spec, text: undefined })
        }
        json(200, cursor === undefined ? { ok: true } : { ok: true, cursor })
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/nav' && req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(400, { ok: false, text: 'bad frame' })
        return
      }
      try {
        const page = await sidecar.ensure()
        const op = String(body.op ?? 'goto')
        if (op === 'reload') json(200, { ok: true, ...(await page.reload()) })
        else if (op === 'back') json(200, { ok: true, ...(await page.history(-1)) })
        else if (op === 'forward') json(200, { ok: true, ...(await page.history(1)) })
        else {
          const address = String(body.url ?? '')
          const withScheme = /^[a-z]+:/i.test(address) ? address : `https://${address}`
          json(200, { ok: true, ...(await page.navigate(withScheme)) })
        }
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/stop' && req.method === 'POST') {
      await sidecar.shutdown()
      json(200, { ok: true })
      return
    }

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
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
      beat.unref?.()
      const close = () => {
        clearInterval(beat)
        bridge.detach(sessionId, res)
      }
      req.on('close', close)
      res.on('error', close)
      return
    }

    json(404, { ok: false, text: 'no such route' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-inner-browser-use: mirror route')

  ctx.inject(['tools'], (scope) => {
    const disposers = sidecarTools(sidecar, sidecarRefs, {
      want: (sessionId) => bridge.push(sessionId, { type: 'sidecar-wanted', session: sessionId }),
    }).map((definition) => scope.tools.register(definition))
    scope.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-inner-browser-use: tool surface')
  })

  const prompt = ctx.get?.('systemPrompt')
  if (prompt && typeof prompt.section === 'function') {
    ctx.effect(() => prompt.section({
      name: 'browser-in-this-chat',
      order: 858,
      text: [
        '## 网页任务：用 sidecar 浏览器做，不问直接开始',
        '',
        '人说「用网页端 / 在浏览器里 / 打开某个网站 / 帮我上 ChatGPT 生成 …」时，直接用 `sidecar_*` 工具；不要问要不要打开，也不要另起一个外部 Chrome。它的画面会出现在本会话右栏，做完保留，不主动关。',
        '先接着用已有的页：`sidecar_view`（拿编号控件与可见文字）→ `sidecar_click` / `sidecar_type` → 再 `sidecar_view` 直到出现要的结果；页面要等就重复读，不 sleep。`sidecar_open` 只用于没有页、要换新地址、或要明确刷新；同一个地址不要反复重开。',
        '要保存页面样子用 `sidecar_shot`，它会给出 PNG 绝对路径；要交给人看的文件，把绝对路径写进回复。',
      ].join('\n'),
    }), 'dsh-inner-browser-use: system prompt section')
  }

  ctx.logger?.info?.('dsh-inner-browser-use: mirror on %s', ROUTE)
}
