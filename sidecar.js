/**
 * The sidecar browser: a real Chrome that the Host owns. // ui-copy-ignore
 *
 * A separate process with its own on-disk profile: a login survives a restart,
 * and a page keeps working while the person looks somewhere else. The column
 * shows it as a screencast, so the tab is a viewer, not the browser.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readyFlash } from './runtime/flash-setup.mjs'
import { isMedia, kindOf } from './media.js?m=1'

/**
 * Windows keeps a browser under Program Files (machine-wide) or LocalAppData
 * (per-user), and Edge is Chromium too, so it speaks the same DevTools
 * protocol. Chrome is still preferred: the list is read in order.
 * @returns {string[]} candidates, most preferred first.
 */
function windowsBrowserCandidates() {
  const roots = [
    process.env['PROGRAMFILES'],
    process.env['PROGRAMFILES(X86)'],
    process.env['LOCALAPPDATA'],
  ].filter((root) => typeof root === 'string' && root !== '')
  const out = []
  for (const root of roots) out.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  for (const root of roots) out.push(join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  return out
}

/** Chrome builds this machine may have, most preferred first. */
const CHROME_BINARIES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  ...(process.platform === 'win32' ? windowsBrowserCandidates() : []),
]

/** Viewport the screencast and the pointer share. Nothing here is a user-agent detail. */
export const VIEW = { width: 1440, height: 900 }

/** What a person's Chrome on this machine sends. */
export const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

/**
 * Pixels the mirror actually sends. The viewport is never downscaled: a
 * half-size JPEG turns 12px body text into mush in a column this narrow, and
 * the sharpness is what makes the mirror feel like the page. Quality stops
 * short of lossless so a moving picture still arrives on the next frame.
 */
/* The mirror runs at a rate the eye reads as live without spending CPU on
   frames nobody asked for. */
const MIRROR = { width: VIEW.width, height: VIEW.height, interval: 66, busy: 40 }


/** Frames are dropped rather than queued: a lagging viewer must not slow the page. */
const MAX_INFLIGHT_FRAMES = 2
/* The pane is watched by a person, not recorded: a 60 fps page forwarded frame
   for frame doubles the downlink and the client's decode work for a picture no
   eye can tell apart at 30 fps. Kept below one screen refresh. */
/* How long a click waits for a tab to be announced before answering: enough
   for the tabs a click opens directly, not for the page's own timers. */
const POPUP_GRACE_MS = 25
/* How long after a click an announced tab is still followed with no call
   waiting: the page may open it from a timer or a promise. */
const FOLLOW_WINDOW_MS = 2000
const FRAME_GAP_MS = 28

/* The mirror is a photograph of a page, not an archive of one: quality that
   keeps small text readable is the ceiling, and a page whose frame is heavy
   gets a lighter one so the round trip stays short. */
const CAST_QUALITY = 72 // ui-copy-ignore
const QUALITY_FLOOR = 44 // ui-copy-ignore
const QUALITY_CEILING = 76 // ui-copy-ignore

/**
 * Decide the next JPEG quality from the weight of the frame seen. A frame
 * near 90 KB of base64 is a heavy page: lowering quality by 8 costs a little
 * sharpness and saves a lot of transport. A small frame has room to sharpen.
 * @param {number} current - quality now.
 * @param {number} base64 - base64 length of the frame.
 * @returns {number} the quality to cast at next; `current` when it is fine.
 */
export function nextQuality(current, base64) {
  const size = Number(base64)
  if (!Number.isFinite(size) || size <= 0) return current
  if (size > 120_000) return Math.max(QUALITY_FLOOR, current - 8)
  if (size < 45_000) return Math.min(QUALITY_CEILING, current + 4)
  return current
}

/** Idle lifetime, so a forgotten sidecar does not sit on a login forever. */
const IDLE_MS = 15 * 60_000
/* A pane the person closed is a stronger signal than a pane nobody touched: the
   browser is put away a minute later unless someone asks for it again. A whole
   Chrome with its renderers is a few hundred megabytes, and leaving it up for a
   quarter of an hour after a deliberate close is exactly the cost they did not
   want. */
const REST_MS = 60_000
/* One browser serves every chat, but a chat that is not on screen need not keep
   a full renderer alive for ever: past this many chats the oldest unwatched tab
   is closed, and its address brings it back on the next visit. */
const MAX_TABS = 6
/* A tab nobody has watched or driven for this long is closed even under the cap:
   six chats can stay open for days, and each one is a renderer's worth of memory. */
const TAB_IDLE_MS = 10 * 60_000

/** @param {number} ms - how long to wait. @returns {Promise<void>} resolves after it. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {string} path - candidate. @returns {string | undefined} the one that exists. */
function firstBinary() {
  return CHROME_BINARIES.find((path) => existsSync(path))
}

/* A movie page needs a Flash runtime, and current Chrome has none. Electron 11
   still carries Chromium 87, the last build that took PPAPI, so the same
   debugging protocol drives a browser that can play the page. Neither the
   browser nor the plugin is in this package: the switch fetches one and reuses
   the other, both on the person's own machine. */
const FLASH_APP = fileURLToPath(new URL('./runtime/flash-app/', import.meta.url))

/**
 * Everything a Flash page needs, or nothing when this machine cannot play one.
 * @returns {{binary: string, plugin: string, version: string} | null} the runtime.
 */
export function flashRuntime() {
  const ready = readyFlash()
  if (ready === null) return null
  const version = String(process.env.DSH_INNER_BROWSER_FLASH_VERSION ?? '32.0.0.371')
  return { binary: ready.electron, plugin: ready.plugin, version }
}

/* A chat's tab address outlives a plugin reload: the browser is still running
   with that tab, and the chat that returns should get its page back, not a
   blank one. */
const tabsDir = process.env.DSH_INNER_BROWSER_STATE_DIR || join(homedir(), '.dsh', 'inner-browser-use')
const tabsFile = join(tabsDir, 'tabs.json')
/** @type {Record<string, string> | null} */
let tabsCache = null
/* Which runtime the person chose outlives a plugin reload for the same reason
   the tab address does: a reload must not quietly turn the game window back
   into a Chrome window that cannot play it. */
const flashFile = join(tabsDir, 'flash.json')

/** @returns {boolean} true when the Flash runtime was chosen last time. */
function readFlashChoice() {
  try {
    return JSON.parse(readFileSync(flashFile, 'utf8')).on === true
  } catch {
    return false
  }
}

/** @param {boolean} on - record the runtime choice. */
let flashChoice = null
function writeFlashChoice(on) {
  /* Every tool call states its runtime, but almost never changes it: writing
     the same byte per keystroke was a disk write inside the typing path. */
  const value = on === true
  if (flashChoice === value) return
  try {
    mkdirSync(tabsDir, { recursive: true })
    writeFileSync(flashFile, JSON.stringify({ on: value }))
    flashChoice = value
  } catch {}
}

/** Root of everything this plugin keeps for the sidecar. */
export function rootDir() {
  /* A probe, a test or a second app that was told to keep its files elsewhere
     keeps its browsers elsewhere too. Pointing this at the person's directory
     would let it find and drive the browser they are looking at. */
  const base = process.env.DSH_INNER_BROWSER_STATE_DIR || join(homedir(), '.dsh', 'inner-browser-use')
  const dir = join(base, 'chrome')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Whether a target is not this page's to take: its own tab or one another chat
 * is driving.
 * @param {string} targetId - candidate target.
 * @param {string} mine - the asking page's own target.
 * @param {string[]} [foreign] - targets other chats drive.
 * @returns {boolean} true when the candidate must be left alone.
 */
export function isForeign(targetId, mine, foreign = []) {
  const id = String(targetId ?? '')
  if (id === '') return true
  if (id === String(mine ?? '')) return true
  return foreign.map(String).includes(id)
}

/**
 * Where the cookies of a profile are kept in the browser's own storage.
 */
/**
 * The topmost process this plugin lives in: the application itself, not the
 * node instance a reload replaces. A reload changes `process.pid`, so a watcher
 * keyed to it kills the shared browser the moment the old instance goes — which
 * is how the mirror went blank after a reload.
 * @returns {number} the application pid, or 0 when it cannot be walked.
 */
function appPid() {
  let pid = process.pid
  let top = pid
  for (let hop = 0; hop < 12; hop += 1) {
    let parent = 0
    try {
      parent = Number(String(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })).trim())
    } catch {
      break
    }
    if (!Number.isInteger(parent) || parent <= 1) break
    top = parent
    pid = parent
  }
  return top === process.pid ? 0 : top
}

/**
 * Whether a process command line is the application itself, rather than the node
 * instance a reload replaces. A watcher keyed to the node instance would kill
 * the shared browser on every reload, which is exactly what made the column go
 * blank; a command line with `--expose-internals` is that instance.
 * @param {string} command - what `ps -o command=` said.
 * @returns {boolean} true for the app binary itself.
 */
export function looksLikeApp(command) {
  const line = String(command ?? '')
  if (line.includes('--expose-internals')) return false
  return line.includes('.app/Contents/MacOS/')
}

/**
 * @param {number} pid - a process.
 * @returns {string} its command line, or '' when it is gone.
 */
function commandOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return ''
  try {
    return String(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })).trim()
  } catch {
    return ''
  }
}

/**
 * Whether this run may arm the watcher at all: never on Windows, where the
 * browser tree ends with the application through `taskkill /T`, and only inside
 * the application itself, since a note keyed to anything else would close the
 * shared browser on a plugin reload.
 * @returns {boolean} true when `handoff()` can write a watcher note.
 */
export function canArmWatcher() {
  if (process.platform === 'win32') return false
  const app = appPid()
  return app !== 0 && looksLikeApp(commandOf(app)) === true
}

/** The watcher that closes the browser when the app goes: one per app run. */
function watcherFile(dir) {
  return join(dir, 'watcher.json')
}

/**
 * One line describing a browser that went away by itself, so the next person to
 * look knows whether it was asked to stop, crashed, or was killed from outside.
 * @param {{pid?: number, code?: number|null, signal?: string|null, profile?: string}} gone - what the child reported.
 * @returns {string} a line without a newline.
 */
export function deathNote(gone) {
  const at = new Date().toISOString()
  const code = gone.code === null || gone.code === undefined ? 'none' : String(gone.code)
  return `${at} browser pid ${String(gone.pid ?? 0)} profile ${String(gone.profile ?? 'default')} exit code ${code} signal ${String(gone.signal ?? 'none')}`
}

/**
 * Appends one line to the browser log and never troubles the caller, because a
 * browser that died while nothing was watching should not also break the call
 * that noticed.
 * @param {{pid?: number, code?: number|null, signal?: string|null, profile?: string, asked?: boolean}} gone - what happened.
 * @param {string} [dir] - where the log lives; the state directory by default.
 * @returns {void}
 */
/**
 * Whether this process is the one that started this browser. A browser found on
 * a profile may have been started by another process — a second app, a script
 * that forgot to quit — and closing it would take the person's own window with
 * it. Only the process that wrote the marker may ask it to close.
 * @param {{pid?: number, owner?: number}} said - this process, and the marker's pid.
 * @returns {boolean} true while this process started it.
 */
export function ownsBrowser(said) {
  const mine = Number(said?.pid ?? 0)
  const owner = Number(said?.owner ?? 0)
  if (!Number.isInteger(mine) || mine <= 0) return false
  return mine === owner
}

/** @param {string} dir - profile directory. @returns {number} the pid that started this browser, or 0. */
function markerPid(dir) {
  try {
    const said = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) // ui-copy-ignore
    const pid = Number(said?.pid ?? 0) // ui-copy-ignore
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

export function noteDeath(gone, dir = tabsDir) {
  if (gone.asked === true) return
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'browser.log'), `${deathNote(gone)}\n`)
  } catch {
    /* a log is a convenience, not a promise */
  }
}

const COOKIE_FILES = ['Default/Cookies', 'Local State']

/**
 * @param {string} dir - a profile directory.
 * @returns {string} where its cookie snapshots live.
 */
export function loginBackupDir(dir) {
  // A Windows profile path has no '/', so splitting on it returned the whole
  // path and the backup landed at `.../login/C:\Users\…` — a mkdir that fails.
  const last = dir.split(/[\\/]/u).filter(Boolean).pop() ?? 'default'
  return join(tabsDir, 'login', last)
}

/**
 * Copies the cookie store aside while it is still good, so a profile that loses
 * its cookies another way can be handed the ones that were working.
 * @param {string} dir - a profile directory.
 * @returns {number} how many snapshots are kept.
 */
export function snapshotLogin(dir) {
  const files = COOKIE_FILES.map((name) => ({ name, from: join(dir, name) })).filter((row) => existsSync(row.from))
  if (files.length === 0) return 0
  const to = loginBackupDir(dir)
  mkdirSync(to, { recursive: true })
  const stamp = String(Date.now())
  for (const row of files) copyFileSync(row.from, join(to, `${stamp}-${row.name.replace(/\//g, '_')}`))
  const mine = readdirSync(to).filter((name) => name.startsWith(`${stamp}-`))
  const older = readdirSync(to).filter((name) => !mine.includes(name)).sort()
  const generations = 5
  const keep = older.slice(-generations * files.length)
  for (const name of older) if (!keep.includes(name)) rmSync(join(to, name), { force: true })
  return older.length + mine.length
}

/**
 * Puts the newest snapshot back when the profile has no cookie store at all.
 * @param {string} dir - a profile directory.
 * @returns {boolean} whether anything was restored.
 */
export function restoreLogin(dir) {
  const cookie = join(dir, 'Default/Cookies')
  if (existsSync(cookie) && statSync(cookie).size > 1000) return false
  const from = loginBackupDir(dir)
  if (!existsSync(from)) return false
  const names = readdirSync(from).sort()
  const newest = names.filter((name) => name.includes('-Default_Cookies')).slice(-1)[0]
  const state = names.filter((name) => name.includes('-Local_State')).slice(-1)[0]
  if (newest === undefined) return false
  mkdirSync(join(dir, 'Default'), { recursive: true })
  copyFileSync(join(from, newest), cookie)
  if (state !== undefined) copyFileSync(join(from, state), join(dir, 'Local State'))
  return true
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
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          /* A listener that throws — a frame handler calling something the page
             no longer has — costs that one event. It must not take the host
             process with it. */
        }
      }
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
/**
 * Whether two addresses show the same place: a fragment never changes the page.
 * @param {string} a - one address.
 * @param {string} b - another address.
 * @returns {string} the shared key, or '' when they differ.
 */
function placeKey(value) {
  const said = String(value ?? '')
  if (said === '') return ''
  try {
    const url = new URL(said)
    url.hash = ''
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host}${path}${url.search}`
  } catch {
    return said
  }
}

function samePlace(a, b) {
  const key = placeKey(a)
  return key !== '' && key === placeKey(b)
}

export class SidecarPage {
  /** @param {Cdp} cdp - the page session. @param {string} profile - profile name. */
  constructor(cdp, profile, port, hold = () => 0) { // ui-copy-ignore
    this.cdp = cdp
    /* Whether the person is driving. The page cannot reach the sidecar that
       owns this person record, so the answer arrives as a callable and this
       class never assumes it has a `holding` of its own. Anything that is not
       a callable is not a reason to throw from a paint or input callback. */
    this.holdOf = typeof hold === 'function' ? hold : () => 0
    this.profile = profile
    this.port = port // ui-copy-ignore
    this.epoch = 0
    this.frames = new Set()
    /* Pointer moves are their own, tiny message: the arrow follows the agent at
       once instead of waiting for the next picture to be painted. */
    this.pointerSinks = new Set()
    this.latest = ''
    this.seq = 0
    this.lastFrameAt = 0
    this.sentAt = 0
    /* Total JPEG bytes seen, for the bench and for noticing when a page got
       expensive to watch. */
    this.bytes = 0
    /* The page lays out at the size of the column it is shown in, not at a
       fixed desktop size: a mirror with letterbox bands is a page that does
       not fill its frame. */
    this.view = { width: VIEW.width, height: VIEW.height }
    /* What the pane already has: an unchanged picture is not worth a second
       copy, but silence still needs a heartbeat or the pane thinks the stream
       died. */
    this.lastShot = null
    this.lastShotAt = 0
    this.quiet = 0
    this.pointer = { x: VIEW.width / 2, y: VIEW.height / 2 }
    this.lastPointerAt = 0
    /* Set when this page is drawn by the Flash runtime instead of a screencast. */
    this.flashBridge = null
    this.url = ''
    this.lastUrl = ''
    this.crashed = false
    this.title = ''
    this.casting = false
    /* The cast quality moves with what the page costs to transport. */
    /* A big viewport carries more pixels per frame; it starts lighter and the
       first heavy frame settles the rest. */
    this.castQuality = VIEW.width * VIEW.height > 1_000_000 ? 60 : CAST_QUALITY // ui-copy-ignore
    this.adaptAt = 0
    this.inflight = 0
    this.touched = Date.now()
    /* A dialog blocks the page until someone answers it, so it is state, not an
       event: the driver can look at it before deciding. */
    this.dialog = null
    this.console = []
    this.failed = []
    /* A page that stops working usually says why in its console or its network
       log, and the model only looks there after guessing. Each entry carries a
       number so the next read can mention what happened since the last one. */
    this.troubleSeq = 0
    this.troubleSeen = 0
    /* When a frame last began or finished loading. A click that started no load
       changed the page in place, and waiting on it would be wasted time. */
    this.navStarted = 0
    this.navStopped = 0
    /* When the main frame's load last finished. A navigation that is over is
       known from this event, without asking a renderer that a page's own
       scripts may be holding. */
    this.loadFired = 0
    /* A browser reset a crashed tab to about:blank; that is not a new tab. */
    this.blanked = false
    /* What the page asked for, so a page that fills itself from addresses can
       be understood without a screenshot or a retry. */
    this.network = []
    this.requests = new Map()
    /* The movie a page plays is one of the requests it already made, so the
       file behind it costs no second look: the network log is the sniff. */
    this.media = new Map()
    /* A PDF is a document the mirror cannot draw: Chrome leaves the page blank
       and a model looking at it would think the address was empty. What it is
       and where the bytes went is state, not a guess. */
    this.pdf = null
    /* frame id -> the world its page script runs in. A control inside an iframe
       is only reachable through that world; the frame list is read when the
       read model needs it. */
    this.contexts = new Map()
    this.frameOrder = []
    /* A click can open a tab. Chrome tells us the new target; the mirror then
       follows it, because a person looking at the column expects that too. */
    this.children = new Map()
    this.opened = null
    /* Woken when discovery announces a popup, so a click without one does not
       wait the whole fallback window to learn there is nothing to follow. */
    this.popupDoor = null
    /* A popup is announced before it knows where it will go; the address
       arrives a moment later. Waiting for it is what lets the click follow. */
    this.urlDoor = null
    /* A popup that shows up after the click has already answered is still the
       page the click opened: for a moment after a click, an announced tab is
       followed even though no call is waiting for it. */
    this.followUntil = 0
    this.followTimer = null
    /* When the address was last asked for: how long a failure took tells a
       browser still starting up apart from a network that said no. */
    this.navAt = 0
    /* The tab this page drives, and the tabs other chats drive. A tab another
       chat owns is never a popup of this one: closing it, or navigating this
       page to its address, would take a page away from somebody else. */
    this.targetId = ''
    this.siblings = () => []
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
    if (message.method === 'Target.targetCreated') {
      const info = message.params?.targetInfo ?? {}
      /* A page target that is not this tab is a popup this click opened:
         remember it while it is still blank, so no polling is needed later. */
      if (String(info.type ?? '') === 'page' && String(info.targetId ?? '') !== String(this.targetId ?? '')) {
        const siblings = typeof this.siblings === 'function' ? this.siblings().map(String) : []
        if (!siblings.includes(String(info.targetId ?? ''))) {
          this.opened = { targetId: String(info.targetId ?? ''), url: String(info.url ?? ''), at: Date.now() }
          this.wakePopup()
          if (Date.now() < Number(this.followUntil ?? 0)) {
            void this.adoptOpened().catch(() => '')
          }
        }
      }
      return
    }
    if (message.method === 'Target.targetInfoChanged') {
      const info = message.params?.targetInfo ?? {}
      if (this.opened !== null && this.opened !== undefined && String(info.targetId ?? '') === this.opened.targetId) this.opened = { targetId: String(this.opened.targetId), url: String(info.url ?? this.opened.url) }
      const door = this.urlDoor
      if (door !== null && door !== undefined && String(info.url ?? '') !== '') {
        try {
          door({ id: String(info.targetId ?? ''), url: String(info.url) })
        } catch {
          /* the wait is already gone */
        }
      }
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
      this.troubleSeq += 1
      this.console.push({ type: 'error', text: String(detail.exception?.description ?? detail.text ?? '').slice(0, 300), seq: this.troubleSeq })
      if (this.console.length > 200) this.console.splice(0, 50)
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params ?? {}
      const text = (params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 300)
      this.troubleSeq += 1
      this.console.push({ type: String(params.type ?? 'log'), text, seq: this.troubleSeq })
      if (this.console.length > 200) this.console.splice(0, 50)
      return
    }
    if (message.method === 'Network.requestWillBeSent') {
      const params = message.params ?? {}
      const request = params.request ?? {}
      const id = String(params.requestId ?? '')
      if (id === '') return
      /* A new document replaces whatever document this browser was showing,
         including a PDF that was never drawn. The PDF viewer is the exception:
         it navigates the same tab to its own page, and the PDF is still what
         the tab shows. */
      if (String(params.type ?? '') === 'Document' && !String(request.url ?? '').startsWith('chrome-extension://')) this.pdf = null
      if (String(params.type ?? '') === 'Document' && !String(request.url ?? '').startsWith('chrome-extension://')) this.media = new Map()
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
      if (String(params.type ?? '') === 'Document' && String(params.response?.mimeType ?? '').includes('pdf')) {
        this.pdf = {
          url: String(params.response?.url ?? '').slice(0, 300), // ui-copy-ignore
          requestId: String(params.requestId ?? ''),
          bytes: Number(params.response?.encodedDataLength ?? 0),
        }
      }
      if (known !== undefined) known.status = Number(params.response?.status ?? 0)
      this.noteMedia(params)
      if (known === undefined) return
      known.status = Number(params.response?.status ?? 0)
      this.troubleSeq += 1
      known.seq = this.troubleSeq
      this.network.push(known)
      if (this.network.length > 120) this.network.splice(0, 40)
      return
    }
    if (message.method === 'Network.loadingFailed') {
      const params = message.params ?? {}
      if (params.canceled === true) return
      this.troubleSeq += 1
      this.failed.push({ error: String(params.errorText ?? ''), type: String(params.type ?? ''), seq: this.troubleSeq })
      if (this.failed.length > 100) this.failed.splice(0, 25)
    }
  }

  /**
   * Keep the requests that hold a movie or a song, so asking "what can be saved
   * here" is a memory read instead of a network sweep.
   * @param {{requestId?: string, type?: string, response?: object}} params - a Network.responseReceived payload.
   * @returns {void} nothing.
   */
  noteMedia(params) {
    const response = params?.response ?? {}
    const url = String(response.url ?? '')
    const mime = String(response.mimeType ?? '')
    if (!isMedia(url, mime, String(params?.type ?? ''))) return
    const id = String(params?.requestId ?? '')
    if (id === '') return
    const headers = response.headers ?? {}
    const length = Number(headers['content-length'] ?? headers['Content-Length'] ?? response.encodedDataLength ?? 0)
    const existing = this.media.get(id)
    this.media.set(id, {
      url,
      mime,
      kind: kindOf(url, mime),
      bytes: Number.isFinite(length) ? length : 0,
      status: Number(response.status ?? 0),
      seq: existing?.seq ?? this.troubleSeq,
    })
    if (this.media.size > 60) this.media.delete(this.media.keys().next().value)
  }

  /**
   * What on this page is worth saving, newest first.
   * @returns {Array<{url: string, mime: string, kind: string, bytes: number, status: number}>} the media.
   */
  mediaList() {
    const byUrl = new Map()
    for (const each of this.media.values()) byUrl.set(each.url, each)
    return [...byUrl.values()].sort((left, right) => right.seq - left.seq)
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
  async findPopup(foreign = []) {
    if (this.port <= 0) return null // ui-copy-ignore
    const mine = await this.cdp.send('Target.getTargetInfo').then((info) => String(info?.targetInfo?.targetId ?? '')).catch(() => '')
    const main = mine !== '' ? mine : this.targetId
    const theirs = new Set(foreign.map(String))
    const list = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(1200) }) // ui-copy-ignore
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])
    const pages = (Array.isArray(list) ? list : []).filter((item) => item.type === 'page' && String(item.id ?? '') !== main && !theirs.has(String(item.id ?? '')))
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
    const rows = (Array.isArray(list) ? list : [])
      .filter((item) => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
      .map((item) => ({ targetId: String(item.id), title: String(item.title ?? ''), url: String(item.url ?? ''), webSocketUrl: String(item.webSocketDebuggerUrl), current: String(item.id) === current }))
    return rows
  }

  /**
   * Follow a tab the page just opened: the mirror shows where the person would
   * have ended up, and the popup is closed so there is still one page to drive.
   * @returns {Promise<string>} what happened, for the tool result.
   */
  async adoptOpened() {
    const foreign = typeof this.siblings === 'function' ? this.siblings().map(String) : []
    const theirs = new Set(foreign)
    /* A tab someone opened for another reason is not what this click opened:
       only a target announced in the last couple of seconds counts. */
    const fresh = this.opened !== null && this.opened !== undefined && Date.now() - Number(this.opened.at ?? 0) < 2000
    let target = fresh ? { targetId: this.opened.targetId, url: this.opened.url } : null
    this.opened = null
    if (target !== null && String(target.url ?? '') === '') {
      const said = await this.waitUrl(target.targetId, 250)
      if (said !== '') target = { targetId: target.targetId, url: said }
    }
    if (target !== null && isForeign(target.targetId, this.targetId, foreign)) target = null
    /* A popup is announced by discovery the moment it exists; the fallback
       probe is only for the case where the click never made one, so it gets a
       single short look instead of the old half-second of polling. */
    if (target === null) {
      /* One look at the tab list answers the common case — a click that opened
         nothing. When it says nothing, the announcement is the cheaper door:
         a tab exists a moment before the browser lists it, so the wait ends on
         the event instead of running out the window. */
      target = await this.findPopup(foreign)
      if (target === null) {
        await this.waitPopup(Math.min(8, POPUP_GRACE_MS))
        if (this.opened !== null && this.opened !== undefined && Date.now() - Number(this.opened.at ?? 0) < 2000) {
          target = { targetId: String(this.opened.targetId), url: String(this.opened.url) }
        }
        this.opened = null
      }
    }
    if (target === null) {
      /* Nothing yet: it may still come. Following it then costs no latency. */
      this.armFollow()
      return ''
    }
    this.disarmFollow()
    const url = String(target.url ?? '')
    /* Close the tab the click opened, then use its own page for the visit. The
       CDP close is the one that works; the HTTP door is only for a browser that
       refused it, because waiting on it costs a round trip per popup click. */
    let closed = false
    try {
      await this.cdp.send('Target.closeTarget', { targetId: target.targetId })
      closed = true
    } catch {
      /* the target is already gone; the HTTP door below can still try */
    }
    if (!closed && this.port > 0) await fetch(`http://127.0.0.1:${this.port}/json/close/${target.targetId}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
    if (!/^https?:|^file:/.test(url)) return ''
    await this.cdp.send('Page.navigate', { url }).catch(() => {})
    return `opened ${url}`
  }

  /** Wake a pending popup wait: discovery has news. */
  wakePopup() {
    const door = this.popupDoor
    if (door === null || door === undefined) return
    this.popupDoor = null
    try {
      door()
    } catch {
      /* the wait is already gone */
    }
  }

  /**
   * Follow announced tabs for a while even though the click already answered.
   * A page that opens its window from a timer is still doing what the click
   * meant; the person would have ended up there too.
   *
   * @param {number} [ms] - how long to keep following.
   */
  armFollow(ms = FOLLOW_WINDOW_MS) {
    this.followUntil = Date.now() + Math.max(0, ms)
    if (this.followTimer !== null) clearTimeout(this.followTimer)
    this.followTimer = setTimeout(() => {
      this.followTimer = null
      this.followUntil = 0
    }, Math.max(0, ms))
    if (typeof this.followTimer?.unref === 'function') this.followTimer.unref()
  }

  /** A call is starting: whatever the last click might still open is not ours. */
  disarmFollow() {
    this.followUntil = 0
    if (this.followTimer !== null) clearTimeout(this.followTimer)
    this.followTimer = null
  }

  /**
   * Wait for a popup to say where it is going. Chrome announces a new tab with
   * an empty address and fills it in a moment later; a click that closes the tab
   * because the address is not there yet loses the page the click meant to open.
   *
   * @param {string} targetId - the tab to wait for.
   * @param {number} ms - the ceiling.
   * @returns {Promise<string>} the address, or '' when the window ends.
   */
  waitUrl(targetId, ms) {
    return new Promise((done) => {
      const wanted = String(targetId ?? '')
      const finish = (url) => {
        this.urlDoor = null
        done(String(url ?? ''))
      }
      const timer = setTimeout(() => finish(''), Math.max(0, ms))
      this.urlDoor = ({ id, url }) => {
        if (String(id ?? '') !== wanted) return
        clearTimeout(timer)
        finish(url)
      }
    })
  }

  /**
   * Wait for a popup announcement, no longer than `ms`: a page that opens
   * nothing costs the window, a page that does is followed at once.
   *
   * @param {number} ms - the ceiling.
   * @returns {Promise<void>} settles when a popup arrives or the window ends.
   */
  waitPopup(ms) {
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.popupDoor = null
        done()
      }, Math.max(0, ms))
      this.popupDoor = () => {
        clearTimeout(timer)
        done()
      }
    })
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
    this.targetId = String(
      await this.cdp.send('Target.getTargetInfo').then((info) => info?.targetInfo?.targetId ?? '').catch(() => ''),
    )
    /* A click that downloads should leave a file, not nothing: point downloads
       at the profile so the driver can report where they went. */
    const folder = downloadsDir(profileDir(this.profile))
    mkdirSync(folder, { recursive: true })
    this.downloadsFolder = folder
    this.cdp.on((message) => {
      /* A CDP event is an event: one bad frame must not take the application
         down with it, so the whole handler is a fault boundary. */
      try {
        this.watch(message)
        if (message.method !== 'Page.screencastFrame') return
        const { data, sessionId, metadata } = message.params ?? {}
        void this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
        if (typeof data !== 'string' || data === '') return
        this.latest = data
        this.lastFrameAt = Date.now()
        this.seq += 1
        this.bytes += data.length
        /* Every so often, let the weight of the last frame decide the quality
           of the next one. Restarting the cast is cheap and rare; a heavy
           page pays for itself in every frame of every later action. */
        if ((this.seq % 24 === 0 || this.seq === 1) && Date.now() - this.adaptAt > 3000) {
          this.adaptAt = Date.now()
          const wanted = nextQuality(this.castQuality, data.length)
          if (wanted !== this.castQuality) void this.recast(wanted)
        }
        if (metadata?.timestamp !== undefined && metadata.timestamp * 1000 < this.touched - 60_000) return
        /* A page that is not moving sends the same bytes again and again; the
           pane already shows that picture, so it is acked and dropped. */
        if (this.frames.size > 0 && this.repeats(data) === true) return
        if (this.tooSoon()) return
        this.inflight += 1
        const frame = {
          seq: this.seq, // ui-copy-ignore
          w: this.view.width, // ui-copy-ignore
          h: this.view.height, // ui-copy-ignore
          jpeg: data, // ui-copy-ignore
          url: this.url, // ui-copy-ignore
          title: this.title, // ui-copy-ignore
          pointer: this.pointer, // ui-copy-ignore
          /* Whether the person is driving right now: the pane hides the agent's
             arrow while they are, so two cursors never claim the same hand. */
          hold: this.holdOf(), // ui-copy-ignore
        }
        for (const sink of this.frames) {
          try {
            sink(frame)
          } catch {
            /* a closed viewer is dropped by its own stream handler */
          }
        }
        this.inflight -= 1
      } catch (error) {
        this.fault = String(error?.message ?? error) // ui-copy-ignore
      }
    })
    this.cdp.on((message) => {
      if (message.method === 'Page.frameNavigated' && message.params?.frame?.parentId === undefined) {
        const next = String(message.params.frame.url ?? '')
        if ((next === '' || next === 'about:blank') && this.url !== '' && this.url !== 'about:blank') this.blanked = true
        this.url = next
        void this.readTitle()
      }
      if (message.method === 'Page.loadEventFired') {
        this.loadFired = Date.now()
        void this.readTitle()
      }
      /* A click that starts a navigation and a click that only changes the page
         are different: the first needs waiting on, the second does not. */
      if (message.method === 'Page.frameStartedLoading') this.navStarted = Date.now()
      if (message.method === 'Page.frameStoppedLoading') this.navStopped = Date.now()
    })
    /* None of these settings depends on another: asking for all of them at
       once is one round trip instead of four, and a cold start is where it
       shows. */
    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('Network.enable').catch(() => {}),
      this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder }).catch(() => {}),
      /* Popups and out-of-process frames are separate targets. Attaching without
         waiting keeps them usable, and lets the mirror follow a new tab. */
      this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {}),
      /* Discovery is what makes a popup visible the instant it is created,
         instead of after the click has already returned. */
      this.cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {}),
    ])
    /* An instance left behind by a stopped app can still be sitting on a
       dialog; a paused renderer answers nothing, so clear it first. */
    await Promise.race([
      this.cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ])
    /* The metrics and the version string are independent too: the UA override
       only needs the version, not a turn of its own. */
    const [, version] = await Promise.all([
      this.cdp.send('Runtime.enable').then(() =>
        this.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: this.view.width, // ui-copy-ignore
          height: this.view.height, // ui-copy-ignore
          deviceScaleFactor: 1,
          mobile: false, // ui-copy-ignore
        }),
      ),
      this.cdp.send('Browser.getVersion').catch(() => ({ product: '' })),
    ])
    /* A headless build announces itself in the UA, and some sites refuse that
       string outright. The page is a normal Chrome here, so it says so. */
    const product = String(version?.product ?? '')
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

  /**
   * Change the quality the mirror is cast at, without leaving the pane black.
   * @param {number} quality - the new JPEG quality.
   * @returns {Promise<void>} resolves once the new cast is asked for.
   */
  async recast(quality) {
    if (this.casting !== true || this.flashBridge !== null) return
    try {
      this.castQuality = quality
      await this.cdp.send('Page.stopScreencast').catch(() => {})
      this.casting = false
      await this.cast()
    } catch {
      /* a page that died mid-recast will be picked up by the next view */
    }
  }

  /** @returns {Promise<void>} resolves once the page is casting. */
  async cast() {
    if (this.flashBridge !== null) {
      if (this.casting) return
      this.casting = true
      void this.pollBridge()
      return
    }
    if (this.casting) {
      /* A page nobody repaints still owes the pane a picture, so silence for a
         few seconds means the cast died rather than being idle. */
      if (Date.now() - this.lastFrameAt < 3000) return
      this.casting = false
    }
    this.casting = true
    /* Full-resolution mirror at a quality that keeps small text readable;
       `optimizeForSpeed` keeps the encoder from adding to the round trip. */
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', // ui-copy-ignore
      quality: this.castQuality, // ui-copy-ignore
      maxWidth: this.view.width, // ui-copy-ignore
      maxHeight: this.view.height,
      optimizeForSpeed: true,
      everyNthFrame: 1,
    }).catch(() => {
      this.casting = false
    })
    void this.still()
  }

  /**
   * The column changed size: lay the page out at that size so the picture fills
   * the frame instead of sitting letterboxed inside it.
   * @param {number} width - CSS pixels of the frame. @param {number} height - CSS pixels of the frame.
   */
  async setViewport(width, height) {
    const w = Math.round(Number(width))
    const h = Math.round(Number(height))
    /* A narrow column with a long page is still a browser: refusing its size
       leaves the picture letterboxed in the pane, which is what makes a mirror
       look like it does not fill the column. */
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200) return this.view
    if (w > 2560 || h > 2560) return this.view
    if (w === this.view.width && h === this.view.height) return this.view
    this.view = { width: w, height: h }
    this.touched = Date.now()
    if (this.flashBridge !== null) {
      /* The Flash window is the picture: resize it so the game fills the pane
         instead of sitting letterboxed in a landscape window. */
      await fetch(`http://127.0.0.1:${this.flashBridge}/resize?w=${w}&h=${h}`).catch(() => {})
      return this.view
    }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false, // ui-copy-ignore
    }).catch(() => {})
    /* A Flash window is captured from a hidden app: there is no screencast to
       restart, and its own resize path owns the picture. */
    if (this.casting === true) {
      await this.cdp.send('Page.stopScreencast').catch(() => {})
      this.casting = false
      await this.cast()
    }
    return this.view
  }

  /** @returns {Promise<string>} one JPEG of the page, base64, or empty. */
  async picture() {
    if (this.flashBridge !== null) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.flashBridge}/frame.jpg`) // ui-copy-ignore
        if (!response.ok) return ''
        return Buffer.from(await response.arrayBuffer()).toString('base64')
      } catch {
        return ''
      }
    }
    try {
      const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, fromSurface: true })
      return String(shot?.data ?? '')
    } catch {
      return ''
    }
  }

  /**
   * Whether the pane was sent a picture a moment ago. Frames still update
   * `latest` and the counters; only the downlink is paced.
   * @returns {boolean} true when this frame should not be forwarded.
   */
  tooSoon() {
    const now = Date.now()
    /* Someone moving the mouse or holding the page is watching closely: their
       frame goes out at full rate. A page animating on its own is paced. */
    const busy = now - this.lastPointerAt < 1500
    const gap = busy ? 0 : FRAME_GAP_MS
    if (this.frames.size > 0 && now - this.sentAt < gap) return true
    this.sentAt = now
    return false
  }

  /** Feeds one picture to every viewer of this browser. @param {string} data - base64 JPEG. */
  publish(data) {
    if (data === '' || this.frames.size === 0) return
    this.latest = data
    if (this.repeats(data) === true) return
    if (this.tooSoon()) return
    this.lastFrameAt = Date.now()
    this.seq += 1
    const frame = {
      seq: this.seq, // ui-copy-ignore
      w: this.view.width, // ui-copy-ignore
      h: this.view.height, // ui-copy-ignore
      jpeg: data, // ui-copy-ignore
      url: this.url, // ui-copy-ignore
      title: this.title, // ui-copy-ignore
      hold: this.holdOf(), // ui-copy-ignore
      pointer: this.pointer, // ui-copy-ignore
    }
    for (const sink of this.frames) {
      try {
        sink(frame)
      } catch {
        /* a closed viewer is dropped by its own stream handler */
      }
    }
  }

  /**
   * Whether this picture repeats the one the pane is already showing.
   * @param {string} jpeg - base64 JPEG of the new frame.
   * @returns {boolean} true when sending it would cost bytes.
   */
  repeats(jpeg, gap = 1000) {
    const prev = this.lastShot
    const same = prev !== null && prev === jpeg
    const quietFor = Date.now() - this.lastShotAt
    this.lastShot = jpeg
    if (same === true && quietFor < gap) {
      this.quiet += 1
      return true
    }
    this.lastShotAt = Date.now()
    return false
  }

  /** Sends one full-frame picture now: a mirror that waits for motion shows an empty pane on a page that is not moving. */
  async still() {
    this.publish(await this.picture())
  }

  /** Keeps a Flash page's mirror moving at a browser-like rate without a screencast. */
  async pollBridge() {
    while (this.casting) {
      const started = Date.now()
      if (Date.now() - this.lastFrameAt > 1500) this.publish(await this.picture())
      else {
        const frame = await this.picture()
        if (frame !== this.latest) this.publish(frame)
      }
      const spent = Date.now() - started
      /* The Flash bridge answers from a ready JPEG, so its ceiling is the
         bridge's own pump rather than the browser's repaint interval. Poll
         fast while the page is moving, slowly when it is still: a still page
         costs one fetch per beat for nothing, a moving one is the mirror. */
      const moving = Date.now() - this.lastFrameAt < 400
      const interval = moving ? MIRROR.busy : MIRROR.interval
      await wait(Math.max(0, interval - spent))
    }
  }

  async stopCast() {
    if (!this.casting) return
    this.casting = false
    if (this.flashBridge === null) await this.cdp.send('Page.stopScreencast').catch(() => {})
  }

  /**
   * @param {string} url - address to open.
   * @returns {Promise<{url: string, title: string}>} where it landed.
   */
  async navigate(url) {
    this.touched = Date.now()
    this.navAt = Date.now()
    this.lastUrl = String(url)
    await this.cdp.send('Page.navigate', { url })
    /* A blank page is where the wait ends, not a place still to arrive: asking
       for about:blank and then waiting for a non-blank address spent the whole
       20 s budget, which is how a brand-new chat's first tab took forever. */
    if (String(url) === '' || String(url) === 'about:blank') {
      await wait(80)
      await this.readTitle()
      return { url: this.url, title: this.title }
    }
    for (let i = 0; i < 200; i += 1) {
      await wait(100)
      await this.readTitle()
      if (this.url !== '' && this.url !== 'about:blank') break
    }
    /* A brand-new browser sometimes answers the very first navigation with its
       own error page: the network stack is still coming up. One reload of that
       address is the difference between the chat seeing the site and the chat
       seeing a browser error in the mirror. */
    /* Only a browser that was still starting up answers instantly with its own
       error page; one that took seconds to fail is the network's answer, and
       asking it again costs another ten seconds of the same. */
    if (this.url.startsWith('chrome-error://') && Date.now() - this.navAt < 2500) {
      await wait(300)
      await this.cdp.send('Page.reload', {}).catch(() => {})
      for (let i = 0; i < 40; i += 1) {
        await wait(100)
        await this.readTitle()
        if (this.url !== '' && !this.url.startsWith('chrome-error://') && this.url !== 'about:blank') break
      }
    }
    const bad = this.url.startsWith('chrome-error://') ? 'the page did not load' : ''
    return bad === '' ? { url: this.url, title: this.title } : { url: this.url, title: this.title, bad }
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

  /**
   * What went wrong since the last time this was asked: failed requests, error
   * statuses and JS exceptions, in one line. Silently empty when nothing did.
   * @returns {string} a line to append to a read, or ''.
   */
  troubleOf() {
    const after = Number(this.troubleSeen ?? 0)
    const errors = (this.console ?? []).filter((row) => row.type === 'error' && Number(row.seq ?? 0) > after)
    const bad = (this.network ?? []).filter((row) => Number(row.seq ?? 0) > after && Number(row.status ?? 0) >= 400)
    const lost = (this.failed ?? []).filter((row) => Number(row.seq ?? 0) > after && !String(row.error ?? '').includes('ERR_ABORTED'))
    const newest = [errors, bad, lost].reduce((top, rows) => rows.reduce((best, row) => Math.max(best, Number(row.seq ?? 0)), top), 0)
    if (newest === 0) return ''
    this.troubleSeen = newest
    /* A raw address is mostly origin noise; the path is what names the request. */
    const where = (url) => {
      try {
        const parsed = new URL(String(url))
        return `${parsed.pathname}${parsed.search}`.slice(0, 70)
      } catch {
        return String(url ?? '').slice(0, 70)
      }
    }
    const says = []
    if (bad.length > 0) says.push(`${bad.length} request${bad.length === 1 ? '' : 's'} failed (${String(bad[bad.length - 1].method ?? 'GET')} ${where(bad[bad.length - 1].url)} → ${bad[bad.length - 1].status})`)
    if (lost.length > 0) says.push(`${lost.length} request${lost.length === 1 ? '' : 's'} did not load (${String(lost[lost.length - 1].error ?? '').slice(0, 40)})`)
    if (errors.length > 0) says.push(`${errors.length} JS error${errors.length === 1 ? '' : 's'} (${String(errors[errors.length - 1].text ?? '').split('\n')[0].slice(0, 90)})`)
    return `page trouble: ${says.join(' · ')} — browser_network for the full list`
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

  /**
   * Say the hand changed owners without waiting for the next picture: on a
   * still page the agent's arrow used to sit there until the idle repaint, and
   * a person who took the mouse saw it on top of their own cursor.
   */
  announceHold() {
    const message = { type: 'pointer', w: this.view.width, h: this.view.height, pointer: this.pointer, hold: this.holdOf() } // ui-copy-ignore
    for (const sink of this.pointerSinks) {
      try {
        sink(message)
      } catch {
        /* a closed viewer is dropped by its own stream handler */
      }
    }
  }

  /** @param {{x: number, y: number}} point - where the pointer goes. */
  movePointer(point) {
    this.pointer = { x: Math.round(point.x), y: Math.round(point.y) }
    this.lastPointerAt = Date.now()
    this.touched = Date.now()
    const message = { type: 'pointer', w: this.view.width, h: this.view.height, pointer: this.pointer, hold: this.holdOf() } // ui-copy-ignore
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
    if (this.flashBridge !== null && (await this.flashInput('mouseMove', point)) === true) return this.cursorAt(point)
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
  /**
   * Hands one mouse event to the Flash window directly, skipping the debugging
   * protocol on the way in.
   * @param {string} kind - mouseDown, mouseUp or mouseMove.
   * @param {{x: number, y: number, button?: string, clickCount?: number}} point - CSS pixels.
   * @returns {Promise<boolean>} true when the window took it.
   */
  async flashInput(kind, point) {
    const started = Date.now()
    try {
      const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: kind, x: Math.round(point.x), y: Math.round(point.y), button: point.button ?? 'left', clickCount: point.clickCount ?? (kind === 'mouseMove' ? 0 : 1) }),
        signal: AbortSignal.timeout(1200),
      })
      this.inputMs = Date.now() - started
      return reply.ok
    } catch {
      return false
    }
  }

  async mouse(type, point) {
    this.movePointer(point)
    if (this.flashBridge !== null && (await this.flashInput(type === 'mousePressed' ? 'mouseDown' : type === 'mouseReleased' ? 'mouseUp' : 'mouseMove', point)) === true) return
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
    if (this.flashBridge !== null) {
      try {
        const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'mouseWheel', x: Math.round(args.x), y: Math.round(args.y), deltaX: Math.round(args.dx ?? 0), deltaY: Math.round(args.dy ?? 0) }),
          signal: AbortSignal.timeout(1200),
        })
        if (reply.ok === true) return
      } catch {
        /* the debugging protocol below is the fallback */
      }
    }
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
   * One keystroke into the Flash window: a key name for control keys, a
   * character for text, both carrying the modifiers a person holds.
   * @param {string} type - keyDown or keyUp.
   * @param {{key: string, text?: string, modifiers?: number}} key - one key.
   * @returns {Promise<boolean>} true when the window took it.
   */
  async flashKey(type, key) {
    const bits = Number(key.modifiers ?? 0)
    const modifiers = []
    if ((bits & 1) !== 0) modifiers.push('alt')
    if ((bits & 2) !== 0) modifiers.push('control')
    if ((bits & 4) !== 0) modifiers.push('meta')
    if ((bits & 8) !== 0) modifiers.push('shift')
    const char = String(key.text ?? '')
    const named = String(key.key ?? '')
    const code = char !== '' ? char : named
    const events = [{ type, keyCode: code, modifiers }]
    if (type === 'keyDown' && char !== '') events.push({ type: 'char', keyCode: char, modifiers })
    try {
      for (const event of events) {
        const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/input`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(1200),
        })
        if (reply.ok !== true) return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * @param {string} type - `keyDown` or `keyUp`.
   * @param {{key: string, code?: string, keyCode?: number, text?: string, modifiers?: number}} key - one key.
   * @returns {Promise<void>} resolves when Chrome took it.
   */
  async key(type, key) {
    this.touched = Date.now()
    if (this.flashBridge !== null && (await this.flashKey(type, key)) === true) return
    const virtual = key.keyCode ?? key.windowsVirtualKeyCode ?? 0
    await this.input('Input.dispatchKeyEvent', {
      type: key.autoRepeat === true && type === 'keyDown' ? 'keyDown' : type,
      ...(key.autoRepeat === true && type === 'keyDown' ? { autoRepeat: true } : {}),
      key: key.key, // ui-copy-ignore
      code: key.code ?? '', // ui-copy-ignore
      windowsVirtualKeyCode: virtual,
      nativeVirtualKeyCode: key.nativeVirtualKeyCode ?? virtual,
      text: key.text, // ui-copy-ignore
      unmodifiedText: key.text,
      modifiers: key.modifiers ?? 0,
      ...(Array.isArray(key.commands) && key.commands.length > 0 ? { commands: key.commands } : {}),
    })
  }

  /**
   * Type the way a person does: one character at a time, uneven gaps, a longer
   * pause where a person would think, and no clipboard paste at all. Paste is
   * the single event that tells a site a machine filled the box; per-character
   * key events do not. Longer messages are typed in small bursts so a whole
   * page of text does not take a minute.
   * @param {string} text - any unicode, including Chinese.
   * @param {{burst?: number, min?: number, max?: number}} [options] - pacing.
   * @returns {Promise<void>} resolves once the last character was accepted.
   */
  async humanType(text, options = {}) {
    this.touched = Date.now()
    const chars = Array.from(String(text))
    /* A long message is typed faster per burst: the opening still looks like
       fingers, but nobody wants to wait fifteen seconds for a paragraph. */
    const long = chars.length > 160
    const burst = Math.max(1, Number(options.burst ?? (long ? 8 : 3)))
    /* A keystroke's *shape* is what a page can check (keyDown with its own
       text, a real focus, the right input events); the gaps between keys only
       cost the caller time. A short word still gets human-sized jitter. */
    const min = Number(options.min ?? (long ? 6 : 10))
    const max = Math.max(min + 1, Number(options.max ?? (long ? 14 : 28)))
    const gap = () => min + Math.random() * (max - min)
    let at = 0
    while (at < chars.length) {
      const size = at < 12 ? 1 : burst
      const chunk = chars.slice(at, at + size).join('')
      /* One key event per character is what a keyboard produces. A multi-letter
         key event would only deliver its first letter, so a run of Latin text
         is pressed key by key; a run of Chinese arrives as an input-method
         commit, which is one event for a whole phrase. */
      if (size > 1 && /[\u3040-\u9fff\uac00-\ud7af]/.test(chunk)) {
        await this.input('Input.insertText', { text: chunk })
      } else {
        for (const one of Array.from(chunk)) {
          if (this.flashBridge !== null && (await this.flashKey('keyDown', { key: one, text: one })) === true) {
            await this.flashKey('keyUp', { key: one })
            continue
          }
          await this.input('Input.dispatchKeyEvent', {
            type: 'keyDown', // ui-copy-ignore
            key: one, // ui-copy-ignore
            text: one, // ui-copy-ignore
            unmodifiedText: one, // ui-copy-ignore
            windowsVirtualKeyCode: 0,
            nativeVirtualKeyCode: 0,
          }).catch(() => {})
        }
      }
      at += size
      const last = chars[at - 1] ?? ''
      /* Stop longer after a full stop or a comma, the way a person does. */
      const pause = /[。！？，、；：\n.,!?;:]/.test(last) ? gap() * 2 + 30 : gap()
      await wait(at < chars.length ? pause : 0)
    }
  }

  /**
   * Types a long text in one event, the way a paste does.
   * @param {string} text - any unicode, including Chinese.
   * @returns {Promise<boolean>} whether the focused box really took the text.
   */
  async quickType(text) {
    this.touched = Date.now()
    /** @returns {Promise<string>} what the focused box holds now. */
    const holds = async () => {
      const said = await this.cdp.send('Runtime.evaluate', {
        expression: '(() => { const el = document.activeElement; return el === null ? "" : String(el.value ?? el.innerText ?? "") })()',
        returnByValue: true,
      }).catch(() => null)
      return String(said?.result?.value ?? '')
    }
    const before = await holds()
    await this.input('Input.insertText', { text }).catch(() => {})
    const after = await holds()
    /* The box is the judge: an editor that only listens to key events ignores
       this, and the caller types the slow way instead. */
    return after !== before && after.includes(String(text).trim().slice(0, 12))
  }

  /**
   * Save the PDF this tab is showing, so its text is reachable without a render.
   * @returns {Promise<{path: string, bytes: number, url: string}>} the file, or an empty path.
   */
  async documentFile() {
    const found = this.pdf
    if (found === null || found === undefined || String(found.url ?? '') === '') return { path: '', bytes: 0, url: '' }
    if (typeof found.path === 'string' && found.path !== '') {
      return { path: found.path, bytes: Number(found.bytes ?? 0), url: String(found.url ?? '') }
    }
    /* The viewer's own page is what the tab navigated to, so the body Chrome
       hands back can be that page rather than the document. The file itself
       has the final say: a PDF starts with %PDF. */
    let bytes = null
    try {
      const answer = await this.cdp.send('Network.getResponseBody', { requestId: String(found.requestId ?? '') })
      const raw = Buffer.from(String(answer?.body ?? ''), answer?.base64Encoded === true ? 'base64' : 'utf8')
      if (raw.length > 4 && raw.subarray(0, 4).toString() === '%PDF') bytes = raw
    } catch (error) {
      bytes = null
    }
    if (bytes === null) {
      try {
        const { cookies } = await this.cdp.send('Network.getCookies', { urls: [String(found.url)] })
        const cookie = (cookies ?? []).map((one) => `${String(one.name)}=${String(one.value)}`).join('; ')
        const answer = await fetch(String(found.url), {
          headers: cookie === '' ? {} : { cookie },
          redirect: 'follow',
        })
        if (answer.ok === true) {
          const said = await answer.arrayBuffer()
          if (said.byteLength > 0 && said.byteLength <= 64 * 1024 * 1024) bytes = Buffer.from(said)
        }
      } catch (error) {
        bytes = null
      }
    }
    if (bytes === null) return { path: '', bytes: 0, url: String(found.url ?? '') }
    const folder = this.downloadsFolder ?? downloadsDir(profileDir(this.profile))
    const name = (() => {
      try {
        const last = new URL(String(found.url ?? '')).pathname.split('/').filter((part) => part !== '').pop() ?? ''
        const clean = decodeURIComponent(last).replace(/[^\w.-]+/g, '-').slice(-60)
        return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean === '' ? 'document' : clean}.pdf`
      } catch (error) {
        return 'document.pdf'
      }
    })()
    try {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, name), bytes)
      found.path = join(folder, name)
      found.bytes = bytes.length
      return { path: found.path, bytes: found.bytes, url: String(found.url ?? '') }
    } catch (error) {
      return { path: '', bytes: 0, url: String(found.url ?? '') }
    }
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
    this.owns = false
    this.stopping = false
    this.cdp = null
    this.page = null
    /* One tab per chat: a second chat opening an address gets a tab of its
       own, so neither can navigate the other's page away. */
    this.pages = new Map()
    /* Every tab a chat has driven, so its column can offer its own windows
       back after it switches away: a tab the chat left is still its own, and a
       tab nobody claimed belongs to no column at all. */
    this.claims = new Map()
    /* Tabs left behind by an earlier plugin load are closed once, on the first
       call that finds this browser: a profile used for weeks otherwise keeps a
       renderer per chat that ever opened it. */
    this.pruned = false
    /* A tab being opened for a chat: a second call for the same chat waits for
       it instead of opening a twin. */
    this.opening = new Map()
    /* Chats whose tab was reclaimed: the column is told so it can go away. */
    this.expired = new Map()
    /* A measurement or a test may want a profile of its own; the person's
       browser keeps the default one. */
    this.profile = String(options.profile ?? 'default')
    /* A movie page needs a runtime Chrome no longer has; the switch is the
       person's, and it swaps the browser rather than the protocol. */
    this.flash = options.flash === undefined ? process.env.DSH_INNER_BROWSER_FLASH === '1' || readFlashChoice() : options.flash === true
    /* The Flash app serves its own frames; the screencast cannot see a plugin. */
    this.flashBridge = null
    this.headless = true
    this.starting = null
    this.idle = null
    this.lastError = ''
    this.lastUrl = ''
    /* What the person did in the mirror, and when. It starts empty rather than
       missing: an adopted browser has no record of a hand on it yet, and asking
       about one used to throw instead of answering. */
    this.person = { at: 0, kind: '', x: 0, y: 0, seen: true } // ui-copy-ignore
    /* How long after the person's last real input the agent holds off. Short
       enough that a stray click does not stall a run, long enough that the agent
       does not type into a field the person is in the middle of filling. */
    this.holdMs = 6000
  }

  /**
   * The person touched the mirror by hand; every action waits for them now.
   * Called from the input route, which only sees the person's own input.
   */
  humanUse({ kind = '', x = 0, y = 0 } = {}) {
    this.person = { at: Date.now(), kind, x, y, seen: false }
  }

  /** @returns {number} ms the agent should still hold off; 0 when free to act. */
  holding() {
    if (this.person === undefined || this.person.at === 0) return 0
    const left = this.holdMs - (Date.now() - this.person.at)
    return left > 0 ? left : 0
  }

  /** Take the page back now, without waiting out the hold. */
  release() {
    if (this.person === undefined) this.person = { at: 0, kind: '', x: 0, y: 0, seen: true } // ui-copy-ignore
    this.person.at = 0
    this.person.seen = true
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
   * The tab a chat drives. A named chat gets a tab of its own, made once and
   * kept; an unnamed caller (a test, a screenshot script) drives the first tab.
   * @param {string} session - chat id, empty for the default tab.
   * @returns {SidecarPage | null} the tab, if the browser is up.
   */
  /**
   * Remember that a tab belongs to a chat: switching away from it keeps it in
   * that chat's window list, and no other chat can see it.
   * @param {string} session - chat that drove the tab. // ui-copy-ignore
   * @param {string} targetId - the browser target.
   */
  claim(session, targetId) {
    const who = String(session ?? '')
    const target = String(targetId ?? '')
    if (who === '' || target === '') return
    let set = this.claims.get(who)
    if (set === undefined) {
      set = new Set()
      this.claims.set(who, set)
    }
    /* A chat cannot hold an unbounded list: the oldest tab it left falls off. */
    if (set.size >= 12 && set.has(target) !== true) {
      const first = set.values().next()
      if (first.done !== true) set.delete(first.value)
    }
    set.add(target)
  }

  /**
   * Forget a tab a chat no longer has.
   * @param {string} session - chat that owned it. // ui-copy-ignore
   * @param {string} targetId - the browser target.
   */
  unclaim(session, targetId) {
    const set = this.claims.get(String(session ?? ''))
    if (set === undefined) return
    set.delete(String(targetId ?? ''))
    if (set.size === 0) this.claims.delete(String(session ?? ''))
  }

  pageFor(session) {
    const id = String(session ?? '')
    if (id === '') return this.page
    const mine = this.pages.get(id)
    if (mine !== undefined && mine.cdp?.closed !== true) return mine
    if (mine !== undefined) this.pages.delete(id)
    return null
  }

  /**
   * Keep a chat's tab address on disk, so a reload can bring the page back.
   * @param {string} session - chat id.
   * @param {string} url - address that chat's tab is showing.
   */
  rememberTab(session, url) {
    const id = String(session ?? '')
    const address = String(url ?? '')
    /* Only chats, and only addresses: a stray key from a probe or an older run
       must not sit in this file pretending to be a chat that can be restored. */
    if (!/^session-/.test(id) || address === '' || address === 'about:blank') return
    /* The note is read once and kept in memory: a liveness check per keystroke
       was parsing this file on every key. */
    if (tabsCache === null) {
      try {
        tabsCache = JSON.parse(readFileSync(tabsFile, 'utf8')) ?? {}
      } catch {
        tabsCache = {}
      }
    }
    const saved = tabsCache
    if (saved[id] === address) return
    saved[id] = address
    try {
      mkdirSync(tabsDir, { recursive: true })
      writeFileSync(tabsFile, JSON.stringify(saved))
    } catch {
      /* a browser that cannot write its note still works */
    }
  }

  /**
   * @param {string} session - a chat id.
   * @returns {string} the address that chat last had, or '' when it never had one.
   */
  rememberedTab(session) {
    const id = String(session ?? '')
    if (!/^session-/.test(id)) return ''
    try {
      const saved = JSON.parse(readFileSync(tabsFile, 'utf8'))
      return String(saved?.[id] ?? '')
    } catch {
      return ''
    }
  }

  /**
   * Give a chat its own tab, on the same browser: logins are shared, addresses
   * are not.
   * @param {string} session - chat id.
   * @param {string} [url] - address to open in it.
   * @returns {Promise<SidecarPage>} its tab.
   */
  async tabFor(session, url) {
    const id = String(session ?? '')
    this.expired?.delete(id)
    const had = this.pageFor(id)
    if (had !== null) {
      if (url !== undefined && url !== '') await had.navigate(url)
      return had
    }
    /* Two calls that start together are one chat, and a chat has one tab: the
       second waits for the first tab instead of opening a twin nobody holds. */
    const underway = this.opening?.get(id)
    if (underway !== undefined) {
      const page = await underway
      const want = String(url ?? '')
      if (want !== '' && String(page.url ?? '') !== want) await page.navigate(want)
      return page
    }
    if (this.pages.size >= MAX_TABS) await this.trimTabs()
    const work = this.openTab(id, url).finally(() => {
      this.opening?.delete(id)
    })
    this.opening?.set(id, work)
    return work
  }

  /**
   * Close tabs nobody owns. A browser reused across plugin loads keeps every tab
   * an earlier load opened; each is a whole renderer, and a single chat's work is
   * one tab. Remembered addresses are spared, so a chat that had a page still
   * finds it.
   * @returns {Promise<void>} done.
   */
  async pruneStrays() {
    if (this.pruned === true) return
    const port = Number(this.page?.port ?? 0)
    if (port === 0) return
    let list
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }) // ui-copy-ignore
      list = await response.json()
    } catch {
      return
    }
    if (!Array.isArray(list)) return
    const owned = new Set()
    for (const page of [...this.pages.values(), this.page]) {
      const id = String(page?.targetId ?? '')
      if (id !== '') owned.add(id)
    }
    let remembered = []
    try {
      remembered = Object.values(JSON.parse(readFileSync(tabsFile, 'utf8')) ?? {}).map(String)
    } catch {
      remembered = []
    }
    let closed = 0
    let kept = 0
    for (const target of list) {
      if (target?.type !== 'page') continue
      const id = String(target.targetId ?? target.id ?? '')
      if (id === '') continue
      if (owned.has(id)) continue
      /* Six chats' worth of pages can come back without a reload; anything past
         that is a tab from an older load, and its address is still on disk. */
      if (remembered.includes(String(target.url ?? '')) && kept < MAX_TABS) {
        kept += 1
        continue
      }
      await fetch(`http://127.0.0.1:${String(port)}/json/close/${id}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
      closed += 1
    }
    this.pruned = true
    if (closed > 0) this.note(`closed ${String(closed)} tabs no chat was using`)
  }

  /**
   * Close a few tabs nobody is watching so one browser does not grow a renderer
   * per chat that ever used it. Every chat's address is already on disk, so a
   * reaped tab costs nothing but the time to open it again.
   * @returns {Promise<void>} done.
   */
  async trimTabs() {
    const over = this.pages.size - (MAX_TABS - 1)
    if (over <= 0) return
    const idle = []
    for (const [id, page] of this.pages) {
      const target = String(page.targetId ?? '')
      if ((page.frames?.size ?? 0) !== 0 || target === '' || page.port === 0) continue
      idle.push({ id, page, target, port: page.port, at: Number(page.touched ?? 0) })
    }
    idle.sort((a, b) => a.at - b.at)
    for (const row of idle.slice(0, over)) {
      this.pages.delete(row.id)
      await row.page.stopCast().catch(() => {})
      await fetch(`http://127.0.0.1:${String(row.port)}/json/close/${row.target}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
    }
  }

  /**
   * Close tabs nobody is watching that have sat untouched past the idle window.
   * The cap alone keeps at most six around; this keeps the working set near the
   * chats actually in use, which is what the memory number follows.
   * @returns {Promise<void>} done.
   */
  async reapIdleTabs() {
    const now = Date.now()
    if (now - Number(this.reapedAt ?? 0) < 60_000) return
    this.reapedAt = now
    for (const [id, page] of this.pages) {
      const target = String(page.targetId ?? '')
      if ((page.frames?.size ?? 0) !== 0 || target === '' || page.port === 0) continue
      if (page === this.page) continue
      if (now - Number(page.touched ?? 0) < TAB_IDLE_MS) continue
      this.pages.delete(id)
      /* The column is told the tab is gone, so a chat coming back to the front
         does not re-expand a pane for a page that already went away. */
      ;(this.expired ??= new Map()).set(String(id), Date.now())
      await page.stopCast().catch(() => {})
      await fetch(`http://127.0.0.1:${String(page.port)}/json/close/${target}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
      this.note(`closed an idle tab — its address is kept for the chat`)
    }
  }

  /**
   * A page already at an address, so a second open reuses it. A page another
   * chat is driving is that chat's, and is not offered.
   * @param {string} url - address wanted.
   * @param {string} except - chat doing the asking.
   * @returns {SidecarPage|null} the page, or null.
   */
  tabShowing(url, except) {
    const wanted = String(url ?? '')
    if (wanted === '' || wanted === 'about:blank') return null
    const held = new Set()
    for (const [who, set] of this.claims) {
      if (String(who) === String(except)) continue
      for (const target of set) held.add(String(target))
    }
    for (const page of [this.page, ...this.pages.values()]) {
      if (page === null || page === undefined || page.cdp?.closed === true) continue
      const target = String(page.targetId ?? '')
      if (target === '' || held.has(target)) continue
      if (samePlace(page.url, wanted)) return page
    }
    return null
  }

  /**
   * @param {string} id - chat id.
   * @param {string} [url] - address to open in it.
   * @returns {Promise<SidecarPage>} a new tab for that chat.
   */
  async openTab(id, url) {
    this.expired?.delete(String(id))
    const had = this.pageFor(id)
    if (had !== null) {
      if (url !== undefined && url !== '') await had.navigate(url)
      return had
    }
    /* One address, one page: a browser that is already showing where this chat
       wants to go hands that page over instead of a second copy of the same
       address, which nobody would be able to tell apart in the tab list. */
    const twin = this.tabShowing(url, id)
    if (twin !== null) {
      this.pages.set(String(id), twin)
      this.claim(String(id), twin.targetId)
      this.touch()
      this.rememberTab(String(id), String(twin.url ?? url))
      return twin
    }
    if (this.page === null) await this.ensure()
    const port = this.page?.port ?? 0 // ui-copy-ignore
    if (port === 0) throw new Error('sidecar: no browser to open a tab in') // ui-copy-ignore
    /* A chat that was given a tab without an address keeps looking at what the
       browser was already showing, rather than at a blank page nobody asked for. */
    const remembered = this.rememberedTab(id)
    const address = url === undefined || url === '' ? String(remembered !== '' ? remembered : this.page?.lastUrl ?? this.lastUrl ?? 'about:blank') : String(url)
    /* The Flash-era app is one window and cannot open another, so a chat asking
       for a tab is handed that window, moved to the address it asked for. */
    if (this.flash) {
      const page = this.page
      await page.navigate(address)
      this.pages.set(id, page)
      this.touch()
      this.rememberTab(id, address)
      return page
    }
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(address)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) // ui-copy-ignore
    if (!created.ok) throw new Error('sidecar: could not open a tab')
    const target = await created.json()
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('sidecar: new tab has no socket')
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    const page = await this.bind(await new SidecarPage(cdp, this.profile, port, () => this.holding()).start()) // ui-copy-ignore
    this.pages.set(id, page)
    this.claim(id, page.targetId)
    this.touch()
    this.rememberTab(id, address)
    return page
  }

  /**
   * @param {{profile?: string, headless?: boolean, url?: string, session?: string}} [options] - how to start.
   * @returns {Promise<SidecarPage>} the page being driven.
   */
  async ensure(options = {}) {
    const page = await this.ensurePage(options)
    const id = String(options.session ?? '')
    if (id === '') return page
    const mine = this.pageFor(id)
    if (mine !== null) {
      /* A chat's tab can die on its own: a crash, a browser another call
         restarted, a tab closed by hand. Handing that corpse back leaves the
         mirror on a blank picture forever, so it has to answer before it is
         trusted again. */
      /* A page that answered a moment ago is still this chat's page. Pinging on
         every keystroke put a round trip inside the typing path for nothing. */
      const fresh = Date.now() - Number(mine.answeredAt ?? 0) < 1000
      const alive = fresh ? { ok: true, closed: false } : await mine.ping()
      if (alive.ok) {
        mine.answeredAt = Date.now()
        /* A blank tab after a restart is not where this chat was: the address it
           last had is on disk, and that is the one worth returning to. */
        if (String(mine.url ?? '') === 'about:blank') {
          const back = this.rememberedTab(id)
          if (back !== '') await mine.navigate(back)
        }
        const wanted = String(options.url ?? '')
        if (wanted !== '' && String(mine.url) !== wanted) await mine.navigate(wanted)
        this.rememberTab(id, String(mine.url ?? wanted))
        return mine
      }
      this.pages.delete(id)
      return this.tabFor(id, options.url === undefined || options.url === '' ? this.rememberedTab(id) : options.url)
    }
    /* A new tab for a chat that had one before opens where that chat was: a
       blank mirror is not a place, and the first call should not land on one. */
    return this.tabFor(id, options.url === undefined || options.url === '' ? this.rememberedTab(id) : options.url)
  }

  async ensurePage(options = {}) {
    if (options.profile !== undefined) this.profile = options.profile
    const wanted = options.headless === undefined ? this.headless : options.headless !== false
    const modeChanged = wanted !== this.headless
    this.headless = wanted
    /* Flash is another runtime, not another flag: the page has to move to the
       browser that still speaks PPAPI, and back when the switch goes off. */
    const wantFlash = options.flash === undefined ? this.flash : options.flash === true
    const flashChanged = wantFlash !== this.flash
    this.flash = wantFlash
    writeFlashChoice(wantFlash)
    /* A windowless browser and a windowed one are different processes, so asking
       for the other one has to restart it. Setting the flag alone left the request
       with no effect at all: a site that refuses a windowless browser stayed out
       of reach until the browser happened to close for an unrelated reason. */
    if (this.alive && (modeChanged || flashChanged)) {
      const wasAt = options.url || this.page?.lastUrl || this.lastUrl
      await this.shutdown()
      return this.ensure({ ...options, url: wasAt })
    }
    if (this.alive) {
      const page = this.page
      /* A page that stopped answering is a page nobody can drive. Start a new
         one on the address it was showing, rather than failing every call. */
      /* Every tool call used to pay a liveness round trip, and a keystroke
         burst paid it per key. An answer from the last second is still an
         answer; a page that dies in between fails its action loudly instead. */
      const fresh = Date.now() - Number(page.answeredAt ?? 0) < 1000
      let probe = page.dialog !== null && page.dialog !== undefined ? { ok: true } : fresh ? { ok: true, closed: false } : await page.ping()
      if (!probe.ok && !probe.closed) {
        await wait(150)
        probe = await page.ping()
      }
      if (probe.ok) page.answeredAt = Date.now()
      if (probe.ok) {
        void this.pruneStrays().catch(() => {})
        void this.reapIdleTabs().catch(() => {})
      }
      if (!probe.ok) {
        page.crashed = true
        this.note('renderer stopped answering; opening a fresh tab')
        /* An empty string is a page that never got an address, not a decision to
           stay blank: fall through to whatever this browser last showed. */
        const wasAt = options.url || page.lastUrl || this.lastUrl
        /* The browser itself is usually fine: only the renderer died. Opening a
           fresh tab in it is much faster than starting Chrome again. */
        try {
          return await this.recover(wasAt)
        } catch {
          await this.shutdown()
          return this.ensure({ ...options, url: wasAt })
        }
      }
      const wasBlanked = page.blanked === true && (String(page.url ?? '') === '' || String(page.url ?? '') === 'about:blank')
      if (wasBlanked) {
        page.blanked = false
        page.crashed = true
        this.note('renderer stopped answering; opening a fresh tab')
        try {
          return await this.recover(page.lastUrl || this.lastUrl)
        } catch {
          await this.shutdown()
          return this.ensure({ ...options, url: page.lastUrl || this.lastUrl })
        }
      }
      this.touch()
      /* Keep the last real address the browser was seen on: a renderer crash
         can blank the tab's own record before anyone asks, and coming back to
         about:blank loses the page the person was reading. */
      const seen = String(this.page?.url ?? '')
      if (seen !== '' && seen !== 'about:blank') this.lastUrl = seen
      const id = String(options.session ?? '')
      if (id !== '') {
        /* Another chat may be looking at another tab: this one gets its own. */
        const mine = await this.tabFor(id, options.url)
        return mine
      }
      if (options.url !== undefined && options.url !== '') await this.page.navigate(options.url)
      return this.page
    }
    if (this.starting !== null) return this.starting
    /* A page whose connection closed on its own (a renderer crash closes the
       tab's session) can be replaced in the browser that is still running. */
    if (this.page !== null && this.page.cdp?.closed === true) {
      const wasAt = options.url || this.page.lastUrl || this.lastUrl
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
    /* Chromium 87 opening the profile a current Chrome owns would downgrade it
       and lock it, so the Flash-era browser keeps a profile of its own. The two
       never share a directory; a game signed into one is signed in there only. */
    const dir = this.flash ? `${profileDir(this.profile)}-flash` : profileDir(this.profile)
    /* A profile whose cookie store went missing would look signed out at the
       next step even though the person never signed out, so the working copy
       is put back before the browser is asked to read it. */
    restoreLogin(dir)
    let port = await this.runningPort(dir) // ui-copy-ignore
    if (port === 0) port = await this.spawnChrome(dir) // ui-copy-ignore
    else this.owns = ownsBrowser({ pid: process.pid, owner: markerPid(dir) })
    const ws = await this.pageSocket(port) // ui-copy-ignore
    const cdp = new Cdp(ws)
    await cdp.ready
    this.cdp = cdp
    this.page = await this.bind(await new SidecarPage(cdp, this.profile, port, () => this.holding()).start()) // ui-copy-ignore
    if (url !== undefined && url !== '') this.lastUrl = String(url)
    await this.restoreSessionCookies()
    await this.page.cast()
    if (url !== undefined && url !== '') await this.page.navigate(url)
    this.touch()
    /* Sign-ins outlive this browser: what works now is worth a copy, taken
       while the cookies are known good rather than after they are lost. */
    snapshotLogin(dir)
    this.backup?.()
    this.backup = setInterval(() => snapshotLogin(dir), 10 * 60_000)
    this.backup.unref?.()
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
    const flash = this.flash ? flashRuntime() : null
    if (this.flash && flash === null) throw new Error('sidecar: no Flash runtime on this machine')
    const binary = flash === null ? firstBinary() : flash.binary
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
      /* A windowless build says "HeadlessChrome" in every request, and a site
         that checks for it answers the whole browser with a parked page. The
         browser is windowless, not a robot: say what a person's Chrome says. */
      `--user-agent=${DESKTOP_UA}`,
      /* A site that refuses a headless build still gets a window, but never on
         the desktop: the mirror in the column is the only thing to look at. */
      '--window-position=-3000,-3000',
      'about:blank',
    ]
    if (flash !== null) {
      /* Electron takes these switches through its own command line, not the
         argv it hands the app, so the runtime app reads them from here. */
      flash.port = Number(process.env.DSH_INNER_BROWSER_FLASH_PORT ?? 9200 + Math.floor(Math.random() * 400))
      flash.bridgePort = flash.port + 1
      args.length = 0
      args.push(FLASH_APP)
    } else if (this.headless) args.unshift('--headless=new')
    /* A browser started again after a stop is a new one: its death is news
       again, and the flag left behind by the stop must not silence it. */
    this.stopping = false
    const flashEnv = flash === null ? undefined : {
      ...process.env,
      DSH_FLASH_PORT: String(flash.port),
      DSH_FLASH_BRIDGE_PORT: String(flash.bridgePort),
      DSH_FLASH_UDD: dir,
      DSH_FLASH_PLUGIN: flash.plugin,
      DSH_FLASH_VERSION: flash.version,
      DSH_FLASH_URL: 'about:blank',
    }
    if (flashEnv !== undefined) {
      /* The harness runs Node with this set; Electron would start as Node. */
      delete flashEnv.ELECTRON_RUN_AS_NODE
    }
    const child = spawn(binary, args, { detached: false, stdio: 'ignore', env: flashEnv })
    const born = Date.now()
    child.on('exit', (code, signal) => {
      /* A browser that ends without being asked is the one case nobody can see:
         Chrome's own stderr goes nowhere, so leave a line behind. */
      noteDeath({ pid: child.pid, code, signal, profile: this.profile, asked: this.stopping === true || Date.now() - born < 3000 })
      if (this.child === child) {
        this.child = null
        this.cdp?.close()
        this.cdp = null
        this.page = null
      }
    })
    this.child = child
    /* Leave behind who started it: a browser found on this profile by another
       process must not be closed by that process on its way out. */
    try {
      writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() })) // ui-copy-ignore
      this.owns = true
    } catch {
      /* A profile that cannot take a marker is still usable, but it counts as
         somebody else's browser: no closing it from here. */
    }
    if (flash !== null) {
      for (let i = 0; i < 150; i += 1) {
        await wait(100)
        try {
          const response = await fetch(`http://127.0.0.1:${flash.port}/json/version`, { signal: AbortSignal.timeout(800) }) // ui-copy-ignore
          if (response.ok) {
            this.flashBridge = flash.bridgePort
            return flash.port // ui-copy-ignore
          }
        } catch {
          /* not up yet */
        }
      }
      throw new Error('sidecar: the Flash runtime did not open a debugging port') // ui-copy-ignore
    }
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
  async tabs(session = '') {
    const page = this.pageFor(session) ?? this.page
    if (page === null) return []
    const rows = await page.tabs()
    /* One address is one row: the base page can be showing the very place a
       chat's tab already shows, and two identical lines read as two pages. A
       page a chat holds represents that address; an unheld twin is left out,
       and the rows that stay keep the browser's order, which is the index
       space the tab tools address their rows by. */
    const held = new Set()
    for (const set of this.claims.values()) for (const target of set) held.add(String(target))
    const seen = new Set()
    const kept = []
    for (const row of [...rows].filter((item) => held.has(item.targetId)).concat(rows.filter((item) => !held.has(item.targetId)))) {
      const key = placeKey(row.url)
      if (key !== '' && seen.has(key)) continue
      if (key !== '') seen.add(key)
      kept.push(row)
    }
    kept.sort((a, b) => rows.indexOf(a) - rows.indexOf(b))
    return kept
  }

  /**
   * The windows this chat may see: the browser's own pages minus the ones other
   * chats are driving. A chat's column shows its own windows, never a
   * neighbour's.
   * @param {string} session - chat asking.
   * @returns {Promise<Array<{title: string, url: string, current: boolean, index: number}>>} its windows.
   */
  async windowsFor(session) {
    const list = await this.tabs(session)
    const page = this.pageFor(session) ?? this.page
    const foreign = new Set(typeof page?.siblings === 'function' ? page.siblings().map(String) : [])
    const who = String(session ?? '')
    const claimed = this.claims.get(who) ?? new Set()
    /* Tabs the browser no longer has must not linger in a chat's list. */
    if (claimed.size > 0) {
      const live = new Set(list.map((row) => String(row.targetId)))
      for (const id of [...claimed]) if (live.has(id) !== true) claimed.delete(id)
      if (claimed.size === 0) this.claims.delete(who)
    }
    const shown = []
    for (let at = 0; at < list.length; at += 1) {
      const row = list[at]
      if (foreign.has(String(row.targetId))) continue
      /* A tab nobody in this chat drove is not this chat's window: a page
         opened behind the browser's back belongs to no column. */
      if (row.current !== true && claimed.has(String(row.targetId)) !== true) continue
      /* The index is the browser's own row, not this shorter list's: switching
         goes back through `tabs()` unfiltered. */
      shown.push({ title: String(row.title ?? ''), url: String(row.url ?? ''), current: row.current === true, index: at })
    }
    return shown
  }

  /**
   * Move the mirror to another tab, leaving the old one open where it was.
   * @param {number} index - a row from `tabs()`.
   * @returns {Promise<SidecarPage>} the page now being driven.
   */
  /**
   * Tells a page which targets belong to other chats, so a popup lookup cannot
   * pick somebody else's tab.
   * @param {SidecarPage} page - a page this browser drives.
   * @returns {SidecarPage} the same page.
   */
  bind(page) {
    page.flashBridge = this.flashBridge
    /* The launch window is landscape; shrink it to the capture budget before
       anyone asks, so the first judged frame is not a 2 fps one. */
    if (this.flashBridge !== null) void page.setViewport(page.view.width, page.view.height).catch(() => {})
    page.siblings = () =>
      [...this.pages.values(), this.page]
        .filter((other) => other !== null && other !== undefined && other !== page)
        .map((other) => String(other.targetId ?? ''))
        .filter((id) => id !== '')
    return page
  }

  async useTab(index, session = '') {
    const list = await this.tabs(session)
    const tab = list[Number(index)]
    if (tab === undefined) throw new Error(`sidecar: no tab ${String(index)}`)
    const owned = String(session ?? '') !== ''
    const mine = owned ? this.pageFor(session) : null
    if (tab.current && mine !== null) return mine
    if (tab.current && !owned) return this.page
    if (tab.current) return this.page
    const was = mine ?? this.page
    /* A chat that owns a tab keeps owning one: switching moves the chat, not
       the browser's first tab that a different chat may be driving. */
    if (mine !== null) {
      const cdp = new Cdp(tab.webSocketUrl)
      await cdp.ready
      const page = await this.bind(await new SidecarPage(cdp, this.profile, mine.port, () => this.holding()).start()) // ui-copy-ignore
      this.pages.set(String(session), page)
      this.claim(session, tab.targetId)
      mine.cdp.send('Page.stopScreencast').catch(() => {})
      mine.cdp.close()
      await page.cast()
      this.touch()
      return page
    }
    const cdp = new Cdp(tab.webSocketUrl)
    await cdp.ready
    const page = await this.bind(await new SidecarPage(cdp, this.profile, was.port, () => this.holding()).start()) // ui-copy-ignore
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
  async closeTab(index, session = '') {
    const list = await this.tabs(session)
    const tab = list[Number(index)]
    if (tab === undefined) throw new Error(`sidecar: no tab ${String(index)}`)
    const mine = String(session ?? '') === '' ? null : this.pageFor(session)
    let port = (mine ?? this.page)?.port ?? 0 // ui-copy-ignore
    let alone = true
    if (tab.current) {
      const other = list.findIndex((item) => !item.current)
      alone = other < 0
      if (!alone) await this.useTab(other, session)
    }
    this.unclaim(session, tab.targetId)
    if (port > 0) await fetch(`http://127.0.0.1:${port}/json/close/${tab.targetId}`, { signal: AbortSignal.timeout(1000) }).catch(() => {}) // ui-copy-ignore
    if (alone && mine !== null) {
      /* The chat still needs somewhere to go: a fresh tab in the same browser. */
      this.pages.delete(String(session))
      await this.tabFor(String(session), 'about:blank')
      return
    }
    if (alone) {
      await this.shutdown()
      await this.ensure()
    }
  }

  async recover(url) {
    const port = this.page?.port ?? 0 // ui-copy-ignore
    if (port === 0) throw new Error('sidecar: no browser to recover into') // ui-copy-ignore
    let address = url === '' || url === undefined ? 'about:blank' : String(url)
    if (address === 'about:blank' && String(this.lastUrl ?? '') !== '' && this.lastUrl !== 'about:blank') address = String(this.lastUrl)
    if (this.flash) {
      await this.page.navigate(address)
      return this.page
    }
    const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(address)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) // ui-copy-ignore
    if (!created.ok) throw new Error('sidecar: could not open a tab to recover into')
    const target = await created.json()
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('sidecar: recovered tab has no socket')
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    this.cdp = cdp
    this.page = await this.bind(await new SidecarPage(cdp, this.profile, port, () => this.holding()).start()) // ui-copy-ignore
    /* The new tab may have finished loading before we attached, in which case
       no navigation event ever reaches us and the page would report the blank
       address it was created with. Ask it where it actually is. */
    let here = ''
    try {
      const out = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      here = String(out?.result?.value ?? '')
    } catch {}
    if (here !== '' && here !== 'about:blank') this.page.lastUrl = here
    else if (address !== 'about:blank') await this.page.navigate(address)
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
  async watch(sink, session = '') {
    const page = await this.ensure({ session })
    page.frames.add(sink)
    page.pointerSinks.add(sink)
    await page.cast()
    return () => {
      page.frames.delete(sink)
      page.pointerSinks.delete(sink)
      if (page.frames.size === 0) void page.stopCast()
    }
  }

  /** @returns {number} how many panes are watching a picture right now. */
  watched() {
    let n = this.page?.frames?.size ?? 0
    for (const page of this.pages?.values() ?? []) n += page.frames?.size ?? 0
    return n
  }

  /**
   * Starts the idle clock again.
   * @param {number} [ms] - how long a browser nobody watches may stay up.
   */
  touch(ms = IDLE_MS) {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      this.idle = null
      /* Someone is watching the mirror: the page stays up, and the clock starts
         again so the browser is closed only once it is truly unused. */
      let watched = this.page?.frames.size ?? 0
      for (const page of this.pages.values()) watched += page.frames?.size ?? 0
      if (watched > 0) {
        this.touch()
        return
      }
      void this.shutdown()
    }, ms)
    this.idle.unref?.()
  }

  /** @returns {Promise<void>} resolves once Chrome is gone. */
  /**
   * Leaves the browser running for whoever loads this plugin next, and puts the
   * sign-in on disk first. A plugin reload used to close Chrome, so the column
   * lost the page and every sign-in paid for a fresh launch; the browser is
   * meant to outlive the driver. A detached watcher closes the browser once
   * this app is really gone, so nothing is left behind.
   * @returns {Promise<void>} done, with the browser still up.
   */
  async handoff() {
    this.stopping = true
    if (this.page !== null) await this.saveSessionCookies()
    if (this.backup !== undefined) clearInterval(this.backup)
    this.backup = undefined
    try {
      snapshotLogin(profileDir(this.profile))
    } catch {
      /* a profile that cannot be copied is not a reason to drop the browser */
    }
    const chrome = Number(this.child?.pid ?? 0)
    if (chrome === 0) return
    /* One watcher per application run, watching the application rather than
       this instance: a plugin reload is not the app closing. */
    /* Read at call time, so a test can point the note somewhere harmless. */
    const dir = process.env.DSH_INNER_BROWSER_STATE_DIR || tabsDir
    const app = appPid()
    /* A watcher may only watch the application: one keyed to the node instance
       a reload replaces closes the browser at that reload. When the walk cannot
       name the app, no watcher is armed at all rather than a wrong one. */
    if (app === 0 || looksLikeApp(commandOf(app)) === false) return
    try {
      const said = JSON.parse(readFileSync(watcherFile(dir), 'utf8'))
      const watching = Number(said?.appPid ?? 0)
      const alive = (() => {
        try {
          process.kill(Number(said?.pid ?? 0), 0)
          return true
        } catch {
          return false
        }
      })()
      /* Same run and same browser: the watcher already covers it. A browser
         that was restarted needs the note pointed at the new pid, or the app
         going away would leave the new one running. */
      if (alive && Number(said?.chrome ?? 0) === chrome && watching === Number(said?.appPid) && (app === 0 || watching === app)) return
      if (alive) {
        try {
          process.kill(Number(said?.pid ?? 0))
        } catch {
          /* a watcher that already left needs no goodbye */
        }
      }
    } catch {
      /* no watcher yet, or one whose note is unreadable */
    }
    /* Detached and unref'd: the app must not wait for this, and it must outlive
       the plugin instance it was started for. Windows has no `/bin/sh`, so there
       the lifetime rides on the browser itself: `taskkill /T` already ends the
       whole tree when this process is gone, and spawning a POSIX watcher here
       would only throw ENOENT and be swallowed. */
    if (process.platform === 'win32') return
    try {
      const guard = spawn('/bin/sh', ['-c', `while kill -0 ${app} 2>/dev/null; do sleep 5; done; kill ${chrome} 2>/dev/null`], {
        detached: true,
        stdio: 'ignore',
      })
      guard.unref()
      mkdirSync(dir, { recursive: true })
      writeFileSync(watcherFile(dir), JSON.stringify({ appPid: app, pid: guard.pid ?? 0, chrome, at: Date.now() }))
    } catch {
      /* a watcher that cannot start only means the browser outlives the app */
    }
  }

  async shutdown() {
    /* A browser this process did not start belongs to somebody else — another
       app on the same profile, or a script that connected to it — and closing
       it would close the person's window. Let go of it instead: drop the socket
       and leave the browser running. */
    const mine = this.owns === true
    if (mine && this.page !== null) {
      /* Ask Chrome to close first: a browser that is killed outright may lose
         the last minute of cookies, and keeping the person signed in is the
         point. */
      await this.saveSessionCookies()
      snapshotLogin(profileDir(this.profile))
    }
    if (this.backup !== undefined) clearInterval(this.backup)
    this.backup = undefined
    if (this.cdp !== null && mine) {
      await this.cdp.send('Browser.close').catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.page = null
    this.pages.clear()
    this.cdp?.close()
    this.cdp = null
    if (this.child !== null) {
      const child = this.child
      try {
        /* A browser on Windows is a process tree: terminating the launcher alone
           leaves renderers and the profile lock behind. Browser.close above is
           the graceful path; this is the one for a browser that ignored it. */
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          child.kill('SIGTERM')
          /* Electron with an offscreen window can ignore SIGTERM while a plugin
             paints; a leftover helper keeps the profile locked and shows up as a
             stray process on the person's desktop. Escalate by pid. */
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              try {
                child.kill('SIGKILL')
              } catch {
                /* already gone */
              }
              resolve()
            }, 1500)
            child.once('exit', () => {
              clearTimeout(timer)
              resolve()
            })
          })
        }
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
    /* A cookie the browser already holds is newer than the note: the site may
       have rotated its session id since the note was written, and putting the
       old value back is exactly how a working sign-in turns into a logout. */
    let live = []
    try {
      live = await this.page.cookies()
    } catch {
      live = []
    }
    const held = new Set(live.map((c) => `${String(c.domain ?? '').replace(/^\./, '')}|${String(c.path ?? '/')}|${String(c.name ?? '')}`))
    for (const cookie of jar.slice(0, 200)) {
      const domain = String(cookie?.domain ?? '').replace(/^\./, '')
      if (domain === '') continue
      if (held.has(`${domain}|${String(cookie?.path ?? '/')}|${String(cookie.name)}`)) continue
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
  /**
   * What the browser holds for one chat, when the caller names it.
   * @param {string} [session] - chat id.
   * @returns {{url: string, title: string, viewers: number, alive: boolean, remembered: string}} its page.
   */
  async chatState(session = '') {
    const id = String(session ?? '')
    /* A chat whose tab is gone still knows where it was: that address is what
       the pane offers to bring back, so a lost picture is one click, not a
       question about which site it used to be. */
    const remembered = this.rememberedTab(id)
    const page = id === '' ? null : this.pageFor(id)
    const expired = this.expired?.has(id) === true
    if (page === null || page === undefined) return { url: '', title: '', viewers: 0, alive: false, expired, remembered } // ui-copy-ignore
    return { url: String(page.url ?? ''), title: String(page.title ?? ''), viewers: page.frames?.size ?? 0, alive: true, expired, remembered } // ui-copy-ignore
  }

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
      pages: this.pages.size,
      title: this.page?.title ?? '',
      viewers: this.page?.frames.size ?? 0,
      /* Everyone watching any chat's picture: the pane in the right column is
         one of these, so 0 means no column is attached right now. */
      watchers: [...this.pages.values()].reduce((sum, page) => sum + (page.frames?.size ?? 0), 0),
      frames: this.page?.seq ?? 0,
      crashed: this.page?.crashed === true,
      pointer: this.page?.pointer ?? null,
      /* Frames that repeated the pane's picture and were dropped instead of
         sent: the number a static page spends on nothing. */
      quiet: this.page?.quiet ?? 0,
      /* Layout size of the page the pane is showing: a coordinate from a
         screenshot is in this space, not in the window's. */
      viewport: this.page?.view ?? null,
      profiles,
      error: this.alive ? '' : this.lastError,
    }
  }
}
