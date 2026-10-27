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

import { Sidecar } from './sidecar.js?v=1'

/** Route prefix owned by this plugin. Never under `/api`, which is the Host's own channel. */ // ui-copy-ignore
export const ROUTE = '/dsh-inner-browser-use'

/** Largest request body accepted. */
const MAX_BODY_BYTES = 1024 * 1024

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
    /* The one chat that owns the mirror. The column is global, so the picture
       may only ever be drawn for this chat; every other chat shows a note. */
    this.owner = ''
  }

  /**
   * Give the mirror to one chat and take it away from every earlier one.
   * @param {string} sessionId - chat that asked for it.
   */
  claim(sessionId) {
    if (sessionId !== '') this.owner = sessionId
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
/* The read model and the tool surface live in their own files: this module is
   the Host half (routes, bridge, lifetimes), not the model's vocabulary. */ // ui-copy-ignore
import { sidecarTools } from './tools.js?v=1'

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
  /** @type {{refs: any[], at: number, last?: any}} */
  const sidecarRefs = { refs: [], at: 0 }
  ctx.effect(() => () => bridge.dispose(), 'dsh-inner-browser-use: bridge lifetime')
  /* Closing the browser cleanly on quit is what keeps a sign-in alive: a
     killed Chrome never writes the cookies a page set this minute. */
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!sidecar.alive) return
      void sidecar.saveSessionCookies()
    }, 60_000)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      void sidecar.shutdown().catch(() => {})
    }
  }, 'dsh-inner-browser-use: sidecar lifetime')

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
      /* The column is global and only one chat may hold the mirror: a chat that
         does not own it is refused here, so a stale tab cannot stream a picture
         of somebody else's browser. */
      if (bridge.owner !== '' && sessionId !== bridge.owner) {
        json(403, { ok: false, text: 'this chat does not own the browser', owner: bridge.owner })
        return
      }
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
      json(200, { ...(await sidecar.state()), owner: bridge.owner })
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
        /* The ask must name the chat it belongs to: a request that cannot say
           who it is for never gets the mirror. */
        const who = String(body.session ?? '')
        if (who === '') {
          json(400, { ok: false, text: 'which chat asked for it' })
          return
        }
        await sidecar.ensure({
          url: address === '' ? undefined : address,
          headless: body.headless === undefined ? undefined : body.headless === true,
        })
        /* The mirror belongs to the chat that asked for it; any earlier owner
           loses it and its tab. */
        bridge.claim(who)
        bridge.push(who, { type: 'sidecar-wanted', session: who })
        json(200, { ok: true, ...(await sidecar.state()), owner: bridge.owner })
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
      /* Input follows the owner: a chat that lost the mirror cannot act on the
         page from a stale tab either. */
      if (body.session !== undefined && String(body.session) !== '' && bridge.owner !== '' && String(body.session) !== bridge.owner) {
        json(403, { ok: false, text: 'this chat does not own the browser', owner: bridge.owner })
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
      /* Navigation follows the owner too: a lost tab cannot steer the page. */
      if (body.session !== undefined && String(body.session) !== '' && bridge.owner !== '' && String(body.session) !== bridge.owner) {
        json(403, { ok: false, text: 'this chat does not own the browser', owner: bridge.owner })
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
      /* The mirror changes hands here: the calling chat owns it from now on,
         and every earlier owner loses it. */
      want: (sessionId) => {
        bridge.claim(sessionId)
        bridge.push(sessionId, { type: 'sidecar-wanted', session: sessionId })
      },
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
