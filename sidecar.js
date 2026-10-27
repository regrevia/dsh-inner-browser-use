/**
 * The sidecar browser: a real Chrome that the Host owns. // ui-copy-ignore
 *
 * A separate process with its own on-disk profile: a login survives a restart,
 * and a page keeps working while the person looks somewhere else. The column
 * shows it as a screencast, so the tab is a viewer, not the browser.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Chrome builds this machine may have, most preferred first. */
const CHROME_BINARIES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/** Viewport the screencast and the pointer share. Nothing here is a user-agent detail. */
export const VIEW = { width: 1440, height: 900 }

/**
 * Pixels the mirror actually sends. The viewport is never downscaled: a
 * half-size JPEG turns 12px body text into mush in a column this narrow, and
 * the sharpness is what makes the mirror feel like the page. Quality stops
 * short of lossless so a moving picture still arrives on the next frame.
 */
const MIRROR = { width: VIEW.width, height: VIEW.height }

/** Frames are dropped rather than queued: a lagging viewer must not slow the page. */
const MAX_INFLIGHT_FRAMES = 2

/** Idle lifetime, so a forgotten sidecar does not sit on a login forever. */
const IDLE_MS = 15 * 60_000

/** @param {number} ms - how long to wait. @returns {Promise<void>} resolves after it. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {string} path - candidate. @returns {string | undefined} the one that exists. */
function firstBinary() {
  return CHROME_BINARIES.find((path) => existsSync(path))
}

/** Root of everything this plugin keeps for the sidecar. */
function rootDir() {
  const dir = join(homedir(), '.dsh', 'inner-browser-use', 'chrome')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** @param {string} name - profile name. @returns {string} its directory. */
function profileDir(name) {
  const dir = join(rootDir(), String(name || 'default').replace(/[^\w.-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A minimal CDP session over one target's WebSocket.
 *
 * `flatten` sessions are not needed: the sidecar owns exactly one page, and a
 * page-level socket addresses it without ids to get wrong.
 */
class Cdp {
  /** @param {string} url - the target's `webSocketDebuggerUrl`. */
  constructor(url) {
    this.url = url
    this.next = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    this.socket = new WebSocket(url)
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(this))
      this.socket.addEventListener('error', () => reject(new Error('sidecar: CDP socket failed')))
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry === undefined) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
        else entry.resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners) listener(message)
    })
    this.socket.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error(`${entry.method}: sidecar closed`))
      this.pending.clear()
    })
  }

  close() {
    this.socket.close()
  }

  /**
   * @param {string} method - CDP method.
   * @param {Record<string, unknown>} params - its parameters.
   * @param {string} [sessionId] - a child target to run it in, for a popup or a frame Chrome runs elsewhere.
   * @returns {Promise<any>} its result.
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('sidecar: CDP session is closed'))
    const id = this.next++
    const message = { id, method, params }
    if (sessionId !== undefined) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify(message))
    })
  }

  /** @param {(message: any) => void} listener - called for every event. @returns {() => void} unsubscribe. */
  on(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* a socket that is already gone needs no closing */
    }
  }
}

/**
 * One page of the sidecar, with its screencast and its input.
 *
 * Input is real CDP input: the page sees the same events a person's trackpad
 * produces, which is what makes sites that reject scripted clicks work.
 */
export class SidecarPage {
  /** @param {Cdp} cdp - the page session. @param {string} profile - profile name. */
  constructor(cdp, profile, port) { // ui-copy-ignore
    this.cdp = cdp
    this.profile = profile
    this.port = port // ui-copy-ignore
    this.epoch = 0
    this.frames = new Set()
    /* Pointer moves are their own, tiny message: the arrow follows the agent at
       once instead of waiting for the next picture to be painted. */
    this.pointerSinks = new Set()
    this.latest = ''
    this.seq = 0
    /* Total JPEG bytes seen, for the bench and for noticing when a page got
       expensive to watch. */
    this.bytes = 0
    this.pointer = { x: VIEW.width / 2, y: VIEW.height / 2 }
    this.url = ''
    this.lastUrl = ''
    this.crashed = false
    this.title = ''
    this.casting = false
    this.inflight = 0
    this.touched = Date.now()
    /* A dialog blocks the page until someone answers it, so it is state, not an
       event: the driver can look at it before deciding. */
    this.dialog = null
    this.console = []
    this.failed = []
    /* What the page asked for, so a page that fills itself from addresses can
       be understood without a screenshot or a retry. */
    this.network = []
    this.requests = new Map()
    /* frame id -> the world its page script runs in. A control inside an iframe
       is only reachable through that world; the frame list is read when the
       read model needs it. */
    this.contexts = new Map()
    this.frameOrder = []
    /* A click can open a tab. Chrome tells us the new target; the mirror then
       follows it, because a person looking at the column expects that too. */
    this.children = new Map()
    this.opened = null
    this.port = Number(port ?? 0) // ui-copy-ignore
  }

  /**
   * Record the page events that matter to a driver: dialogs, console lines and
   * failed requests. Buffers are capped so a chatty page cannot grow memory.
   * @param {any} message - one CDP message.
   */
  watch(message) {
    if (message.method === 'Runtime.executionContextCreated') {
      const context = message.params?.context ?? {}
      const aux = context.auxData ?? {}
      if (aux.isDefault === true && typeof aux.frameId === 'string') this.contexts.set(aux.frameId, Number(context.id))
      return
    }
    if (message.method === 'Runtime.executionContextDestroyed') {
      const gone = Number(message.params?.executionContextId)
      for (const [frameId, contextId] of this.contexts) if (contextId === gone) this.contexts.delete(frameId)
      return
    }
    if (message.method === 'Runtime.executionContextsCleared') {
      this.contexts.clear()
      return
    }
    if (message.method === 'Target.attachedToTarget') {
      const params = message.params ?? {}
      const sessionId = String(params.sessionId ?? '')
      const info = params.targetInfo ?? {}
      if (sessionId === '') return
      this.children.set(sessionId, { targetId: String(info.targetId ?? ''), type: String(info.type ?? ''), url: String(info.url ?? '') })
      /* A target that waits for the debugger must be let go at once, or the
         tab a person just asked for never loads. */
      void this.cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
      if (String(info.type ?? '') === 'page') {
        this.opened = { targetId: String(info.targetId ?? ''), url: String(info.url ?? '') }
      }
      return
    }
    if (message.method === 'Target.detachedFromTarget') {
      this.children.delete(String(message.params?.sessionId ?? ''))
      return
    }
    if (message.method === 'Target.targetInfoChanged') {
      const info = message.params?.targetInfo ?? {}
      const targetId = String(info.targetId ?? '')
      for (const child of this.children.values()) if (child.targetId === targetId) child.url = String(info.url ?? '')
      return
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      this.dialog = message.params ?? {}
      return
    }
    if (message.method === 'Page.javascriptDialogClosed') {
      this.dialog = null
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails ?? {}
      this.console.push({ type: 'error', text: String(detail.exception?.description ?? detail.text ?? '').slice(0, 300) })
      if (this.console.length > 200) this.console.splice(0, 50)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params ?? {}
      const text = (params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 300)
      this.console.push({ type: String(params.type ?? 'log'), text })
      if (this.console.length > 200) this.console.splice(0, 50)
      return
    }
    if (message.method === 'Network.requestWillBeSent') {
      const params = message.params ?? {}
      const request = params.request ?? {}
      const id = String(params.requestId ?? '')
      if (id === '') return
      this.requests.set(id, {
        method: String(request.method ?? 'GET'),
        url: String(request.url ?? '').slice(0, 300), // ui-copy-ignore
        type: String(params.type ?? ''),
        status: 0,
      })
      if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value)
      return
    }
    if (message.method === 'Network.responseReceived') {
      const params = message.params ?? {}
      const known = this.requests.get(String(params.requestId ?? ''))
      if (known === undefined) return
      known.status = Number(params.response?.status ?? 0)
      this.network.push(known)
      if (this.network.length > 120) this.network.splice(0, 40)
      return
    }
    if (message.method === 'Network.loadingFailed') {
      const params = message.params ?? {}
      if (params.canceled === true) return
      this.failed.push({ error: String(params.errorText ?? ''), type: String(params.type ?? '') })
      if (this.failed.length > 100) this.failed.splice(0, 25)
    }
  }

  /**
   * Follow a tab the page just opened: the mirror shows the new page and the
   * popup is closed, so there is still one page to drive.
   * @returns {Promise<string>} what happened, for the tool result.
   */
  /**
   * The session Chrome gave a frame it runs in its own process, so a read can be
   * sent there. Chrome names an iframe target after its frame.
   * @param {string} frameId - a frame from the frame tree.
   * @returns {string|undefined} the session, when one exists.
   */
  childSession(frameId) {
    for (const [sessionId, child] of this.children) if (child.targetId === frameId) return sessionId
    return undefined
  }

  /**
   * A tab this page opened, found through the DevTools address list. Chrome
   * gives a page no handle on its own popups, but the list is enough to know
   * one exists and where it went.
   * @returns {Promise<{targetId: string, url: string}|null>} the popup.
   */
  async findPopup() {
    if (this.port <= 0) return null // ui-copy-ignore
    const main = await this.cdp.send('Target.getTargetInfo').then((info) => String(info?.targetInfo?.targetId ?? '')).catch(() => '')
    const list = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1200) }) // ui-copy-ignore
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])
    const pages = (Array.isArray(list) ? list : []).filter((item) => item.type === 'page' && String(item.id ?? '') !== main)
    const popup = pages.find((item) => /^https?:|^file:/.test(String(item.url ?? '')))
    if (popup !== undefined) return { targetId: String(popup.id), url: String(popup.url) }
    const blank = pages[0]
    return blank === undefined ? null : { targetId: String(blank.id), url: String(blank.url ?? '') }
  }

  /**
   * The browser's pages, in the order the browser lists them. More than one
   * exists when a site opens a window the driver did not follow.
   * @returns {Promise<Array<{targetId: string, title: string, url: string, current: boolean}>>} the tabs.
   */
  async tabs() {
    const port = this.port // ui-copy-ignore
    if (port <= 0) return [] // ui-copy-ignore
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }) // ui-copy-ignore
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])
    const current = await this.cdp.send('Target.getTargetInfo').then((info) => String(info?.targetInfo?.targetId ?? '')).catch(() => '')
    return (Array.isArray(list) ? list : [])
      .filter((item) => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
      .map((item) => ({ targetId: String(item.id), title: String(item.title ?? ''), url: String(item.url ?? ''), webSocketUrl: String(item.webSocketDebuggerUrl), current: String(item.id) === current }))
  }

  /**
   * Follow a tab the page just opened: the mirror shows where the person would
   * have ended up, and the popup is closed so there is still one page to drive.
   * @returns {Promise<string>} what happened, for the tool result.
   */
  async adoptOpened() {
    let target = this.opened === null || this.opened === undefined ? null : { targetId: this.opened.targetId, url: this.opened.url }
    this.opened = null
    if (target === null) {
      /* The target list is written before the popup finished loading, so give a
         click that opens one a moment to say where it is going. */
      for (let attempt = 0; attempt < 3 && target === null; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 150))
        const found = await this.findPopup()
        if (found !== null && found.url !== '') target = found
        else if (found !== null && attempt === 2) target = found
      }
    }
    if (target === null) return ''
    const url = String(target.url ?? '')
    await this.cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
    if (this.port > 0) await fetch(`http://127.0.0.1:${this.port}/json/close/${target.targetId}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
    if (!/^https?:|^file:/.test(url)) return ''
    await this.cdp.send('Page.navigate', { url }).catch(() => {})
    return `opened ${url}`
  }

  /**
   * The frames of the page, main frame first, each with the context its scripts
   * run in. Read on demand: a page with no iframes pays one call.
   * @returns {Promise<Array<{frameId: string, url: string, contextId?: number}>>} the frames.
   */
  async frameList() {
    const tree = await this.cdp.send('Page.getFrameTree').catch(() => null)
    const out = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      const frameId = String(node.frame?.id ?? '')
      if (frameId !== '') {
        const contextId = this.contexts.get(frameId)
        out.push({ frameId, url: String(node.frame?.url ?? ''), contextId: contextId === undefined ? undefined : Number(contextId) })
      }
      for (const child of node.childFrames ?? []) walk(child)
    }
    walk(tree?.frameTree)
    /* A frame Chrome runs in another process is not in this tree, but it is
       attached as its own target; list it after the tree so it gets a slot. */
    const known = new Set(out.map((item) => item.frameId))
    for (const [sessionId, child] of this.children) {
      if (child.type !== 'iframe' || known.has(child.targetId)) continue
      if (sessionId === '') continue
      out.push({ frameId: child.targetId, url: String(child.url ?? ''), contextId: undefined })
      known.add(child.targetId)
    }
    this.frameOrder = out.map((item) => item.frameId)
    return out
  }

  /**
   * Responses this page received, newest first.
   * @returns {{method: string, url: string, type: string, status: number}[]} what it asked for.
   */
  networkList() {
    return this.network.slice(-120).reverse()
  }

  /**
   * Files this browser has downloaded, newest first.
   * @returns {{name: string, bytes: number, at: string}[]} what is on disk.
   */
  downloads() {
    const folder = this.downloadsFolder ?? downloadsDir(profileDir(this.profile))
    let names = []
    try {
      names = readdirSync(folder)
    } catch (error) {
      return []
    }
    const found = []
    for (const name of names) {
      if (name.endsWith('.crdownload')) continue
      const path = join(folder, name)
      try {
        const info = statSync(path)
        if (!info.isFile()) continue
        found.push({ name, bytes: info.size, at: new Date(info.mtimeMs).toISOString() })
      } catch (error) {
        continue
      }
    }
    found.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    return found.slice(0, 20)
  }

  /**
   * Where the owner element of a frame sits on the page, for a frame whose own
   * process cannot answer. The page's DOM knows the iframe element.
   * @param {string} frameId - a frame from the frame list.
   * @returns {Promise<{x: number, y: number}|null>} the corner, when known.
   */
  async frameBox(frameId) {
    const owner = await this.cdp.send('DOM.getFrameOwner', { frameId }).catch(() => null)
    const backendNodeId = owner?.backendNodeId
    if (backendNodeId === undefined) return null
    const node = await this.cdp.send('DOM.resolveNode', { backendNodeId }).catch(() => null)
    const objectId = node?.object?.objectId
    if (objectId === undefined) return null
    const said = await this.cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { const b = this.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top) } }',
      returnByValue: true,
    }).catch(() => null)
    const spot = said?.result?.value
    if (spot === null || spot === undefined || !Number.isFinite(spot.x)) return null
    return { x: Number(spot.x), y: Number(spot.y) }
  }

  /** Keep one listener that fans frames out to every viewer. */
  async start() {
    await this.cdp.send('Network.enable').catch(() => {})
    /* A click that downloads should leave a file, not nothing: point downloads
       at the profile so the driver can report where they went. */
    const folder = downloadsDir(profileDir(this.profile))
    mkdirSync(folder, { recursive: true })
    this.downloadsFolder = folder
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder }).catch(() => {})
    /* Popups and out-of-process frames are separate targets. Attaching without
       waiting keeps them usable, and lets the mirror follow a new tab. */
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {})
    this.cdp.on((message) => {
      this.watch(message)
      if (message.method !== 'Page.screencastFrame') return
      const { data, sessionId, metadata } = message.params ?? {}
      void this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      if (typeof data !== 'string' || data === '') return
      this.latest = data
      this.seq += 1
      this.bytes += data.length
      if (metadata?.timestamp !== undefined && metadata.timestamp * 1000 < this.touched - 60_000) return
      if (this.inflight >= MAX_INFLIGHT_FRAMES) return
      this.inflight += 1
      const frame = {
        seq: this.seq, // ui-copy-ignore
        w: VIEW.width, // ui-copy-ignore
        h: VIEW.height, // ui-copy-ignore
        jpeg: data, // ui-copy-ignore
        url: this.url, // ui-copy-ignore
        title: this.title, // ui-copy-ignore
        pointer: this.pointer, // ui-copy-ignore
      }
      for (const sink of this.frames) {
        try {
          sink(frame)
        } catch {
          /* a closed viewer is dropped by its own stream handler */
        }
      }
      this.inflight -= 1
    })
    this.cdp.on((message) => {
      if (message.method === 'Page.frameNavigated' && message.params?.frame?.parentId === undefined) {
        this.url = String(message.params.frame.url ?? '')
        void this.readTitle()
      }
      if (message.method === 'Page.loadEventFired') void this.readTitle()
    })
    await this.cdp.send('Page.enable')
    /* An instance left behind by a stopped app can still be sitting on a
       dialog; a paused renderer answers nothing, so clear it first. */
    await Promise.race([
      this.cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ])
    await this.cdp.send('Runtime.enable')
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEW.width, // ui-copy-ignore
      height: VIEW.height, // ui-copy-ignore
      deviceScaleFactor: 1,
      mobile: false, // ui-copy-ignore
    })
    /* A headless build announces itself in the UA, and some sites refuse that
       string outright. The page is a normal Chrome here, so it says so. */
    const { product } = await this.cdp.send('Browser.getVersion').catch(() => ({ product: '' }))
    if (String(product).includes('HeadlessChrome')) {
      const version = String(product).replace(/.*HeadlessChrome\//, '')
      await this.cdp.send('Emulation.setUserAgentOverride', {
        userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`,
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
        platform: 'MacIntel',
      })
    }
    await this.readTitle()
    return this
  }

  async readTitle() {
    try {
      const call = this.cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({url: location.href, title: document.title})',
        returnByValue: true,
      })
      const answer = await Promise.race([call, new Promise((resolve) => setTimeout(resolve, 1500))])
      const result = answer?.result
      const value = JSON.parse(String(result?.value ?? '{}'))
      this.url = String(value.url ?? this.url)
      this.title = String(value.title ?? this.title)
    } catch {
      /* a page mid-navigation has no title yet */
    }
  }

  /** @returns {Promise<void>} resolves once the page is casting. */
  async cast() {
    if (this.casting) return
    this.casting = true
    /* Full-resolution mirror at a quality that keeps small text readable;
       `optimizeForSpeed` keeps the encoder from adding to the round trip. */
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', // ui-copy-ignore
      quality: 72, // ui-copy-ignore
      maxWidth: MIRROR.width, // ui-copy-ignore
      maxHeight: MIRROR.height,
      optimizeForSpeed: true,
      everyNthFrame: 1,
    }).catch(() => {
      this.casting = false
    })
  }

  async stopCast() {
    if (!this.casting) return
    this.casting = false
    await this.cdp.send('Page.stopScreencast').catch(() => {})
  }

  /**
   * @param {string} url - address to open.
   * @returns {Promise<{url: string, title: string}>} where it landed.
   */
  async navigate(url) {
    this.touched = Date.now()
    this.lastUrl = String(url)
    await this.cdp.send('Page.navigate', { url })
    for (let i = 0; i < 200; i += 1) {
      await wait(100)
      await this.readTitle()
      if (this.url !== '' && this.url !== 'about:blank') break
    }
    return { url: this.url, title: this.title }
  }

  /**
   * A renderer that crashed stops answering. Asking for one number is the
   * cheapest way to tell a busy page from a dead one.
   * @returns {Promise<boolean>} whether the page answered.
   */
  async ping() {
    try {
      const answer = await Promise.race([
        this.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }),
        wait(600).then(() => { throw new Error('no answer') }),
      ])
      return { ok: answer !== undefined && answer !== null, closed: false }
    } catch {
      /* A closed connection answers at once; a busy page only times out. The
         difference matters: one is replaced now, the other gets one more try. */
      return { ok: false, closed: this.cdp?.closed === true }
    }
  }

  async reload() {
    this.touched = Date.now()
    await this.cdp.send('Page.reload', {})
    await wait(400)
    await this.readTitle()
    return { url: this.url, title: this.title }
  }

  /** @param {number} delta - negative goes back. @returns {Promise<{url: string}>} where it landed. */
  async history(delta) {
    const { currentIndex, entries } = await this.cdp.send('Page.getNavigationHistory')
    const entry = entries?.[currentIndex + delta]
    if (entry === undefined) return { url: this.url, moved: false }
    await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id })
    await wait(500)
    await this.readTitle()
    return { url: this.url, moved: true }
  }

  /** @param {{x: number, y: number}} point - where the pointer goes. */
  movePointer(point) {
    this.pointer = { x: Math.round(point.x), y: Math.round(point.y) }
    this.touched = Date.now()
    const message = { type: 'pointer', w: VIEW.width, h: VIEW.height, pointer: this.pointer }
    for (const sink of this.pointerSinks) {
      try {
        sink(message)
      } catch {
        /* a closed viewer is dropped by its own stream handler */
      }
    }
  }

  /**
   * The cursor shape the page would show at a point. This is a read: it never
   * changes the page.
   *
   * @param {{x: number, y: number}} point - where to look, in viewport pixels.
   * @returns {Promise<string>} a CSS cursor keyword the Client can apply.
   */
  async cursorAt(point) {
    const expression = `(() => {
      const el = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)})
      if (el === null) return 'default'
      return getComputedStyle(el).cursor || 'default'
    })()`
    try {
      const { result } = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      return String(result?.value ?? 'default')
    } catch {
      return 'default'
    }
  }

  /**
   * Move the page's own hover state without moving the agent's pointer: the
   * person's hand is a real cursor here, and the black arrow marks the agent.
   *
   * @param {{x: number, y: number}} point - where the hand is, in viewport pixels.
   * @returns {Promise<string>} the cursor shape the page shows under it.
   */
  /**
   * Send one input event and do not wait on a renderer that a dialog or a long
   * task has paused. The event still lands; only the acknowledgement is dropped.
   * @param {string} method - Input.* method.
   * @param {object} params - its parameters.
   * @returns {Promise<void>} done when sent or when the wait gives up.
   */
  async input(method, params) {
    await Promise.race([
      this.cdp.send(method, params).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ])
  }

  async hover(point) {
    await this.input('Input.dispatchMouseEvent', {
      type: 'mouseMoved', // ui-copy-ignore
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: 'none', // ui-copy-ignore
      buttons: 0, // ui-copy-ignore
      clickCount: 0,
      pointerType: 'mouse',
    })
    return this.cursorAt(point)
  }

  /**
   * @param {string} type - `mousePressed`, `mouseReleased` or `mouseMoved`.
   * @param {{x: number, y: number, button?: string, clickCount?: number}} point - CSS pixels.
   * @returns {Promise<void>} resolves when Chrome took the event.
   */
  async mouse(type, point) {
    this.movePointer(point)
    await this.input('Input.dispatchMouseEvent', {
      type,
      x: point.x,
      y: point.y,
      button: point.button ?? 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: point.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
      pointerType: 'mouse',
    })
  }

  /**
   * @param {{x: number, y: number, dx?: number, dy?: number}} args - wheel over a point.
   * @returns {Promise<void>} resolves when Chrome took it.
   */
  async wheel(args) {
    this.movePointer(args)
    await this.input('Input.dispatchMouseEvent', {
      type: 'mouseWheel', // ui-copy-ignore
      x: args.x, // ui-copy-ignore
      y: args.y, // ui-copy-ignore
      deltaX: args.dx ?? 0, // ui-copy-ignore
      deltaY: args.dy ?? 0, // ui-copy-ignore
      pointerType: 'mouse',
    })
  }

  /**
   * @param {string} type - `keyDown` or `keyUp`.
   * @param {{key: string, code?: string, keyCode?: number, text?: string, modifiers?: number}} key - one key.
   * @returns {Promise<void>} resolves when Chrome took it.
   */
  async key(type, key) {
    this.touched = Date.now()
    const virtual = key.keyCode ?? key.windowsVirtualKeyCode ?? 0
    await this.input('Input.dispatchKeyEvent', {
      type: key.text === undefined || key.text === '' ? type : (type === 'keyDown' ? 'keyDown' : type),
      key: key.key, // ui-copy-ignore
      code: key.code ?? '', // ui-copy-ignore
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: key.nativeVirtualKeyCode ?? virtual,
      text: key.text, // ui-copy-ignore
      unmodifiedText: key.text,
      modifiers: key.modifiers ?? 0,
    })
  }

  /** @param {string} text - any unicode, including Chinese. @returns {Promise<void>} resolves when typed. */
  async insertText(text) {
    this.touched = Date.now()
    await this.input('Input.insertText', { text })
  }

  /** @returns {Promise<string>} a full-size screenshot as base64 PNG. */
  async screenshot() {
    this.touched = Date.now()
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' })
    return String(data ?? '')
  }

  /**
   * @param {{full?: boolean, rect?: {x: number, y: number, width: number, height: number}, scale?: number}} [options] - what to capture.
   * @returns {Promise<string>} base64 PNG; `full` ignores the viewport.
   */
  async shot(options = {}) {
    this.touched = Date.now()
    /** @type {any} */
    const args = { format: 'png' }
    if (options.rect) {
      args.clip = { ...options.rect, scale: options.scale ?? 1 }
      args.captureBeyondViewport = options.full === true
    } else if (options.full === true) {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({w: Math.max(document.documentElement.scrollWidth, innerWidth), h: Math.max(document.documentElement.scrollHeight, innerHeight)})',
        returnByValue: true,
      })
      const size = JSON.parse(String(result?.value ?? '{"w":1440,"h":900}'))
      args.clip = { x: 0, y: 0, width: Math.min(size.w, 8000), height: Math.min(size.h, 20000), scale: options.scale ?? 1 }
      args.captureBeyondViewport = true
    }
    const { data } = await this.cdp.send('Page.captureScreenshot', args)
    return String(data ?? '')
  }

  /** @returns {Promise<string>} base64 PDF of the whole document. */
  async pdf() {
    this.touched = Date.now()
    const { data } = await this.cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true })
    return String(data ?? '')
  }

  /** Allow the page to use the clipboard; without this the API rejects. */
  async allowClipboard() {
    let origin = 'http://localhost'
    try {
      origin = new URL(this.url).origin
    } catch {
      /* a blank page has no origin yet */
    }
    await this.cdp.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      origin,
    }).catch(() => {})
  }

  /** @returns {Promise<string>} clipboard text, or an empty string when the page cannot read it. */
  async clipboardRead() {
    await this.allowClipboard()
    const { result } = await this.cdp.send('Runtime.evaluate', {
      expression: 'navigator.clipboard.readText().then((text) => JSON.stringify({ text }))',
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    try {
      return String(JSON.parse(String(result?.value ?? '{"text":""}')).text ?? '')
    } catch {
      return ''
    }
  }

  /** @param {string} text - what to put on the clipboard. @returns {Promise<void>} resolves when written. */
  async clipboardWrite(text) {
    await this.allowClipboard()
    await this.cdp.send('Runtime.evaluate', {
      expression: `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true)`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
  }

  /** @param {number} sessionId - the screencast frame being acknowledged. */
  /**
   * The cookies this profile holds, newest state, straight from the browser.
   * @param {string[]} [urls] - only cookies the given addresses would send.
   * @returns {Promise<Array<{name: string, value: string, domain: string, path: string, secure: boolean, httpOnly: boolean}>>} cookies.
   */
  async cookies(urls) {
    if (Array.isArray(urls) && urls.length > 0) {
      const { cookies: found } = await this.cdp.send('Network.getCookies', { urls })
      return found ?? []
    }
    const { cookies: all } = await this.cdp.send('Network.getAllCookies')
    return all ?? []
  }

  /**
   * @param {{name: string, value: string, domain?: string, path?: string, secure?: boolean, httpOnly?: boolean, sameSite?: string}} cookie - what to keep.
   * @returns {Promise<{ok: boolean, reason?: string}>} whether the browser took it.
   */
  async setCookie(cookie) {
    const params = {
      name: cookie.name, // ui-copy-ignore
      value: cookie.value, // ui-copy-ignore
      path: cookie.path ?? '/', // ui-copy-ignore
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
    }
    if (cookie.domain !== undefined) params.domain = cookie.domain
    else params.url = this.url
    if (cookie.sameSite !== undefined) params.sameSite = cookie.sameSite
    const answer = await this.cdp.send('Network.setCookie', params)
    return { ok: answer?.success === true, reason: String(answer?.error ?? '') }
  }

  /** @returns {Promise<void>} drops every cookie in this profile. */
  async clearCookies() {
    await this.cdp.send('Network.clearBrowserCookies')
  }

  async ack(sessionId) {
    await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  }
}

/**
 * The Host's own Chrome. // ui-copy-ignore
 *
 * One instance per plugin, reattachable: a plugin reload must not log the
 * person out, so an already-running sidecar is adopted through its port file // ui-copy-ignore
 * instead of being spawned again.
 */
/** Where a profile keeps the cookies a browser would otherwise drop on exit. */
function sessionJar(dir) {
  return join(dir, 'session-cookies.json') // ui-copy-ignore
}

/** Where a profile keeps what the page downloads. */
function downloadsDir(dir) {
  return join(dir, 'downloads')
}

export class Sidecar {
  /** @param {{logger?: any}} options - logging. */
  constructor(options = {}) {
    this.logger = options.logger
    this.child = null
    this.cdp = null
    this.page = null
    /* A measurement or a test may want a profile of its own; the person's
       browser keeps the default one. */
    this.profile = String(options.profile ?? 'default')
    this.headless = true
    this.starting = null
    this.idle = null
    this.lastError = ''
    this.lastUrl = ''
  }

  /**
   * Files downloaded so far. Asking a stopped browser is not an error.
   * @returns {{name: string, bytes: number, at: string}[]} what is on disk.
   */
  downloads() {
    if (this.page === null) return []
    return this.page.downloads()
  }

  /**
   * Responses so far. Asking a stopped browser is an empty list, not an error.
   * @returns {{method: string, url: string, type: string, status: number}[]} the requests.
   */
  network() {
    if (this.page === null) return []
    return this.page.networkList()
  }

  get alive() {
    return this.cdp !== null && !this.cdp.closed && this.page !== null
  }

  /** @param {string} text - why the sidecar is not usable. */
  note(text) {
    this.lastError = text
    this.logger?.warn?.('dsh-inner-browser-use: sidecar %s', text)
  }

  /**
   * @param {{profile?: string, headless?: boolean, url?: string}} [options] - how to start.
   * @returns {Promise<SidecarPage>} the page being driven.
   */
  async ensure(options = {}) {
    if (options.profile !== undefined) this.profile = options.profile
    if (options.headless !== undefined) this.headless = options.headless !== false
    if (this.alive) {
      const page = this.page
      /* A page that stopped answering is a page nobody can drive. Start a new
         one on the address it was showing, rather than failing every call. */
      let probe = page.dialog !== null && page.dialog !== undefined ? { ok: true } : await page.ping()
      if (!probe.ok && !probe.closed) {
        await wait(150)
        probe = await page.ping()
      }
      if (!probe.ok) {
        page.crashed = true
        this.note('renderer stopped answering; opening a fresh tab')
        const wasAt = options.url ?? page.lastUrl ?? this.lastUrl
        /* The browser itself is usually fine: only the renderer died. Opening a
           fresh tab in it is much faster than starting Chrome again. */
        try {
          return await this.recover(wasAt)
        } catch {
          await this.shutdown()
          return this.ensure({ ...options, url: wasAt })
        }
      }
      this.touch()
      if (options.url !== undefined && options.url !== '') await this.page.navigate(options.url)
      return this.page
    }
    if (this.starting !== null) return this.starting
    /* A page whose connection closed on its own (a renderer crash closes the
       tab's session) can be replaced in the browser that is still running. */
    if (this.page !== null && this.page.cdp?.closed === true) {
      const wasAt = options.url ?? this.page.lastUrl ?? this.lastUrl
      this.page.crashed = true
      this.note('renderer stopped answering; opening a fresh tab')
      this.starting = this.recover(wasAt).catch((error) => {
        this.note(String(error?.message ?? error))
        return this.launch(wasAt)
      }).finally(() => {
        this.starting = null
      })
      return this.starting
    }
    this.starting = this.launch(options.url).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** @param {string | undefined} url - first address. @returns {Promise<SidecarPage>} the page. */
  async launch(url) {
    const dir = profileDir(this.profile)
    let port = await this.runningPort(dir) // ui-copy-ignore
    if (port === 0) port = await this.spawnChrome(dir) // ui-copy-ignore
    const ws = await this.pageSocket(port) // ui-copy-ignore
    const cdp = new Cdp(ws)
    await cdp.ready
    this.cdp = cdp
    this.page = await new SidecarPage(cdp, this.profile, port).start() // ui-copy-ignore
    if (url !== undefined && url !== '') this.lastUrl = String(url)
    await this.restoreSessionCookies()
    await this.page.cast()
    if (url !== undefined && url !== '') await this.page.navigate(url)
    this.touch()
    this.logger?.info?.('dsh-inner-browser-use: sidecar up on port %s (%s)', port, this.headless ? 'headless' : 'windowed') // ui-copy-ignore
    return this.page
  }

  /**
   * @param {string} dir - profile directory.
   * @returns {Promise<number>} the port of a sidecar already using it, or 0. // ui-copy-ignore
   */
  async runningPort(dir) {
    const file = join(dir, 'DevToolsActivePort')
    if (!existsSync(file)) return 0
    const claimed = Number(String(readFileSync(file, 'utf8')).split('\n')[0] ?? 0)
    if (!Number.isFinite(claimed) || claimed <= 0) return 0
    try {
      const response = await fetch(`http://127.0.0.1:${claimed}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (!response.ok) return 0
      return claimed
    } catch {
      try {
        rmSync(file, { force: true })
      } catch {
        /* a stale port file is harmless */ // ui-copy-ignore
      }
      return 0
    }
  }

  /**
   * @param {string} dir - profile directory.
   * @returns {Promise<number>} the port Chrome opened. // ui-copy-ignore
   */
  async spawnChrome(dir) {
    const binary = firstBinary()
    if (binary === undefined) throw new Error('sidecar: no Chrome found on this machine')
    const args = [
      `--user-data-dir=${dir}`,
      '--remote-debugging-port=0', // ui-copy-ignore
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--disable-sync',
      /* The driver clicks for a person, and a page that opens a tab on a click
         is doing what the page means to do. Blocking it would strand the
         mirror on the old page. */
      '--disable-popup-blocking',
      /* A crash-restore bubble would sit on the person's screen and is not how
         this browser is meant to come back; the profile itself is the state. */
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      /* A background page is throttled to about one frame a second, and the
         mirror would show a slideshow: nothing here is background work. */
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--password-store=basic',
      '--lang=zh-CN',
      `--window-size=${VIEW.width},${VIEW.height}`,
      'about:blank',
    ]
    if (this.headless) args.unshift('--headless=new')
    const child = spawn(binary, args, { detached: false, stdio: 'ignore' })
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.cdp?.close()
        this.cdp = null
        this.page = null
      }
    })
    this.child = child
    const file = join(dir, 'DevToolsActivePort')
    for (let i = 0; i < 150; i += 1) {
      await wait(100)
      if (!existsSync(file)) continue
      const port = Number(String(readFileSync(file, 'utf8')).split('\n')[0] ?? 0) // ui-copy-ignore
      if (Number.isFinite(port) && port > 0) return port // ui-copy-ignore
    }
    throw new Error('sidecar: Chrome did not open a debugging port') // ui-copy-ignore
  }

  /**
   * @param {number} port - debugging port. // ui-copy-ignore
   * @returns {Promise<string>} the page target's socket.
   */
  /**
   * Replace a dead page with a fresh tab in the same browser, on the same address.
   * @param {string} url - where the person was.
   * @returns {Promise<SidecarPage>} the new page.
   */
  /**
   * The browser's pages, in the order the browser lists them.
   * @returns {Promise<Array<{targetId: string, title: string, url: string, current: boolean}>>} the tabs.
   */
  async tabs() {
    return this.page === null ? [] : this.page.tabs()
  }

  /**
   * Move the mirror to another tab, leaving the old one open where it was.
   * @param {number} index - a row from `tabs()`.
   * @returns {Promise<SidecarPage>} the page now being driven.
   */
  async useTab(index) {
    const list = await this.tabs()
    const tab = list[Number(index)]
    if (tab === undefined) throw new Error(`sidecar: no tab ${String(index)}`)
    if (tab.current) return this.page
    const was = this.page
    const cdp = new Cdp(tab.webSocketUrl)
    await cdp.ready
    const page = await new SidecarPage(cdp, this.profile, was.port).start() // ui-copy-ignore
    this.cdp = cdp
    this.page = page
    this.lastUrl = tab.url
    await page.cast()
    was.cdp.send('Page.stopScreencast').catch(() => {})
    was.cdp.close()
    this.touch()
    return page
  }

  /**
   * Close a tab; the mirror moves to a neighbour when the closed one was shown.
   * @param {number} index - a row from `tabs()`.
   */
  async closeTab(index) {
    const list = await this.tabs()
    const tab = list[Number(index)]
    if (tab === undefined) throw new Error(`sidecar: no tab ${String(index)}`)
    let port = this.page?.port ?? 0 // ui-copy-ignore
    let alone = true
    if (tab.current) {
      const other = list.findIndex((item) => !item.current)
      alone = other < 0
      if (!alone) await this.useTab(other)
    }
    if (port > 0) await fetch(`http://127.0.0.1:${port}/json/close/${tab.targetId}`, { signal: AbortSignal.timeout(1000) }).catch(() => {}) // ui-copy-ignore
    if (alone) {
      await this.shutdown()
      await this.ensure()
    }
  }

  async recover(url) {
    const port = this.page?.port ?? 0 // ui-copy-ignore
    if (port === 0) throw new Error('sidecar: no browser to recover into') // ui-copy-ignore
    const address = url === '' || url === undefined ? 'about:blank' : String(url)
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(address)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) // ui-copy-ignore
    if (!created.ok) throw new Error('sidecar: could not open a tab to recover into')
    const target = await created.json()
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('sidecar: recovered tab has no socket')
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    this.cdp = cdp
    this.page = await new SidecarPage(cdp, this.profile, port).start() // ui-copy-ignore
    await this.page.cast()
    this.touch()
    return this.page
  }

  async pageSocket(port) { // ui-copy-ignore
    for (let i = 0; i < 60; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }) // ui-copy-ignore
        const targets = await response.json()
        const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
        if (page !== undefined) return page.webSocketDebuggerUrl
        const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(1500) }) // ui-copy-ignore
        if (created.ok) {
          const target = await created.json()
          if (typeof target.webSocketDebuggerUrl === 'string') return target.webSocketDebuggerUrl
        }
      } catch {
        /* Chrome is still coming up */
      }
      await wait(200)
    }
    throw new Error('sidecar: Chrome has no page target')
  }

  /**
   * Attach one viewer to the frame stream.
   * @param {(frame: any) => void} sink - called per frame.
   * @returns {Promise<() => void>} detach.
   */
  async watch(sink) {
    const page = await this.ensure()
    page.frames.add(sink)
    page.pointerSinks.add(sink)
    await page.cast()
    return () => {
      page.frames.delete(sink)
      page.pointerSinks.delete(sink)
      if (page.frames.size === 0) void page.stopCast()
    }
  }

  touch() {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = null
      /* Someone is watching the mirror: the page stays up, and the clock starts
         again so the browser is closed only once it is truly unused. */
      if ((this.page?.frames.size ?? 0) > 0) {
        this.touch()
        return
      }
      void this.shutdown()
    }, IDLE_MS)
    this.idle.unref?.()
  }

  /** @returns {Promise<void>} resolves once Chrome is gone. */
  async shutdown() {
    /* Ask Chrome to close first: a browser that is killed outright may lose the
       last minute of cookies, and keeping the person signed in is the point. */
    if (this.page !== null) await this.saveSessionCookies()
    if (this.cdp !== null) {
      await this.cdp.send('Browser.close').catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.page = null
    this.cdp?.close()
    this.cdp = null
    if (this.child !== null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      this.child = null
    }
  }

  /**
   * Chrome drops session cookies when it closes, and most sign-ins are session
   * cookies. Keeping them here is what lets a person stay signed in across a
   * reload of the app, which is the whole point of the profile.
   * @returns {Promise<void>} done.
   */
  async saveSessionCookies() {
    try {
      const jar = (await this.page.cookies()).filter((c) => c.session === true || Number(c.expires) < 0)
      const file = sessionJar(profileDir(this.profile))
      if (jar.length === 0) {
        rmSync(file, { force: true })
        return
      }
      writeFileSync(file, JSON.stringify(jar), { mode: 0o600 })
    } catch {
      /* a browser that is already gone has nothing to save */
    }
  }

  /** @returns {Promise<void>} puts back what saveSessionCookies kept. */
  async restoreSessionCookies() {
    let jar = []
    try {
      jar = JSON.parse(String(readFileSync(sessionJar(profileDir(this.profile)), 'utf8')))
    } catch {
      return
    }
    if (!Array.isArray(jar)) return
    for (const cookie of jar.slice(0, 200)) {
      const domain = String(cookie?.domain ?? '').replace(/^\./, '')
      if (domain === '') continue
      try {
        await this.page.setCookie({
          name: String(cookie.name),
          value: String(cookie.value),
          domain,
          path: String(cookie.path ?? '/'),
          secure: cookie.secure === true,
          httpOnly: cookie.httpOnly === true,
          sameSite: cookie.sameSite,
        })
      } catch {
        /* one stale cookie must not stop the others */
      }
    }
  }

  /** @returns {Promise<Record<string, unknown>>} what the sidecar is doing. */
  async state() {
    const profiles = (() => {
      try {
        return readdirSync(rootDir()).filter((name) => statSync(join(rootDir(), name)).isDirectory())
      } catch {
        return []
      }
    })()
    return {
      alive: this.alive, // ui-copy-ignore
      profile: this.profile, // ui-copy-ignore
      headless: this.headless, // ui-copy-ignore
      url: this.page?.url ?? '', // ui-copy-ignore
      title: this.page?.title ?? '',
      viewers: this.page?.frames.size ?? 0,
      frames: this.page?.seq ?? 0,
      crashed: this.page?.crashed === true,
      pointer: this.page?.pointer ?? null,
      profiles,
      error: this.alive ? '' : this.lastError,
    }
  }
}
