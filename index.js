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

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Sidecar } from './sidecar.js?v=1'

/** Where the mirror's owner is remembered across a reload: the column should not go dark because the code reloaded. */
/** Where the mirror's note lives; a test points this elsewhere so it never reads a real chat. */
const STATE_DIR = process.env.DSH_INNER_BROWSER_STATE_DIR || join(homedir(), '.dsh', 'inner-browser-use')
const MIRROR_FILE = join(STATE_DIR, 'mirror.json')

/** @returns {{owner: string, session: string, at: number}} the last owner a chat asked to keep. */
function readMirror() {
  try {
    const saved = JSON.parse(readFileSync(MIRROR_FILE, 'utf8'))
    return { owner: String(saved?.owner ?? ''), session: String(saved?.session ?? ''), at: Number(saved?.at ?? 0) }
  } catch {
    return { owner: '', session: '', at: 0 }
  }
}

/** @param {{owner: string, session: string, at: number}} value - what to keep. */
function writeMirror(value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(MIRROR_FILE, JSON.stringify(value))
  } catch {
    /* an unwritable note must not take the mirror down */
  }
}

/** The note stops growing: past this size the oldest half goes, so a long-lived run never fills the disk. */
const NOTES_MAX = 256 * 1024
const NOTES_KEEP = 128 * 1024

/**
 * Add one line to the mirror's own note, keeping the file bounded.
 * @param {string} line - what happened, one line.
 */
export function note(line) {
  const file = join(STATE_DIR, 'asks.log')
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    if (statSync(file).size <= NOTES_MAX) return
    const whole = readFileSync(file, 'utf8')
    writeFileSync(file, whole.slice(whole.length - NOTES_KEEP).replace(/^[^\n]*\n/, ''))
  } catch {
    /* a note that cannot be written must not take the mirror down */
  }
}

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
  /** @param {{persist?: boolean}} [options] - persist the owner across reloads. */
  constructor(options = {}) {
    /** @type {Map<string, import('node:http').ServerResponse>} */
    this.seats = new Map()
    /* The one chat that owns the mirror. The column is global, so the picture
       may only ever be drawn for this chat; every other chat shows a note. */
    this.owner = ''
    /* The tab asked for, kept until the chat comes back into view. A chat that
       is not on screen has no stream, so a push at ask time is lost; remembering
       the ask is what makes the mirror appear when the person returns. */
    this.wanted = { session: '', at: 0 }
    /* A running plugin keeps the note; a bare Bridge in a test does not. */
    this.persist = options.persist === true
    const kept = this.persist ? readMirror() : { owner: '', session: '', at: 0 }
    /* Only a real chat id is restored: a stray note must not hand the mirror to
       a chat that no longer exists. */
    if (/^session-/.test(kept.owner) !== true) kept.owner = ''
    this.owner = kept.owner
    this.wanted = { session: kept.session, at: kept.at }
  }

  /**
   * A chat is the chat that asked, and nothing else. Guessing at an alias once
   * put the mirror in a stranger's column: two conversations are never the same
   * conversation, however few pages happen to be on screen.
   * @param {string} session - whatever id the caller has.
   * @returns {string} the same id.
   */
  canon(session) {
    return String(session ?? '')
  }

  /**
   * Give the mirror to one chat and take it away from every earlier one.
   * @param {string} sessionId - chat that asked for it.
   */
  claim(sessionId) {
    if (sessionId === '') return
    this.owner = sessionId
    if (this.persist === true) writeMirror({ owner: this.owner, session: this.wanted.session, at: this.wanted.at })
  }

  /**
   * Remember that a chat wants the mirror, and tell it now if it is listening.
   * @param {string} sessionId - chat that asked.
   * @param {number} [at] - when it asked; older asks are not replayed.
   * @param {string} [reason] - 'ask' for a real request, 'keepalive' for a nudge.
   * @returns {boolean} whether a live tab took the frame.
   */
  want(sessionId, at = Date.now(), reason = 'ask') {
    const id = this.canon(sessionId)
    if (id === '') return false
    this.claim(id)
    this.wanted = { session: id, at }
    if (this.persist === true) writeMirror({ owner: this.owner, session: id, at })
    return this.push(id, { type: 'sidecar-wanted', session: id, at, reason })
  }

  /**
   * Take the chat's event stream.
   * @param {string} sessionId - chat the tab belongs to.
   * @param {import('node:http').ServerResponse} res - open SSE response.
   */
  attach(sessionId, res) {
    this.seats.get(sessionId)?.end()
    this.seats.set(sessionId, res)
    /* A tab that connects after the ask still gets the mirror: this is the case
       where the person was looking at another chat, or reloaded the page. An
       ask older than two minutes is spent and is not replayed. */
    const ask = this.wanted
    if (ask.session === sessionId && Date.now() - ask.at <= 120_000) {
      this.push(sessionId, { type: 'sidecar-wanted', session: sessionId, at: ask.at, reason: 'ask' })
    }
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

  /**
   * Give the mirror up: the person closed the column, so the chat stops owning
   * it and no keepalive may ask for it again. Ownership is what the column
   * reads on reload, so it has to be dropped on disk as well as in memory.
   * @param {string} sessionId - chat that closed its tab.
   * @returns {boolean} whether this chat held the mirror or the ask.
   */
  forget(sessionId) {
    const id = this.canon(sessionId)
    if (id === '') return false
    const held = this.owner === id || this.wanted.session === id
    this.wanted = { session: '', at: 0 }
    if (this.owner === id) this.owner = ''
    if (this.persist === true) writeMirror({ owner: this.owner, session: '', at: 0 })
    return held
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
import { keyEvent, sidecarTools, sessionScope, workScope } from './tools.js?v=1'

/**
 * A state poll may pick up a browser that outlived a reload, and only for the
 * chat that owns it: any chat polling would otherwise start a browser nobody
 * asked for, and a chat with no column would look like it had one.
 * @param {{alive?: boolean}} said - what the browser half answered.
 * @param {string} chat - the chat asking.
 * @param {string} owner - the chat that owns the mirror.
 * @returns {boolean} whether this poll should attach to a running browser.
 */
/**
 * What the state poll hands the browser half when it picks a surviving browser
 * up: the chat's own tab, at the address that chat last had. Without the chat
 * the browser comes back with no tab for anybody, and the column stays empty.
 * @param {string} chat - the chat that is polling.
 * @param {string} remembered - where that chat left off, or ''.
 * @returns {{session: string, url?: string}} options for `ensure`.
 */
/**
 * Whether this chat's poll should put its tab back: the browser is running, the
 * chat holds the mirror, and its tab is not there.
 * @param {any} chatState - what `chatState(chat)` said.
 * @param {string} chat - the chat that is polling.
 * @param {string} owner - the chat that holds the mirror.
 * @returns {boolean} true when a tab has to be opened for this chat.
 */
/**
 * The folder the calling session works in, wherever it is kept.
 * @param {any} execution - tool execution context.
 * @returns {string} absolute path, or empty when nothing was said.
 */
export function cwdOf(execution) {
  try {
    const agent = execution?.agent
    const value = agent?.cwd ?? agent?.session?.header?.cwd ?? agent?.header?.cwd
    if (typeof value === 'string' && value !== '') return value
  } catch {
    /* a context that cannot be read is a context without a folder */
  }
  return ''
}

export function needsTab(chatState, chat, owner) {
  if (String(chat ?? '') === '' || owner !== chat) return false
  return chatState?.alive !== true
}

export function adoptOptions(chat, remembered) {
  const back = String(remembered ?? '')
  return back === '' ? { session: chat } : { session: chat, url: back }
}

export function shouldAdoptOnState(said, chat, owner) {
  return said?.alive === false && chat !== '' && owner === chat
}

/**
 * Whether a running browser still needs its column told to draw it.
 * @param {{alive: boolean, owner: string, wanted: string, listeners: number}} what - current facts.
 * @returns {boolean} true when the owner is known, the browser runs, and nothing listens.
 */
export function wantsMirrorAgain(what) {
  if (what?.alive !== true) return false
  const owner = String(what?.owner ?? '')
  if (owner === '') return false
  if (String(what?.wanted ?? '') !== owner) return false
  return Number(what?.listeners ?? 0) <= 0
}

/**
 * Whether asking again can achieve anything. A pane that is polling this very
 * endpoint is awake and already knows the frames are missing, so a second ask
 * every few seconds only writes log lines; a pane that went quiet may have lost
 * the stream and does need one. One ask per gap at most.
 * @param {any} what - { askedAgo, sinceLast, quiet, gap } in milliseconds.
 * @returns {boolean} true when the ask should be sent now.
 */
export function nudgeDue(what) {
  const askedAgo = Number(what?.askedAgo ?? -1)
  const sinceLast = Number(what?.sinceLast ?? Infinity)
  const quiet = Number(what?.quiet ?? 15_000)
  const gap = Number(what?.gap ?? 10_000)
  if (!Number.isFinite(askedAgo) || askedAgo < quiet) return false
  return sinceLast >= gap
}

export const name = 'dsh-inner-browser-use'
export const inject = ['webServer']

/**
 * Mount the mirror routes and the tool surface.
 * @param {any} ctx - plugin context.
 */
export function apply(ctx) {
  const bridge = new Bridge({ persist: true })
  /* The sidecar is a browser the Host owns outright: a real Chrome with its own // ui-copy-ignore
     profile, shown in the column as a screencast. It outlives a plugin reload,
     and it does not need the chat to be on screen to do work. */
  const sidecar = new Sidecar({ logger: ctx.logger })
  /** @type {{refs: any[], at: number, last?: any}} */
  const sidecarRefs = { refs: [], at: 0 }
  ctx.effect(() => () => bridge.dispose(), 'dsh-inner-browser-use: bridge lifetime')
  /* A live picture that nobody is drawing is the one failure people notice
     first: the browser is fine, the column just lost its pane. The chat that
     owns the browser is asked again, on a slow beat, until the frames stream
     has a listener — the client keeps the rule that only the mounted chat's
     column may open. */
  /** @type {Map<string, number>} when each chat last polled for state. */
  const lastAsk = new Map()
  ctx.effect(() => {
    let last = 0
    const timer = setInterval(() => {
      try {
        const owner = bridge.owner
        const listeners = sidecar.page?.frames?.size ?? 0
        const again = wantsMirrorAgain({ alive: sidecar.page !== null && sidecar.page !== undefined, owner, wanted: bridge.wanted.session, listeners }) // ui-copy-ignore
        if (again !== true) return
        const due = nudgeDue({ askedAgo: Date.now() - (lastAsk.get(owner) ?? 0), sinceLast: Date.now() - last }) // ui-copy-ignore
        if (due !== true) return
        last = Date.now()
        bridge.want(owner, Date.now(), 'keepalive')
        note(`asked ${owner.slice(-8)} to draw the mirror again`)
      } catch {}
    }, 4000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-inner-browser-use: mirror keepalive')
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
      void sidecar.handoff().catch(() => {})
    }
  }, 'dsh-inner-browser-use: sidecar lifetime')

  /** @param {import('node:http').IncomingMessage} req - request. @param {import('node:http').ServerResponse} res - response. */
  /** @type {{at: number, path: string, session: string}[]} the last few calls the column made. */
  const recent = []
  /* Whether the pane is asking at all is the difference between "the browser
     stopped" and "nothing is drawing it": the poll is every 2.5 s, so a chat
     that asks is a chat with a mounted pane. Kept on disk because the answer
     has to survive a plugin reload, which is when the question is asked. */
  const handler = async (req, res) => {
    const url = new URL(req.url ?? ROUTE, 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const sessionId = url.searchParams.get('session') ?? ''
    /* Who came in and when: an empty picture has two very different causes, and
       this is what tells a column that never connected from a page that is gone. */
    recent.push({ at: Date.now(), path, session: sessionId.slice(-8) })
    if (recent.length > 40) recent.splice(0, recent.length - 40)

    /** @param {number} code - status. @param {unknown} value - body. */
    const json = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }

    /* One answer to one question: may this chat act on the mirror? A browser
       nobody holds is anybody's to take; once a chat holds it, another chat is
       refused here instead of being trusted to check itself. */
    /** @param {string} session - the chat a request speaks for. */
    const held = (session) => session !== '' && bridge.owner !== '' && session !== bridge.owner
    /** @returns {boolean} true when the request was refused. */
    const refuse = () => {
      json(403, { ok: false, text: 'this chat does not own the browser', owner: bridge.owner }) // ui-copy-ignore
      return true
    }
    /* Every route that changes the page goes through one check: it must say
       which chat it is for, and that chat must be the one holding the mirror.
       Two rules in one place, so a new route cannot quietly skip one. */
    /**
     * @param {any} body - parsed request body, if any.
     * @returns {string} the chat that may act, or '' when it was refused.
     */
    const acting = (body) => {
      const who = String(body?.session ?? '') || sessionId
      if (who === '') {
        json(400, { ok: false, text: 'which chat asked for it' }) // ui-copy-ignore
        return ''
      }
      if (held(who) && refuse()) return ''
      return who
    }

    if (path === '/sidecar/frames' && req.method === 'GET') {
      /* The column is global and only one chat may hold the mirror: a chat that
         does not own it is refused here, so a stale tab cannot stream a picture
         of somebody else's browser. */
      const asked = String(url.searchParams.get('session') ?? '')
      const watching = asked !== '' ? asked : sessionId
      if (held(watching) && refuse()) return
      /* Only the owner's own page may stream the picture. */
      const streaming = watching
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
        }, streaming)
        const info = await sidecar.state()
        /* The pane needs one address to offer back when this chat's own page
           went away; the state route answers the same question for the tab
           header, so both carry it. */
        const chat = watching === '' ? {} : { chat: await sidecar.chatState(watching) }
        res.write(`data: ${JSON.stringify({ type: 'hello', ...info, ...chat })}\n\n`)
      } catch (error) {
        res.write(`data: ${JSON.stringify({ type: 'failed', text: String(error?.message ?? error) })}\n\n`)
      }
      const beat = setInterval(() => res.write(': beat\n\n'), 15_000)
      beat.unref?.()
      req.on('close', () => clearInterval(beat))
      return
    }

    if (path === '/sidecar/claim' && req.method === 'POST') {
      /* The pane itself asks back what it was showing: after a reload the
         forgot who owned the mirror, and the chat that still has the tab open is
         the only one allowed to say so. A different owner is refused. */
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(400, { ok: false, text: 'bad frame' })
        return
      }
      const id = String(body.session ?? '')
      if (id === '') {
        json(400, { ok: false, text: 'no chat' })
        return
      }
      if (bridge.owner !== '' && bridge.owner !== id) {
        json(409, { ok: false, owner: bridge.owner })
        return
      }
      bridge.claim(id)
      json(200, { ok: true, owner: bridge.owner })
      return
    }

    if (path === '/sidecar/state' && req.method === 'GET') {
      /* Which chats have a column open right now: 0 means nobody is watching,
         so an empty picture is the column's own problem, not the browser's. */
      const chat = String(url.searchParams.get('session') ?? '')
      /* Diagnostics belong to the chat that made them: a caller sees its own
         calls, and one chat's browsing never explains another's. */
      const mine = chat === '' ? recent : recent.filter((entry) => entry.session === chat.slice(-8))
      let said = await sidecar.state()
      /* The browser can be running and still have no tab for this chat: a reload
         replaces the half that remembered which tab belonged to whom. The poll
         is this chat asking, so it answers by putting that chat's tab back
         before the column draws an empty picture — waiting for a claim first
         left a blank frame in front of the person. */
      let mineChat = chat === '' ? undefined : await sidecar.chatState(chat)
      if (needsTab(mineChat, chat, bridge.owner)) {
        try {
          await sidecar.ensure(adoptOptions(chat, sidecar.rememberedTab?.(chat)))
          said = await sidecar.state()
          mineChat = await sidecar.chatState(chat)
        } catch {}
      }
      /* A plugin reload leaves the browser running and this half brand new, so
         the column's first poll would answer "nothing open" until somebody
         called open again: the mirror would come back empty in a chat that
         never closed it. The chat that owned the browser asks for its state, so
         answering honestly means picking the browser up first. */
      if (shouldAdoptOnState(said, chat, bridge.owner)) {
        try {
          await sidecar.ensure(adoptOptions(chat, sidecar.rememberedTab?.(chat)))
          said = await sidecar.state()
        } catch {}
      }
      if (chat !== '') {
        const before = lastAsk.get(chat) ?? 0
        if (Date.now() - before > 2000) {
          lastAsk.set(chat, Date.now())
          try {
            note(`${chat.slice(-8)} alive=${String(said?.alive === true)} viewers=${String(said?.viewers ?? 0)}`)
          } catch {}
        }
      }
      json(200, { ...said, ...(chat === '' ? {} : { chat: mineChat ?? (await sidecar.chatState(chat)) }), owner: bridge.owner, chats: [...bridge.seats.keys()], recent: mine })
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
        /* An open names its chat and then takes the mirror over: that is what
           asking for it means, so another owner is not a refusal here. */
        const who = String(body.session ?? '') || sessionId
        if (who === '') {
          json(400, { ok: false, text: 'which chat asked for it' }) // ui-copy-ignore
          return
        }
        await sidecar.ensure({
          url: address === '' ? undefined : address,
          headless: body.headless === undefined ? undefined : body.headless === true,
          session: who,
        })
        /* The mirror belongs to the chat that asked for it; any earlier owner
           loses it and its tab. */
        bridge.want(who)
        json(200, { ok: true, ...(await sidecar.state()), owner: bridge.owner })
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/viewport' && req.method === 'POST') {
      /* The pane tells the page how big it is, so the picture fills the column
         instead of being letterboxed inside it. Only the owner may resize what
         its own mirror shows. */
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(400, { ok: false, text: 'bad frame' }) // ui-copy-ignore
        return
      }
      const actor = acting(body)
      if (actor === '') {
        json(403, { ok: false, text: 'this chat does not own the browser' }) // ui-copy-ignore
        return
      }
      try {
        /* The shape belongs to the page this chat is actually looking at: a
           chat driving a tab of its own must not resize the browser's base
           page and keep a letterboxed picture. */
        const page = sidecar.pageFor(actor) ?? sidecar.page
        if (page === null || page === undefined) {
          json(409, { ok: false, text: 'the browser is not open' }) // ui-copy-ignore
          return
        }
        json(200, { ok: true, view: await page.setViewport(body.w, body.h) })
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
      const actor = acting(body)
      if (actor === '') return
      try {
        const page = await sidecar.ensure({ session: actor })
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
          const key = keyEvent(body)
          if (key.down !== true) await page.key('keyUp', { ...key.spec, text: undefined })
          else if (key.repeat === true) {
            /* Typing repeat: the page draws a held key as a fresh keydown. */
            await page.key('keyDown', { ...key.spec, autoRepeat: true })
          } else if (key.command === null) await page.key('keyDown', key.spec)
          else await page.key('keyDown', { ...key.spec, text: undefined, commands: [key.command] })
        }
        /* Hovering and moving are looking, not acting: only real input counts as
           the person taking the page. */
        if (kind !== 'hover' && kind !== 'move') {
          sidecar.humanUse({ kind, x, y })
          /* The arrow goes now, not on the next repaint: a still page may not
             paint again for a second and a half. */
          try {
            page.announceHold()
          } catch {
            /* the stream is gone; the next frame carries the same answer */
          }
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
      const actor = acting(body)
      if (actor === '') return
      try {
        const page = await sidecar.ensure({ session: actor })
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

    if (path === '/sidecar/tabs' && req.method === 'GET') {
      /* This chat's windows only: another chat's pages never enter this list. */
      const who = acting({ session: url.searchParams.get('session') })
      if (who === '') return
      try {
        const tabs = await sidecar.windowsFor(who)
        json(200, { ok: true, tabs, ...(url.searchParams.get('session') === '' ? { session: who } : {}) })
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/tabs' && req.method === 'POST') {
      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch {
        json(400, { ok: false, text: 'bad frame' })
        return
      }
      const actor = acting(body)
      if (actor === '') return
      try {
        const at = Number(body.index ?? -1)
        if (body.op === 'close') {
          await sidecar.closeTab(at, actor)
        } else {
          await sidecar.useTab(at, actor)
        }
        const tabs = await sidecar.windowsFor(actor)
        json(200, { ok: true, tabs })
      } catch (error) {
        json(500, { ok: false, text: String(error?.message ?? error) })
      }
      return
    }

    if (path === '/sidecar/forget' && req.method === 'POST') {
      /* Closing the tab is an answer: coming back should not reopen it. Only the
         chat that holds the mirror may withdraw its own ask. */
      const body = await readBody(req).then((raw) => JSON.parse(raw || '{}')).catch(() => ({}))
      const who = acting(body)
      if (who === '') return
      const forgot = bridge.forget(who)
      /* Nobody is watching a picture the person closed: the browser itself is
         put away a minute later rather than a quarter of an hour, unless an
         agent asks for it again in the meantime. */
      try {
        if (sidecar.watched() === 0) {
          sidecar.touch(REST_MS)
          note('said ' + who.slice(-8) + ' closed the mirror - browser rests in a minute')
        }
      } catch { /* a browser that never started needs no rest timer */ }
      json(200, { ok: true, forgot })
      return
    }

    if (path === '/sidecar/stop' && req.method === 'POST') {
      /* Closing the browser is a write as well: a chat that does not hold the
         mirror cannot close another chat's page. */
      const body = await readBody(req).then((raw) => JSON.parse(raw || '{}')).catch(() => ({}))
      const who = String(body.session ?? '') || sessionId
      if (who !== '' && held(who) && refuse()) return
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
      /* A screenshot the model can look at is the difference between planning
         from the picture and guessing from a path. The store and the route that
         can carry it are Harness services, so the tool asks here for it; when
         either is missing the picture stays a file and the call still works. */
      /**
       * @param {string} data - base64 PNG.
       * @param {string} name - file name for the attachment.
       * @param {any} exec - the tool call's context.
       * @returns {Promise<any>} the attachment value, or undefined to stay text-only.
       */
      async showShot(data, name, exec) {
        try {
          const attachments = ctx.get('attachments')
          const llm = ctx.get('llm')
          if (attachments === undefined || llm === undefined) return undefined
          const route = exec?.agent?.session?.requestHeader?.()?.config
          const provider = route?.provider ?? exec?.agent?.options?.provider
          const model = route?.model ?? exec?.agent?.options?.model
          if (provider === undefined || model === undefined) return undefined
          const info = await llm.resolveModelInfo(provider, model, exec?.signal)
          if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) return undefined
          const bytes = Buffer.from(data, 'base64')
          const cap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
          if (!(bytes.length > 0) || bytes.length > cap) return undefined
          const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name })
          return {
            attachmentId: ref.attachmentId, // ui-copy-ignore
            mediaType: ref.mediaType, // ui-copy-ignore
            bytes: ref.bytes, // ui-copy-ignore
            width: ref.width, // ui-copy-ignore
            height: ref.height, // ui-copy-ignore
            ...(ref.name === undefined ? {} : { name: ref.name }),
          }
        } catch {
          return undefined
        }
      },
      /* The mirror changes hands here: the calling chat owns it from now on,
         and every earlier owner loses it. */
      want: (sessionId) => {
        bridge.want(sessionId)
      },
      /* Who holds the mirror, and whether a chat is listening right now. */
      owner: () => bridge.owner, // ui-copy-ignore
      seats: () => [...bridge.seats.keys()].map((k) => String(k).slice(-8)).join(',') || 'none', // ui-copy-ignore
    }).map((definition) => {
      /* A reload can mount this surface twice before the old one is torn down.
         A name already in the registry is kept, not fought over: a duplicate
         registration is a warning, never a crash. */
      try {
        const run = definition.execute
        const scoped = {
          ...definition,
          /* Every tool call runs inside the chat that made it, so the browser
             hands that chat its own tab and no other. */
          execute: async (args, exec) => sessionScope.run(String(exec?.agent?.id ?? ''), () => workScope.run(cwdOf(exec), () => run(args, exec))),
        }
        return scope.tools.register(scoped)
      } catch (error) {
        ctx.logger?.warn?.(`browser tool ${definition.name} already registered: ${String(error?.message ?? error)}`)
        return () => {}
      }
    })
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
        '## 网页任务：人明确点名才开右栏浏览器',
        '右栏「后台浏览器」是一台独立的后台 Chrome，模型能点、能读、能执行脚本；画面只出现在本会话右栏，不占别的会话。它只做「必须动手」的活，默认不开。',
        '',
        '只有人明确说要看网页/用浏览器时才开始：「用网页端 / 在浏览器里 / 打开某个网站 / 上 ChatGPT 生成 / 帮我在这个页面点…」。人只给了链接、没说要用浏览器时，先用 `web_fetch` 或 envoy 读；读不到（登录墙、空壳、要交互）就说明原因再问一句，不要自己开。',
        '不要用它：读公开文章、单个链接正文、文档、搜索结果摘要、GitHub 仓库或 PR 页面——这些能用 `web_fetch` / envoy 读就不用浏览器；一打开就是一个后台 Chrome 进程加一个页签，会话多了很占内存。',
        '也不要用它做连通性、可达性、服务是否起来的检查：那是一个 HTTP 请求的事，`web_fetch` 或 `curl` 就够，开浏览器只会多一个进程和一栏画面。只有「这一步必须在真实浏览器里点/填/登录」才轮到它。',
        '人点名之后不问、不另起外部 Chrome；画面留在本会话右栏，做完保留，不主动关。',
        '先接着用已有的页：`browser_view`（拿编号控件与可见文字）→ `browser_click` / `browser_type` → 再 `browser_view` 直到出现要的结果；页面要等就重复读，不 sleep。`browser_open` 只用于没有页、要换新地址、或要明确刷新；同一个地址不要反复重开。',
        '页面很长、只想确认某句话/按钮在哪时用 `browser_find`，别整页读。要读长文（文章、文档、issue、论坛帖）用 `browser_read`：它回 Markdown，只花几十分之一的 token，链接可点；要动手点、填表才用 `browser_view` 拿编号。',
        '要保存页面样子用 `browser_shot`，它会给出 PNG 绝对路径；要交给人看的文件，把绝对路径写进回复。',
      ].join('\n'),
    }), 'dsh-inner-browser-use: system prompt section')
  }

  ctx.logger?.info?.('dsh-inner-browser-use: mirror on %s', ROUTE)
}
