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

  /**
   * @param {string} method - CDP method.
   * @param {Record<string, unknown>} params - its parameters.
   * @returns {Promise<any>} its result.
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('sidecar: CDP session is closed'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify({ id, method, params }))
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
  constructor(cdp, profile) {
    this.cdp = cdp
    this.profile = profile
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
    this.title = ''
    this.casting = false
    this.inflight = 0
    this.touched = Date.now()
    /* A dialog blocks the page until someone answers it, so it is state, not an
       event: the driver can look at it before deciding. */
    this.dialog = null
    this.console = []
    this.failed = []
  }

  /**
   * Record the page events that matter to a driver: dialogs, console lines and
   * failed requests. Buffers are capped so a chatty page cannot grow memory.
   * @param {any} message - one CDP message.
   */
  watch(message) {
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
    if (message.method === 'Network.loadingFailed') {
      const params = message.params ?? {}
      if (params.canceled === true) return
      this.failed.push({ error: String(params.errorText ?? ''), type: String(params.type ?? '') })
      if (this.failed.length > 100) this.failed.splice(0, 25)
    }
  }

  /** Keep one listener that fans frames out to every viewer. */
  async start() {
    await this.cdp.send('Network.enable').catch(() => {})
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
    await this.cdp.send('Page.navigate', { url })
    for (let i = 0; i < 200; i += 1) {
      await wait(100)
      await this.readTitle()
      if (this.url !== '' && this.url !== 'about:blank') break
    }
    return { url: this.url, title: this.title }
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
    await this.input('Input.dispatchKeyEvent', {
      type: key.text === undefined || key.text === '' ? type : (type === 'keyDown' ? 'keyDown' : type),
      key: key.key, // ui-copy-ignore
      code: key.code ?? '', // ui-copy-ignore
      windowsVirtualKeyCode: key.keyCode ?? 0,
      nativeVirtualKeyCode: key.keyCode ?? 0,
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
      this.touch()
      if (options.url !== undefined && options.url !== '') await this.page.navigate(options.url)
      return this.page
    }
    if (this.starting !== null) return this.starting
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
    this.page = await new SidecarPage(cdp, this.profile).start()
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
      pointer: this.page?.pointer ?? null,
      profiles,
      error: this.alive ? '' : this.lastError,
    }
  }
}
