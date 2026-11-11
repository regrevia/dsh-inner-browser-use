/**
 * The sidecar browser: a real Chrome that the Host owns. // ui-copy-ignore
 *
 * A separate process with its own on-disk profile: a login survives a restart,
 * and a page keeps working while the person looks somewhere else. The column
 * shows it as a screencast, so the tab is a viewer, not the browser.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GapClock, MAX_REST_MS, MIN_REST_MS, decide } from './rest.js'
import flashInputPlanner from './runtime/flash-input.cjs'
import { readyFlash } from './runtime/flash-setup.mjs'
import { readSealed, tightenDir, writeSealed } from './vault.js'
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

/* A column on a scaled display draws in two device pixels per CSS pixel. The
   picture is captured at that size and the page is never told: the layout keeps
   counting clicks in CSS pixels while the pane gets the detail its screen has. */
const CRISP_GAP_MS = 42 // ui-copy-ignore
const CRISP_MAX = 2
const CRISP_ROOM = 4096

/* A tall column at two device pixels per CSS pixel asks for a picture bigger
   than any screen: a 2400 CSS tall pane wants 4800 pixels of height, and one
   such capture measured 160 KB and 132 ms per frame. The detail is worth
   having, the bill is not, so the capture keeps within a budget of pixels and
   a tall pane gets a lower scale instead of a heavier frame. */
const CRISP_PIXELS = 4_200_000 // ui-copy-ignore
/* The widest page the mirror lays out: a window across two displays, a five-K
   panel in its wide setting. Beyond this the page is clamped rather than left
   showing the shape of the size before it. */
const MAX_VIEW = 4096

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
/* A Flash window answers input in milliseconds or not at all: a post that has
   not answered in this long is treated as a loss, not as a slow success. */
const INPUT_TIMEOUT_MS = 1200
/* After two lost posts the bridge is left alone for this long. A stopped window
   is still a running process: asking it again on every keystroke would cost the
   whole timeout each time, and the debugging protocol can carry input instead. */
const INPUT_REST_MS = 30_000
/* Ceiling for the process tree, renderers included. macOS reports each
   renderer's RSS as if it were private, so an ordinary one-page browser reads
   as ~1.4 GB; the number is comparable across runs, which is what a limit
   needs, rather than an accounting of what is really unique. Past the ceiling
   tabs nobody watches go first, and the browser itself when nobody watches at
   all. Raise it when a page really needs more. */
const BUDGET_MB = Number(process.env.DSH_INNER_BROWSER_MEMORY_MB ?? 2400) || 2400
/* How often the lifecycle is looked at, and how often memory is sampled. The
   beat is what makes the clock survive a lost timer: a plugin reload, a laptop
   asleep, a timer that fired into a stopped browser. */
const BEAT_MS = 5000
const SAMPLE_MS = 30_000

/** @param {number} ms - how long to wait. @returns {Promise<void>} resolves after it. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @param {number} root - a process id. @returns {number} bytes of RSS the process tree holds. */
function treeBytes(root) {
  if (!Number.isFinite(root) || root <= 0) return 0
  try {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 3000 })
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/u))
      .filter((cols) => cols.length >= 3)
    /** @type {Map<number, number[]>} */
    const byParent = new Map()
    /** @type {Map<number, number>} */
    const size = new Map()
    for (const [pid, ppid, rss] of rows) {
      const parent = Number(ppid)
      const kids = byParent.get(parent) ?? []
      kids.push(Number(pid))
      byParent.set(parent, kids)
      size.set(Number(pid), Number(rss) * 1024)
    }
    let total = size.get(root) ?? 0
    const queue = [root]
    const seen = new Set()
    while (queue.length > 0) {
      const pid = queue.shift()
      if (seen.has(pid)) continue
      seen.add(pid)
      for (const kid of byParent.get(pid) ?? []) {
        total += size.get(kid) ?? 0
        queue.push(kid)
      }
    }
    return total
  } catch {
    return 0
  }
}

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

/**
 * What the browser said about its own plugin list. A plugin runtime that opens
 * its port but carries no PPAPI module looks fine from outside and plays
 * nothing, so the list is read and turned into a sentence rather than trusted.
 * @param {unknown} names - plugin names from the page.
 * @returns {{ok: boolean, name: string}} whether a Flash plugin is there.
 */
export function flashVerdict(names) {
  const list = (Array.isArray(names) ? names : []).map((one) => String(one ?? ''))
  const found = list.find((one) => one.toLowerCase().includes('shockwave'))
  return { ok: found !== undefined, name: found ?? '' }
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
  if (process.platform === 'win32') return appFromTable(process.pid, processTable())
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
 * Windows has no `ps`, and the whole ancestry can be read in one call, so the
 * table is fetched once and walked here. A shell or a node instance is the
 * thing a reload replaces, never the application, so the first ancestor that is
 * neither is the one a watcher may watch; when no ancestor qualifies the walk
 * answers nobody, and no watcher is armed rather than one keyed to a process
 * that comes and goes with a reload.
 * @param {number} pid - this process.
 * @param {Map<number, {parent: number, command: string}>} table - pid to its parent and command line.
 * @returns {number} the application pid, or 0 when the walk cannot name it.
 */
export function appFromTable(pid, table) {
  if (table === null || table === undefined || typeof table.get !== 'function') return 0
  let at = Number(pid)
  if (!Number.isInteger(at) || at <= 1) return 0
  const seen = new Set([at])
  const ancestors = []
  for (let hop = 0; hop < 12; hop += 1) {
    const said = table.get(at)
    const parent = Number(said?.parent ?? 0)
    if (!Number.isInteger(parent) || parent <= 1 || seen.has(parent)) break
    seen.add(parent)
    ancestors.push(parent)
    at = parent
  }
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const candidate = ancestors[i]
    if (looksLikeApp(table.get(candidate)?.command, 'win32') === true) return candidate
  }
  return 0
}

/**
 * The process table, read once: a Windows walk needs every hop, and one call
 * for all of them costs less than `ps` would. PowerShell is the path a current
 * Windows keeps; `wmic` is the fallback for an image that still has it.
 * @returns {Map<number, {parent: number, command: string}>} pid to its parent and command.
 */
function processTable() {
  const table = new Map()
  if (process.platform !== 'win32') return table
  const queries = [
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress']],
    ['wmic.exe', ['process', 'get', 'processid,parentprocessid,commandline', '/format:csv']],
  ]
  for (const [binary, args] of queries) {
    let said = ''
    try {
      said = String(execFileSync(binary, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }))
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(said) // ui-copy-ignore
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      for (const row of rows) {
        const pid = Number(row?.ProcessId ?? 0) // ui-copy-ignore
        if (!Number.isInteger(pid) || pid <= 0) continue
        table.set(pid, { parent: Number(row?.ParentProcessId ?? 0), command: String(row?.CommandLine ?? '') })
      }
    } catch {
      for (const line of said.split(/\r?\n/u)) {
        const cells = line.split(',')
        if (cells.length < 4) continue
        const pid = Number(cells[3])
        if (!Number.isInteger(pid) || pid <= 0) continue
        table.set(pid, { parent: Number(cells[2]), command: cells.slice(4).join(',') })
      }
    }
    if (table.size > 0) return table
  }
  return table
}

/**
 * Whether a process command line is the application itself, rather than the node
 * instance a reload replaces. A watcher keyed to the node instance would kill
 * the shared browser on every reload, which is exactly what made the column go
 * blank; a command line with `--expose-internals` is that instance.
 * @param {string} command - what `ps -o command=` said.
 * @returns {boolean} true for the app binary itself.
 */
export function looksLikeApp(command, platform = process.platform) {
  const line = String(command ?? '').trim()
  if (line === '' || line.includes('--expose-internals')) return false
  if (platform === 'win32') {
    /* A node instance is what a reload replaces, a shell is what launched one:
       neither is the application, whatever directory it sits in. */
    const binary = String((/^"([^"]+)"/u.exec(line) ?? /^(.+?\.exe)(?:\s|$)/iu.exec(line))?.[1] ?? line).toLowerCase()
    const name = binary.split(/[\\/]/u).pop() ?? ''
    if (['node.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wmic.exe', 'conhost.exe'].includes(name)) return false
    return name.endsWith('.exe')
  }
  return line.includes('.app/Contents/MacOS/')
}

/**
 * @param {number} pid - a process.
 * @returns {string} its command line, or '' when it is gone.
 */
function commandOf(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return ''
  if (process.platform === 'win32') return String(processTable().get(pid)?.command ?? '')
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
/**
 * The picture's own size, read from its JPEG frame header.
 * @param {string} data - base64 JPEG.
 * @returns {{width: number, height: number}|null} the size in pixels, or null when it is not a JPEG this can read.
 */
export function jpegSize(data) {
  const text = typeof data === 'string' ? data : ''
  if (text.length < 24) return null
  const raw = Buffer.from(text, 'base64')
  let at = 2
  while (at + 9 < raw.length) {
    if (raw[at] !== 0xFF) {
      at += 1
      continue
    }
    const marker = raw[at + 1]
    /* Markers with no length of their own. */
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      at += 2
      continue
    }
    /* The scan begins: everything after it is entropy-coded, not headers. */
    if (marker === 0xDA || marker === 0x00) return null
    const length = raw.readUInt16BE(at + 2)
    if (length < 2) return null
    /* Every start-of-frame carries the size of the picture it describes. */
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      if (at + 8 >= raw.length) return null
      return { width: raw.readUInt16BE(at + 7), height: raw.readUInt16BE(at + 5) }
    }
    at += 2 + length
  }
  return null
}

/**
 * The picture's own size, read from its PNG header. A clip is asked for in CSS
 * pixels and comes back in device pixels whenever the page zooms, so the file
 * is the only thing that knows how many pixels it really has.
 * @param {string} data - base64 PNG.
 * @returns {{width: number, height: number}|null} the size in pixels, or null when it is not a PNG.
 */
export function pngSize(data) {
  const text = typeof data === 'string' ? data : ''
  if (text.length < 32) return null
  const raw = Buffer.from(text, 'base64')
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (raw.length < 24 || raw.subarray(0, 8).equals(magic) !== true) return null
  return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) }
}

/* Every key on a US keyboard that makes one character: the name, the physical
   code and the number the page reads off the event. A page that keys off
   `keyCode` (a remote desktop, a game, an editor with its own keymap) ignores a
   synthetic key whose code is 0. */
const CHAR_ROWS = [
  ['a', 'KeyA', 65, 0], ['b', 'KeyB', 66, 0], ['c', 'KeyC', 67, 0], ['d', 'KeyD', 68, 0], ['e', 'KeyE', 69, 0],
  ['f', 'KeyF', 70, 0], ['g', 'KeyG', 71, 0], ['h', 'KeyH', 72, 0], ['i', 'KeyI', 73, 0], ['j', 'KeyJ', 74, 0],
  ['k', 'KeyK', 75, 0], ['l', 'KeyL', 76, 0], ['m', 'KeyM', 77, 0], ['n', 'KeyN', 78, 0], ['o', 'KeyO', 79, 0],
  ['p', 'KeyP', 80, 0], ['q', 'KeyQ', 81, 0], ['r', 'KeyR', 82, 0], ['s', 'KeyS', 83, 0], ['t', 'KeyT', 84, 0],
  ['u', 'KeyU', 85, 0], ['v', 'KeyV', 86, 0], ['w', 'KeyW', 87, 0], ['x', 'KeyX', 88, 0], ['y', 'KeyY', 89, 0],
  ['z', 'KeyZ', 90, 0],
  ['0', 'Digit0', 48, 0], ['1', 'Digit1', 49, 0], ['2', 'Digit2', 50, 0], ['3', 'Digit3', 51, 0], ['4', 'Digit4', 52, 0],
  ['5', 'Digit5', 53, 0], ['6', 'Digit6', 54, 0], ['7', 'Digit7', 55, 0], ['8', 'Digit8', 56, 0], ['9', 'Digit9', 57, 0],
  [' ', 'Space', 32, 0], ['\n', 'Enter', 13, 0], ['\t', 'Tab', 9, 0], ['\r', 'Enter', 13, 0],
  ['-', 'Minus', 189, 0], ['=', 'Equal', 187, 0], ['[', 'BracketLeft', 219, 0], [']', 'BracketRight', 221, 0],
  ['\\', 'Backslash', 220, 0], [';', 'Semicolon', 186, 0], ["'", 'Quote', 222, 0], [',', 'Comma', 188, 0],
  ['.', 'Period', 190, 0], ['/', 'Slash', 191, 0], ['`', 'Backquote', 192, 0],
]
/* The shifted half of those keys: same physical key, one modifier bit, a
   different character. Without the shift bit a page sees "1" where the hand
   typed "!". */
const SHIFT_ROWS = [
  ['A', 'KeyA', 65], ['B', 'KeyB', 66], ['C', 'KeyC', 67], ['D', 'KeyD', 68], ['E', 'KeyE', 69], ['F', 'KeyF', 70],
  ['G', 'KeyG', 71], ['H', 'KeyH', 72], ['I', 'KeyI', 73], ['J', 'KeyJ', 74], ['K', 'KeyK', 75], ['L', 'KeyL', 76],
  ['M', 'KeyM', 77], ['N', 'KeyN', 78], ['O', 'KeyO', 79], ['P', 'KeyP', 80], ['Q', 'KeyQ', 81], ['R', 'KeyR', 82],
  ['S', 'KeyS', 83], ['T', 'KeyT', 84], ['U', 'KeyU', 85], ['V', 'KeyV', 86], ['W', 'KeyW', 87], ['X', 'KeyX', 88],
  ['Y', 'KeyY', 89], ['Z', 'KeyZ', 90],
  ['!', 'Digit1', 49], ['@', 'Digit2', 50], ['#', 'Digit3', 51], ['$', 'Digit4', 52], ['%', 'Digit5', 53],
  ['^', 'Digit6', 54], ['&', 'Digit7', 55], ['*', 'Digit8', 56], ['(', 'Digit9', 57], [')', 'Digit0', 48],
  ['_', 'Minus', 189], ['+', 'Equal', 187], ['{', 'BracketLeft', 219], ['}', 'BracketRight', 221],
  ['|', 'Backslash', 220], [':', 'Semicolon', 186], ['"', 'Quote', 222], ['<', 'Comma', 188], ['>', 'Period', 190],
  ['?', 'Slash', 191], ['~', 'Backquote', 192],
]
const CHAR_KEYS = new Map()
for (const [one, code, keyCode, modifiers] of CHAR_ROWS) CHAR_KEYS.set(one, { key: one, code, keyCode, modifiers })
for (const [one, code, keyCode] of SHIFT_ROWS) CHAR_KEYS.set(one, { key: one, code, keyCode, modifiers: 8 })

/**
 * The event a keyboard sends for one character: its name, its physical code,
 * the number a page reads, and whether a shift is behind it.
 * @param {string} one - one character of text.
 * @returns {{key: string, code: string, keyCode: number, modifiers: number}|null} the spec, or null when the character is not on a US keyboard.
 */
export function charSpec(one) {
  const spec = CHAR_KEYS.get(String(one))
  return spec === undefined ? null : { ...spec }
}

export function canArmWatcher() {
  const app = appPid()
  return app !== 0 && looksLikeApp(commandOf(app), process.platform) === true
}

/**
 * The code a watcher runs. It is node, so both platforms get the same loop:
 * wait for the application to go, then close the browser. A browser killed
 * outright can lose the last minute of cookies, so it is asked first and
 * terminated afterwards, as a tree on Windows.
 */
export const WATCHER_SCRIPT = `const [app, chrome, every] = process.argv.slice(1).map(Number)
if (!(app > 0 && chrome > 0 && every > 0)) process.exit(1)
const tick = () => {
  let up = true
  try {
    process.kill(app, 0)
  } catch {
    up = false
  }
  if (up) return setTimeout(tick, every)
  try {
    if (process.platform === 'win32') {
      require('node:child_process').spawnSync('taskkill', ['/pid', String(chrome), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(chrome, 'SIGTERM')
    }
  } catch {
    /* already gone */
  }
  process.exit(0)
}
setTimeout(tick, every)`

/**
 * Starts a watcher on the application's pid, detached so the app does not wait
 * for it and it outlives the plugin instance that armed it.
 * @param {{app?: number, chrome?: number, every?: number}} said - the application, the browser, and how often to look.
 * @returns {number} the watcher's pid, or 0 when it could not be started.
 */
function armWatcher(said) {
  const app = Number(said?.app ?? 0)
  const chrome = Number(said?.chrome ?? 0)
  const every = Number(said?.every ?? 5000)
  if (!Number.isInteger(app) || app <= 0 || !Number.isInteger(chrome) || chrome <= 0) return 0
  try {
    const guard = spawn(process.execPath, ['-e', WATCHER_SCRIPT, String(app), String(chrome), String(every)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    guard.unref()
    return Number(guard.pid ?? 0)
  } catch {
    return 0
  }
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
/** Pids that carry `mark` in their environment, read from one `ps -E` dump.
 *
 * The Flash bridge each session starts is one Electron app with five helpers.
 * They sit in their own process group, so one group kill covers them; a helper
 * that escaped the group (Electron re-parents some of its children) still
 * paints and still plays sound. Its environment names the number this session
 * gave it and no other session has it, so this finds exactly those
 * helpers and never a bridge another session is still showing.
 * @param {string} psOutput lines of `pid=,command=` with environments appended.
 * @param {string} mark an environment entry such as `DSH_FLASH_BRIDGE_PORT=9411`.
 * @returns {number[]} pids, oldest first, this process excluded by the caller.
 */
export function pidsWithMark(psOutput, mark) {
  const wanted = String(mark ?? '')
  if (wanted === '') return []
  const found = []
  for (const line of String(psOutput ?? '').split('\n')) {
    const pid = /^\s*(\d+)\s/.exec(line)
    if (pid === null) continue
    /* The environment ends the line: the last entry has no space after it. */
    if (line.includes(`${wanted} `) !== true && line.trimEnd().endsWith(wanted) !== true) continue
    const number = Number(pid[1])
    if (Number.isInteger(number) && number > 0) found.push(number)
  }
  return found
}

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

/**
 * Whether a browser found on this profile is free to take: the process named in
 * the marker has gone, so nobody is left to close it. A browser whose starter
 * died would otherwise outlive every run — on Windows there is no lifetime
 * watcher at all, so the next mirror attached to a browser from a previous
 * session, with its old page and its old shape, and every click went to a
 * window the person could no longer see.
 * @param {{pid?: number, owner?: number}} said - this process, and the marker's pid.
 * @param {boolean} alive - whether the marker's process still exists.
 * @returns {boolean} true when this process may adopt the browser.
 */
export function mayClaim(said, alive) {
  const mine = Number(said?.pid ?? 0)
  const owner = Number(said?.owner ?? 0)
  if (!Number.isInteger(mine) || mine <= 0) return false
  if (owner === mine) return true
  return alive !== true
}

/**
 * @param {number} pid - a process the marker named.
 * @returns {boolean} true while that process still exists.
 */
function pidAlive(pid) {
  const number = Number(pid)
  if (!Number.isInteger(number) || number <= 0) return false
  try {
    process.kill(number, 0)
    return true
  } catch (error) {
    /* A process we are not allowed to signal still exists. */
    return error?.code === 'EPERM'
  }
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
  /* A copy of a cookie store is a copy of every sign-in in it: nobody else gets
     to read the folder or the files, even on a shared machine. */
  tightenDir(to)
  const stamp = String(Date.now())
  for (const row of files) {
    const target = join(to, `${stamp}-${row.name.replace(/\//g, '_')}`)
    copyFileSync(row.from, target)
    try {
      chmodSync(target, 0o600)
    } catch {
      /* best effort */
    }
  }
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
    /* The page box the last picture really showed, in CSS pixels: a captured
       picture is the visible viewport, which is narrower than the window by
       its scrollbars, and the pane maps a click through this box. */
    this.frameBox = /** @type {{width: number, height: number}|null} */ (null)
    /* The last size a frame announced, in device pixels: the same size twice
       in a row is the same layout, and asking again would spend a round trip
       per frame. */
    this.seenFrame = /** @type {{width: number, height: number}|null} */ (null)
    /* The scale between a frame's device pixels and the page's own: learned
       from the page, and what lets a resize be believed on the frame that
       reports it instead of one frame later. */
    this.dpr = 0
    /* The scale the pane draws at. A mirror rendered at 1x and stretched by
       the display is soft; rendering at the pane's own scale keeps small text
       and hairlines legible without asking the encoder for more than it gives. */
    this.paneDpr = 1
    /* How many device pixels the column draws per CSS pixel, and which capture
       loop owns the cast: a restart bumps the number so the old loop stops. */
    this.castScale = 1 // ui-copy-ignore
    this.castGen = 0 // ui-copy-ignore
    /* Whether this page's screencast has proved it delivers frames, and how
       many it has sent since the last start. */
    this.castLive = true // ui-copy-ignore
    this.castSeen = 0 // ui-copy-ignore
    this.liveClock = null
    /** The scale the page was last told to draw at; null until it is told once. */
    this.appliedScale = null
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
    /* The point the plugin last saw the mouse reach: a press somewhere else
       moves there first, because a Flash button ignores a press it never saw
       the hand arrive for. */
    this.lastFlashPoint = null
    /* Whether the last input really reached the page: a click swallowed by a
       socket that had already died is why a pane looked alive and did nothing. */
    this.inputFails = 0
    this.inputFault = ''
    /* Health of the input bridge, so a stalled window costs nothing per event. */
    this.flashInputFails = 0
    this.flashInputPausedUntil = 0
    /* Which buttons the plugin believes are held: a drag is only a drag to it
       when the moves in between carry the button. */
    this.flashButtons = 0
    /* Which button the page believes is held: a move in a drag carries it. */
    this.buttons = 0
    /* The name of the button that is down, for the moves in between: the
       browser only runs a selection when a move names the button as well as
       counting it. */
    this.heldButton = 'none'
    this.url = ''
    this.lastUrl = ''
    this.crashed = false
    this.title = ''
    this.casting = false
    /* A frame that says the page changed shape is held back until the page has
       been asked its new shape: the two must never disagree in the pane. */
    this.resizing = false
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
    this.mediaOn = true
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
    /* A page that changes size while casting needs the cast restarted at the
       new size, once: a window being dragged asks for dozens of sizes. */
    this.sizeClock = null
    /* When the address was last asked for: how long a failure took tells a
       browser still starting up apart from a network that said no. */
    this.navAt = 0
    /* The tab this page drives, and the tabs other chats drive. A tab another
       chat owns is never a popup of this one: closing it, or navigating this
       page to its address, would take a page away from somebody else. */
    this.targetId = ''
    this.siblings = () => []
    /* Opening a tab on purpose is not a popup to follow: while the browser is
       being asked for one, a page target that appears is ours. */
    this.busy = () => false
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
      const ours = typeof this.busy === 'function' && this.busy() === true
      if (!ours && String(info.type ?? '') === 'page' && String(info.targetId ?? '') !== String(this.targetId ?? '')) {
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
    if (this.mediaOn === false) return
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
   * Stop or resume remembering media on this page; stopping empties the list so
   * nothing is kept from before the switch.
   * @param {boolean} on - false stops, true resumes.
   * @returns {boolean} what it is set to.
   */
  mediaWatch(on) {
    this.mediaOn = on !== false
    if (!this.mediaOn) this.media = new Map()
    return this.mediaOn
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

  /**
   * Whether this picture is the size of the column it is about to fill. A cast
   * restarted right after a resize hands over one frame of the size before it;
   * drawn against the new size that picture sits letterboxed in the pane and a
   * click in it lands off by the difference. A picture that is not the page's
   * own size is dropped, and the next one - always the right size - takes its
   * place without the pane ever showing the wrong shape.
   * @param {string} data - base64 JPEG of the page. @returns {boolean} true when it must not be shown.
   */
  staleFrame(data) {
    /* A scaled capture is asked for at its own size, so only a live cast is
       checked: there the page and the picture are the same pixels. */
    if (!(this.castScale <= 1)) return false
    const scale = this.dpr > 0 ? this.dpr : 1
    const width = Math.round(this.view.width * scale)
    const height = Math.round(this.view.height * scale)
    const size = jpegSize(data)
    /* A picture whose size cannot be read is shown rather than hidden. */
    if (size === null || size.width < 16 || size.height < 16) return false
    return Math.abs(size.width - width) > 2 || Math.abs(size.height - height) > 2
  }

  /**
   * Hands one picture to every pane watching this tab, at the pace a person can
   * see. How the picture was made is not the pane's concern: a cast frame and a
   * captured one leave through here, so both keep the same counters and limits.
   * @param {string} data - base64 JPEG of the page.
   * @returns {void}
   */
  deliverFrame(data) {
    this.seq += 1
    this.bytes += data.length
    if (this.resizing === true) return
    if (this.staleFrame(data) === true) return
    /* Every so often, let the weight of the last frame decide the quality the
       next one is made at: a heavy page pays for itself in every later frame. */
    if ((this.seq % 24 === 0 || this.seq === 1) && Date.now() - this.adaptAt > 3000) {
      this.adaptAt = Date.now()
      const wanted = nextQuality(this.castQuality, data.length)
      if (wanted !== this.castQuality) void this.recast(wanted)
    }
    /* A page that is not moving sends the same bytes again and again; the pane
       already shows that picture, so it is dropped. */
    if (this.frames.size > 0 && this.repeats(data) === true) return
    if (this.tooSoon()) return
    this.inflight += 1
    /* The pane maps a click through these numbers, so they name the page box
       the picture really shows: a captured picture is the visible viewport,
       which is the window minus its scrollbars. */
    const box = this.frameBox ?? this.view
    const frame = {
      seq: this.seq, // ui-copy-ignore
      w: box.width, // ui-copy-ignore
      h: box.height, // ui-copy-ignore
      jpeg: data, // ui-copy-ignore
      url: this.url, // ui-copy-ignore
      title: this.title, // ui-copy-ignore
      pointer: this.pointer, // ui-copy-ignore
      /* Which tab this picture came from: the pane sends it back with every
         click, so input cannot land on a page the person never saw. */
      target: this.targetId, // ui-copy-ignore
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
  }

  /**
   * The visible page, in the document's own pixels.
   *
   * A captured clip is measured from the top of the document, not from the
   * window, so a scrolled page needs its offset: without it the picture shows
   * the top of the page while the pane is looking at the middle, and after a
   * wheel turn the mirror fills with whatever stands above the page. The box is
   * the visual viewport, which is the window minus its scrollbars: a scrollbar
   * is window, not page, and capturing it packs a blank strip down the side of
   * the picture that no page content can ever fill.
   * @returns {Promise<{x: number, y: number, width: number, height: number}>} the box a picture must show.
   */
  async castBox() {
    const shape = await this.cdp.send('Page.getLayoutMetrics').catch(() => null)
    const seen = shape?.cssVisualViewport
    const num = (value, fallback) => {
      const asked = Number(value)
      return Number.isFinite(asked) && asked >= 0 ? asked : fallback
    }
    return {
      x: Math.round(num(seen?.pageX, 0)),
      y: Math.round(num(seen?.pageY, 0)),
      width: Math.max(1, Math.round(num(seen?.clientWidth, this.view.width))),
      height: Math.max(1, Math.round(num(seen?.clientHeight, this.view.height))),
    }
  }

  /**
   * The column draws more device pixels than the page has CSS pixels, so the
   * picture is captured at that size instead of being cast from the display:
   * a clip scales the image and leaves the layout and the input units alone,
   * which is the one way to get a sharp mirror without moving every click.
   * One capture at a time, paced and cancelled like the cast.
   * @returns {Promise<void>}
   */
  async castCrisp() {
    if (this.liveClock !== null) clearTimeout(this.liveClock)
    this.liveClock = null
    this.resizing = false
    this.casting = true
    const mine = this.castGen + 1
    this.castGen = mine
    while (this.casting === true && this.castGen === mine) {
      const started = Date.now()
      /* Where the page is looking right now: a wheel turn moves the document
         under the window, and a clip that names the offset from before the turn
         captures a page nobody is looking at. */
      const box = await this.castBox()
      if (this.casting !== true || this.castGen !== mine) break
      const wide = box.width
      const tall = box.height
      const room = Math.min(
        CRISP_MAX,
        CRISP_ROOM / wide,
        CRISP_ROOM / tall,
        Math.sqrt(CRISP_PIXELS / (wide * tall)),
      )
      const scale = Math.max(1, Math.min(room, Number(this.castScale) || 1))
      const shot = await this.cdp
        .send('Page.captureScreenshot', {
          format: 'jpeg', // ui-copy-ignore
          quality: this.castQuality, // ui-copy-ignore
          fromSurface: true,
          /* The clip is the visible page at two image pixels per CSS pixel: the
             same box the cast would show, drawn at the column's own resolution,
             and named in document pixels so a scrolled page comes out right. */
          clip: { x: box.x, y: box.y, width: wide, height: tall, scale }, // ui-copy-ignore
        })
        .catch(() => null)
      if (this.casting !== true || this.castGen !== mine) break
      const data = String(shot?.data ?? '')
      if (data !== '' && this.frames.size > 0) {
        this.latest = data
        this.lastFrameAt = Date.now()
        /* The pane maps every click through this box, so it is the box the
           picture really shows, not the window it was asked for. */
        this.frameBox = { width: wide, height: tall }
        this.deliverFrame(data)
      }
      /* The pace is not a reason to keep the process up: a pane that stopped
         watching ends this loop, a test that drives the loop ends the test. */
      const pause = CRISP_GAP_MS - (Date.now() - started)
      if (pause > 0) {
        await new Promise((resolve) => {
          const tick = setTimeout(resolve, pause)
          tick.unref?.()
        })
      }
      if (this.frames.size === 0) break
    }
    if (this.castGen === mine) {
      this.casting = false
      this.castGen += 1
    }
  }

  /** Keep one listener that fans frames out to every viewer. */
  async start() {
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
        /* Every frame says how big the page it shows was, in device pixels. On
           a display that scales, that is not the size the page is laid out at:
           measured in device pixels the mirror is the wrong shape and every
           click is off by the scale. The frame only says when to ask, and the
           page answers in the pixels its own input is counted in. */
        const metaWidth = Math.round(Number(metadata?.deviceWidth))
        const metaHeight = Math.round(Number(metadata?.deviceHeight))
        /* A cast that had to scale a frame down to fit reports the size it
           scaled to, not the size of the page it shows. Taking that as the
           page would shrink the mirror and put the hand somewhere else, so a
           frame that only repeats the cast's own cap teaches nothing. */
        const echoedCap = metaWidth === Math.round(this.view.width) && metaHeight === Math.round(this.view.height)
        const shaped = Number.isFinite(metaWidth) && Number.isFinite(metaHeight)
        if (shaped && echoedCap !== true && (this.seenFrame === null || this.seenFrame.width !== metaWidth || this.seenFrame.height !== metaHeight)) {
          this.seenFrame = Number.isFinite(metaWidth) && Number.isFinite(metaHeight) ? { width: metaWidth, height: metaHeight } : null
          /* This frame was drawn at a size the page may no longer be laid out
             at, and the shape in its header is being re-measured right now.
             Showing it would put the picture and the hand in different shapes
             for a moment — the one moment a resize is most visible — so the
             measurement finishes first and a fresh picture goes out then. */
          this.resizing = true
          void this.remeasure(metaWidth, metaHeight)
            .catch(() => {})
            .then(() => {
              this.resizing = false
              void this.still()
            })
        }
        this.latest = data
        this.lastFrameAt = Date.now()
        this.castSeen += 1
        if (metadata?.timestamp !== undefined && metadata.timestamp * 1000 < this.touched - 60_000) return
        this.deliverFrame(data)
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
    /* The id is asked for now, once the target is listening, and collected in
       the same turn as the metrics: one round trip instead of two. */
    const identified = this.cdp
      .send('Target.getTargetInfo')
      .then((info) => {
        this.targetId = String(info?.targetInfo?.targetId ?? '')
      })
      .catch(() => {})
    const [, version] = await Promise.all([
      identified,
      this.cdp.send('Runtime.enable').then(() =>
        this.cdp.send('Emulation.setDeviceMetricsOverride', {
          width: this.view.width, // ui-copy-ignore
          height: this.view.height, // ui-copy-ignore
          deviceScaleFactor: this.paneDpr,
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
    /* The display scale turns a frame counted in device pixels back into the
       page it shows, and it is what keeps the cast capped in the pixels a
       scaled display really has. Measured here, once, so the first frame after
       a resize already has it; the layout measure refreshes it when it moves. */
    await this.cdp
      .send('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true })
      .then((answer) => {
        const scale = Number(answer?.result?.value)
        if (Number.isFinite(scale) && scale > 0) this.dpr = scale
      })
      .catch(() => {})
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
      this.castGen += 1
      await this.cdp.send('Page.stopScreencast').catch(() => {})
      this.casting = false
      await this.cast()
    } catch {
      /* a page that died mid-recast will be picked up by the next view */
    }
  }

  /**
   * The page changed size under a running cast. Frames are capped at the size
   * the cast was started with, so a page that grew comes back downsampled and
   * the pane shows a rescaled picture. Follow the size once the window stops
   * moving, instead of restarting the cast on every size in between.
   * @returns {void}
   */
  followSize() {
    if (this.sizeClock !== null) clearTimeout(this.sizeClock)
    this.sizeClock = setTimeout(() => {
      this.sizeClock = null
      if (this.casting !== true) return
      void this.recast(this.castQuality)
    }, 250)
    /* A pending restack is not a reason for the app to stay awake. */
    this.sizeClock.unref?.()
  }

  /** @returns {Promise<void>} resolves once the page is casting. */
  async cast() {
    this.resizing = false
    this.frameBox = null
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
    if (this.castScale > 1 || this.castLive === false) {
      void this.castCrisp()
      return
    }
    this.casting = true
    /* Full-resolution mirror at a quality that keeps small text readable;
       `optimizeForSpeed` keeps the encoder from adding to the round trip. The
       cap is in device pixels: on a display that scales, a cap given in page
       pixels makes the cast downscale a picture that was already the right
       size, and the pane shows a soft copy of a sharp page. */
    const scale = this.dpr > 0 ? this.dpr : 1
    const asked = {
      format: 'jpeg', // ui-copy-ignore
      quality: this.castQuality, // ui-copy-ignore
      maxWidth: Math.round(this.view.width * scale), // ui-copy-ignore
      maxHeight: Math.round(this.view.height * scale),
      optimizeForSpeed: true,
      everyNthFrame: 1,
    }
    const refused = await this.cdp.send('Page.startScreencast', asked).then(
      () => null,
      (error) => error,
    )
    if (refused !== null) {
      /* A stop that failed earlier leaves Chrome's own cast running while the
         bookkeeping here says it stopped, and this start is refused as
         "already active". Giving up then leaves the pane quiet with a cast
         still encoding frames nobody reads, so stop it and start once more. */
      if (/already active/i.test(String(refused?.message ?? refused)) === true) {
        await this.cdp.send('Page.stopScreencast').catch(() => {})
        await this.cdp.send('Page.startScreencast', asked).catch(() => {
          this.casting = false
        })
      } else {
        this.casting = false
      }
    }
    /* A screencast that accepted the request and then sent nothing is not an
       idle page, it is a dead cast: the pane would hold one picture until the
       next interaction. One frame is owed at once even when nothing repaints,
       so silence here means the screencast never came up, and the paced
       capture path below knows how to draw the same picture without it. */
    this.castSeen = 0
    const live = this.castGen
    if (this.liveClock !== null) clearTimeout(this.liveClock)
    this.liveClock = setTimeout(() => {
      this.liveClock = null
      if (this.castGen !== live) return
      void this.liveDead()
    }, 900)
    this.liveClock.unref?.()
    void this.still()
  }

  /**
   * The screencast accepted the start and never delivered a frame, so stop
   * trusting it for this page and draw frames with the same paced capture the
   * sharp path uses.
   * @returns {Promise<boolean>} whether the live cast was found dead.
   */
  async liveDead() {
    if (this.casting !== true) return false
    if (this.castScale > 1) return false
    /* Nobody is looking: a capture loop would burn the CPU to paint a picture
       no pane holds. The fallback is for a cast that has an audience. */
    if (this.frames.size === 0) return false
    /* Frames left over from the cast before this one still land in the first
       moments, so "one frame arrived" is not proof of a live screencast: what
       counts is a frame that arrived while this cast was the current one. */
    if (Date.now() - this.lastFrameAt < 700) return false
    this.casting = false
    this.castGen += 1
    this.castLive = false
    if (this.flashBridge === null) await this.cdp.send('Page.stopScreencast').catch(() => {})
    void this.castCrisp()
    return true
  }

  /**
   * The size the page is really laid out at, as the browser itself reports it.
   * A real window on a scaled display can keep its own size instead of the one
   * that was asked for, and then both the picture and the pointer are measured
   * against a shape the page never had. The report wins over the request.
   * @returns {Promise<void>} leaves `view` alone when the report is unusable.
   */
  /**
   * A frame announced a new size: ask the page for the size it is laid out at.
   * A screencast counts its frame in device pixels while the page counts in
   * CSS pixels, and on a scaled display those differ by exactly that scale.
   * The frame's own numbers are only used when the page cannot answer, so a
   * window that keeps its own size is still followed.
   * @param {number} deviceWidth - device pixels the frame announced.
   * @param {number} deviceHeight - device pixels the frame announced.
   * @returns {Promise<void>} settles the size and the cast that follows it.
   */
  async remeasure(deviceWidth, deviceHeight) {
    if (this.cdp === null || this.cdp === undefined) {
      if (this.tookSize(deviceWidth, deviceHeight)) this.followSize()
      return
    }
    /* The viewport the hand counts in is the window's, scrollbar and all: a
       layout viewport that leaves the scrollbar out would put the last column
       of pixels out of reach. */
    const answered = await this.cdp
      .send('Runtime.evaluate', { expression: '[window.innerWidth, window.innerHeight, window.devicePixelRatio]', returnByValue: true })
      .catch(() => null)
    const told = answered === null || answered === undefined ? null : answered.result
    const pair = told === null || told === undefined ? null : told.value
    let width = Array.isArray(pair) === true ? Number(pair[0]) : NaN
    let height = Array.isArray(pair) === true ? Number(pair[1]) : NaN
    const scale = Array.isArray(pair) === true ? Number(pair[2]) : NaN
    if (Number.isFinite(scale) && scale > 0) this.dpr = scale
    if (!(Number.isFinite(width) && Number.isFinite(height) && width >= 200 && height >= 200)) {
      const metrics = await this.cdp.send('Page.getLayoutMetrics').catch(() => null)
      const css = metrics === null || metrics === undefined ? null : metrics.cssLayoutViewport
      width = Number(css === null || css === undefined ? NaN : css.clientWidth)
      height = Number(css === null || css === undefined ? NaN : css.clientHeight)
    }
    const known = Number.isFinite(width) && Number.isFinite(height) && width >= 200 && height >= 200
    if (this.tookSize(known ? width : deviceWidth, known ? height : deviceHeight)) this.followSize()
  }

  /**
   * Believe the size the page reports over the size anyone asked for.
   * A window keeps its own size, a display scale changes it, and a request the
   * browser refuses leaves the asked-for number behind: in every one of those
   * cases the only usable size is the one the browser says it laid out at.
   * @param {number} width - CSS pixels the browser reports.
   * @param {number} height - CSS pixels the browser reports.
   * @returns {boolean} Whether this changed the size the page is known by.
   */
  tookSize(width, height) {
    const w = Math.round(Number(width))
    const h = Math.round(Number(height))
    /* A window can be wider than the mirror's own picture: a 4K display at
       100% zoom lays a page out at 3840 CSS pixels, and a screencast is
       capped in pixels, not in the page's own coordinates. */
    if (!(w >= 200) || !(h >= 200) || w > 8192 || h > 8192) return false
    if (w === this.view.width && h === this.view.height) return false
    this.view = { width: w, height: h }
    return true
  }

  async laidOut() {
    if (this.cdp === null || this.cdp === undefined) return
    /* The window, scrollbar and all. `cssLayoutViewport.clientWidth` leaves the
       scrollbar out: on a page long enough to have one, believing it makes the
       page 15 CSS pixels narrower than the pane, and every frame then arrives
       narrow, is letterboxed into the pane, and the last 15 pixels of the page
       — the scrollbar itself — never reach the mirror. */
    const answered = await this.cdp
      .send('Runtime.evaluate', {
        expression: '[window.innerWidth, window.innerHeight]',
        returnByValue: true,
      })
      .catch(() => null)
    const pair = answered?.result?.value
    const width = Array.isArray(pair) === true ? Number(pair[0]) : NaN
    const height = Array.isArray(pair) === true ? Number(pair[1]) : NaN
    if (Number.isFinite(width) && Number.isFinite(height) && width >= 200 && height >= 200) {
      this.tookSize(width, height)
      return
    }
    const metrics = await this.cdp.send('Page.getLayoutMetrics').catch(() => null)
    const css = metrics === null || metrics === undefined ? null : metrics.cssLayoutViewport
    this.tookSize(
      css === null || css === undefined ? 0 : css.clientWidth,
      css === null || css === undefined ? 0 : css.clientHeight,
    )
  }

  /**
   * How many device pixels to render each CSS pixel at for the pane.
   *
   * One: a scaled mirror is bought with a pointer that lands somewhere else.
   * Measured on this machine's Chrome with the pane at 1000x800 on a 2x
   * display: the page laid out at 1000x800 with deviceScaleFactor 2, then a
   * point sent as CSS (400,320) was reported by the page as (200,160) — divided
   * by the scale — across six consecutive moves. At 1.25x and 1.5x the same
   * division happens to every point. A build that reads a dispatched point in
   * device pixels cannot be told from one that reads CSS pixels without asking
   * the page, and a pane that guesses wrong puts the click on the wrong element.
   * The page therefore renders at the pane's CSS size, one image pixel per CSS
   * pixel, which is what every point already assumes.
   * @returns {number} device pixels per CSS pixel, always 1.
   */
  mirrorScale() {
    return 1
  }

  /**
   * The unit a dispatched mouse point is read in, as a multiplier over the CSS
   * pixel the pane sends: always one, because the mirror never applies a device
   * scale that would make a point mean device pixels.
   * @returns {number} 1.
   */
  handScale() {
    return 1
  }

  /**
   * The column changed size: lay the page out at that size so the picture fills
   * the frame instead of sitting letterboxed inside it.
   * @param {number} width - CSS pixels of the frame. @param {number} height - CSS pixels of the frame.
   */
  async setViewport(width, height, dpr = 1) {
    const w = Math.round(Number(width))
    const h = Math.round(Number(height))
    /* A narrow column with a long page is still a browser: refusing its size
       leaves the picture letterboxed in the pane, which is what makes a mirror
       look like it does not fill the column. */
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200) return this.view
    /* A column wider than the widest screen a browser is drawn on - a window
       across two displays, a five-K panel in the wide setting - used to be
       dropped, which left the pane showing the shape of the size before it.
       It is clamped to what the browser can lay out instead. */
    const wide = Math.min(w, MAX_VIEW)
    const tall = Math.min(h, MAX_VIEW)
    /* A scaled display draws the column in more device pixels than the page has
       CSS pixels: rendering at that scale is what keeps the mirror crisp. A new
       scale is a change even when the size is the same, because the page is
       still drawing at the old one. */
    const looked = this.mirrorScale(wide, Number(dpr))
    /* The page is laid out at one CSS pixel per image pixel, so the picture is
       captured at that size and then enlarged again for a scaled column: a
       device scale in the metrics is what used to move every click. */
    const asked = Number(dpr)
    const crisp = Number.isFinite(asked) && asked > 1 ? Math.min(CRISP_MAX, asked) : 1
    const rescaled = looked !== this.appliedScale || crisp !== this.castScale
    this.paneDpr = looked
    this.castScale = crisp
    if (wide === this.view.width && tall === this.view.height && rescaled !== true) return this.view
    this.view = { width: wide, height: tall }
    this.touched = Date.now()
    if (this.flashBridge !== null) {
      /* The picture is the game, not the window: the Flash runtime frames its
         window on the box the game occupies and replies with that shape, so the
         frame - and everything that maps onto it - follows the reply. */
      const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/resize?w=${wide}&h=${tall}`)
        .then((answer) => (answer.ok === true ? answer.json() : null))
        .catch(() => null)
      const bounds = reply === null || reply === undefined ? null : reply.bounds
      if (bounds !== null && bounds !== undefined && Number(bounds.width) >= 200 && Number(bounds.height) >= 200) {
        this.view = { width: Math.round(Number(bounds.width)), height: Math.round(Number(bounds.height)) }
      }
      return this.view
    }
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: wide,
      height: tall,
      deviceScaleFactor: this.paneDpr,
      mobile: false, // ui-copy-ignore
    }).catch(() => {})
    /* The answer to the override is the browser's, not ours: ask where the
       page actually landed. A window that keeps its own size on a scaled
       display would otherwise leave the mirror the wrong shape and the pointer
       off the mark for every click. */
    this.appliedScale = this.paneDpr
    await this.laidOut()
    /* The page draws at one image pixel per CSS pixel, so the cast that
       follows is asked for exactly that. */
    this.dpr = this.paneDpr
    if (this.casting === true) {
      /* A scale change can swap the loop underneath the cast. The one that was
         running only checks `casting`, so without this the old loop wakes up
         after the restart, sees a cast still running and takes the surface back
         - the pane then gets one picture and then nothing. */
      this.castGen += 1
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

  /**
   * Tells every pane watching this tab that the browser took it away: the pane
   * keeps its last picture, so without the note it looks like a page that
   * stopped taking clicks.
   * @returns {void}
   */
  markGone() {
    const note = { type: 'gone' } // ui-copy-ignore
    for (const sink of this.frames ?? []) {
      try {
        sink(note)
      } catch {
        /* a viewer that already closed takes no note */
      }
    }
  }

  /** Feeds one picture to every viewer of this browser. @param {string} data - base64 JPEG. */
  publish(data) {
    if (data === '' || this.frames.size === 0) return
    this.latest = data
    if (this.staleFrame(data) === true) return
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
      target: this.targetId, // ui-copy-ignore
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
    while (this.casting === true && this.stopped !== true) {
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

  /**
   * Parks a page nobody is driving: timers and fetch callbacks stop, while the
   * DOM, the scroll position, the cookies and the CDP session stay. Freezing is
   * reversible in place, so bringing it back costs a protocol call rather than
   * a launch and a sign-in. Chrome's own docs define the two states.
   * @returns {Promise<void>} done, even on a page that cannot be frozen.
   */
  /**
   * What a parked page gives back: the heap it grew while it was being read,
   * and the decoded images and back/forward caches the renderer keeps for a
   * page a person may look at again. Frozen pages cannot run the collector, so
   * this happens before the freeze — the DOM, the scroll position and the
   * cookies are untouched, which is the whole point of parking instead of
   * closing.
   * @returns {Promise<void>} done, even on a renderer that refuses.
   */
  async shed() {
    await this.cdp.send('Runtime.evaluate', {
      expression: 'globalThis.gc?.()', silent: true, returnByValue: true,
    }).catch(() => {})
    await this.cdp.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {})
  }

  async freeze() {
    if (this.frozen === true) return
    /* The page the right column is showing is not idle: freezing it is what
       made the first click after a pause disappear. Parking is for the tabs
       behind it, not for the one on screen. */
    if ((this.frames?.size ?? 0) > 0) return
    try {
      await this.shed()
      await this.cdp.send('Page.setWebLifecycleState', { state: 'frozen' })
      this.frozen = true
      this.casting = false
    } catch {
      /* A page between navigations refuses; it is not a reason to fail a call. */
    }
  }

  /** @returns {Promise<void>} done, with the page running again. */
  async thaw() {
    if (this.frozen !== true) return
    this.frozen = false
    try {
      await this.cdp.send('Page.setWebLifecycleState', { state: 'active' })
    } catch {
      /* Already gone: the next call finds a dead page and replaces it. */
    }
  }

  /**
   * A person's first click after a nap. A frozen page drops every input event
   * the protocol sends it, and a Flash page's mirror loop stopped with it, so
   * both have to be brought back before the click can land anywhere.
   * @returns {Promise<void>} done, with the page listening again.
   */
  async revive() {
    if (this.frozen !== true) return
    await this.thaw()
    /* A wake is a fresh start for the picture and for input: the window may be
       answering again, and one post is cheap next to guessing wrongly. */
    this.flashInputFails = 0
    this.flashInputPausedUntil = 0
    this.flashButtons = 0
    if (this.flashBridge !== null && this.casting !== true) {
      this.casting = true
      void this.pollBridge()
    }
  }

  /**
   * Turn the game's sound on or off without restarting it.
   * @param {boolean} on - true for audible.
   * @returns {Promise<boolean>} true when the window took the setting.
   */
  async sound(on) {
    if (this.flashBridge === null) return false
    try {
      const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/sound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: on === true }),
        signal: AbortSignal.timeout(1200),
      })
      if (reply.ok !== true) return false
      this.soundOn = on === true
      return true
    } catch {
      return false
    }
  }

  async stopCast() {
    if (this.sizeClock !== null) clearTimeout(this.sizeClock)
    this.sizeClock = null
    if (this.liveClock !== null) clearTimeout(this.liveClock)
    this.liveClock = null
    /* A fresh attach is a fresh chance for the screencast: the page may have
       been navigated since, and the capture path is the fallback, not the
       preference. */
    this.castLive = true
    this.casting = false
    this.frameBox = null
    this.castGen += 1
    /* The bookkeeping is not proof of what Chrome is doing: a start refused as
       "already active" left `casting` false over a cast that was still
       encoding frames for a pane nobody watches. Stopping is idempotent, so the
       stop goes out either way rather than trusting the flag. */
    if (this.flashBridge === null && this.cdp !== null && this.cdp !== undefined) {
      await this.cdp.send('Page.stopScreencast').catch(() => {})
    }
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
  /**
   * Wait until the pictures on the page stop changing.
   *
   * A canvas paints without the DOM changing, so "idle" never arrives. The page
   * can fingerprint its own pixels, but a surface that took its content from
   * another site refuses to be read from inside, and that silence looked
   * exactly like a still picture: this used to answer "settled" while a chart
   * was animating. The screen still shows what such a surface holds, so those
   * are fingerprinted from the screen instead of being trusted.
   *
   * @param {number} timeout - how long to watch, in milliseconds.
   * @returns {Promise<{settled: boolean, surfaces: number, fromScreen: number, ms: number}>} what happened.
   */
  async pictureSettled(timeout) {
    const probe = `(() => {
      const seen = []
      const blind = []
      const walk = (doc) => {
        for (const one of doc.querySelectorAll('canvas, video')) {
          try {
            const w = Math.round(one.width || one.clientWidth || 0)
            const h = Math.round(one.height || one.clientHeight || 0)
            let sig = 0
            if (one.tagName === 'CANVAS') {
              const board = document.createElement('canvas')
              board.width = 16
              board.height = 16
              const ctx = board.getContext('2d')
              ctx.drawImage(one, 0, 0, 16, 16)
              const px = ctx.getImageData(0, 0, 16, 16).data
              for (let i = 0; i < px.length; i += 4) sig = (sig * 31 + px[i] + px[i + 1] * 3 + px[i + 2] * 7) % 1000003
            } else sig = Math.round(Number(one.currentTime || 0) * 10)
            seen.push(w + 'x' + h + ':' + sig)
          } catch (error) {
            const box = one.getBoundingClientRect()
            if (box.width >= 8 && box.height >= 8) {
              const view = doc.defaultView
              blind.push([Math.round(box.left + (view ? view.scrollX : 0)), Math.round(box.top + (view ? view.scrollY : 0)), Math.round(box.width), Math.round(box.height)])
            } else seen.push('unreadable')
          }
        }
        for (const frame of doc.querySelectorAll('iframe')) {
          try { if (frame.contentDocument) walk(frame.contentDocument) } catch (error) { /* another origin */ }
        }
      }
      walk(document)
      return JSON.stringify({ seen: seen, blind: blind })
    })()`
    const started = Date.now()
    /* A surface that toggles can look still for one sample: a picture counts as
       settled only after it held the same fingerprint for a quarter of a second,
       sampled often enough to see a flicker of a tenth of a second. */
    const SAMPLE_MS = 150
    const QUIET_MS = 400
    let last = ''
    let since = started
    let surfaces = 0
    let fromScreen = 0
    while (Date.now() - started < timeout) {
      let said = { seen: [], blind: [] }
      try {
        const answer = await this.cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true })
        said = JSON.parse(String(answer.result?.value ?? '{}'))
      } catch (error) { /* a page mid-navigation has nothing to fingerprint */ }
      const parts = Array.isArray(said.seen) ? said.seen.map(String) : []
      const blind = Array.isArray(said.blind) ? said.blind : []
      fromScreen = blind.length
      for (const box of blind.slice(0, 3)) {
        try {
          const shot = await this.cdp.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 55,
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: box[0], y: box[1], width: box[2], height: box[3], scale: 0.3 },
          })
          parts.push('screen:' + createHash('sha1').update(String(shot.data ?? '')).digest('hex'))
        } catch (error) { parts.push('screen:?') }
      }
      surfaces = parts.length
      /* Nothing to watch: saying "kept changing" for the whole timeout made a
         page without pictures look busy. */
      if (surfaces === 0) return { settled: true, surfaces: 0, fromScreen: 0, ms: Date.now() - started }
      const now = parts.join('|')
      if (now !== last) {
        last = now
        since = Date.now()
      } else if (Date.now() - since >= QUIET_MS) {
        return { settled: true, surfaces, fromScreen, ms: Date.now() - started }
      }
      await wait(SAMPLE_MS)
    }
    return { settled: false, surfaces, fromScreen, ms: Date.now() - started }
  }

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
    const started = Date.now()
    let took = false
    await Promise.race([
      this.cdp.send(method, params).then(() => {
        took = true
      }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ])
    this.inputMs = Date.now() - started
    if (took === true) {
      this.inputFails = 0
      this.inputFault = ''
    } else {
      this.inputFails += 1
      this.inputFault = String(method)
    }
    return took
  }

  /**
   * The buttons a hover is dragging with: what the last press left down, or
   * the left one when the pane says a press is still in flight.
   *
   * @param {{pressed?: boolean}} point - the point, as the pane sent it.
   * @returns {number} the browser's button mask.
   */
  dragMask(point) {
    if (this.buttons !== 0) return this.buttons
    if (point?.pressed !== true) return 0
    /* The mask names the button the hand holds: a right drag that said left
       would drag a selection across the page instead of the thing under it. */
    return point?.button === 'right' ? 2 : point?.button === 'middle' ? 4 : 1
  }

  async hover(point) {
    await this.revive()
    /* A hand with the button down is dragging, not hovering: every move must
       say so, or the page reads the press as a click that ended instantly. */
    const drag = this.dragMask(point)
    const held = drag !== 0
    if (this.flashBridge !== null) {
      this.flashButtons = held ? 1 : 0
      if ((await this.flashInput('mouseMove', point)) === true) return this.cursorAt(point)
    }
    await this.input('Input.dispatchMouseEvent', {
      type: 'mouseMoved', // ui-copy-ignore
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: held ? (this.heldButton === 'none' ? (point?.button ?? 'left') : this.heldButton) : 'none', // ui-copy-ignore
      buttons: drag, // ui-copy-ignore
      clickCount: 0,
      modifiers: point?.modifiers ?? 0, // ui-copy-ignore
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
  /**
   * One POST to the Flash window's input bridge, with a breaker.
   * @param {object} payload - one event, as `flash-input.cjs` shapes it.
   * @returns {Promise<boolean>} true when the window answered `ok`.
   */
  async flashPost(payload) {
    if (this.flashBridge === null) return false
    if (Date.now() < this.flashInputPausedUntil) return false
    const started = Date.now()
    try {
      const reply = await fetch(`http://127.0.0.1:${this.flashBridge}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(INPUT_TIMEOUT_MS),
      })
      const said = await reply.json().catch(() => null)
      if (said?.ok !== true) throw new Error('silent')
      this.inputMs = Date.now() - started
      this.flashInputFails = 0
      return true
    } catch {
      this.inputMs = Date.now() - started
      this.flashInputFails += 1
      if (this.flashInputFails >= 2) {
        this.flashInputFails = 0
        this.flashInputPausedUntil = Date.now() + INPUT_REST_MS
      }
      return false
    }
  }

  /**
   * Hands one mouse event to the Flash window directly, skipping the debugging
   * protocol on the way in.
   * @param {string} kind - mouseDown, mouseUp or mouseMove.
   * @param {{x: number, y: number, button?: string, clickCount?: number}} point - CSS pixels.
   * @returns {Promise<boolean>} true when the window took it.
   */
  async flashInput(kind, point) {
    const last = this.lastFlashPoint
    if (kind === 'mouseDown' && (last === null || Math.abs(last.x - point.x) > 1 || Math.abs(last.y - point.y) > 1)) {
      await this.flashInput('mouseMove', point)
    }
    const wheel = kind === 'mouseWheel'
    /* The point is already in the page's own pixels: the window takes them as
       they are, and scaling them here is what used to put every press at twice
       its distance from the corner. */
    const payload = wheel
      ? { type: kind, x: Math.round(point.x), y: Math.round(point.y), deltaX: Math.round(point.dx ?? 0), deltaY: Math.round(point.dy ?? 0) }
      : { type: kind, x: Math.round(point.x), y: Math.round(point.y), button: point.button ?? 'left', buttons: this.flashButtons, clickCount: point.clickCount ?? (kind === 'mouseMove' ? 0 : 1) }
    if ((await this.flashPost(payload)) !== true) return false
    if (!wheel) this.lastFlashPoint = { x: Math.round(point.x), y: Math.round(point.y) }
    return true
  }

  async mouse(type, point) {
    await this.revive()
    this.movePointer(point)
    const flashKind = type === 'mousePressed' ? 'mouseDown' : type === 'mouseReleased' ? 'mouseUp' : 'mouseMove'
    if (this.flashBridge !== null && (await this.flashInput(flashKind, point)) === true) {
      /* A window needs the held button on every move to see a drag: without it
         the page gets a pointer that is down and then not, one pixel later. */
      this.flashButtons = flashKind === 'mouseDown' ? 1 : flashKind === 'mouseUp' ? 0 : this.flashButtons
      return true
    }
    const button = point.button ?? 'left'
    /* The browser's mask: left is 1, right is 2, middle is 4. A page reads the
       mask to know which button a drag or a menu is holding. */
    const bit = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    const held = type === 'mousePressed' ? bit : type === 'mouseReleased' ? 0 : this.buttons
    /* A move in the middle of a drag names the button that is down: the browser
       starts a selection from a move that says left is held, not from the count
       alone. Outside a drag there is no button to name. */
    const named = type === 'mouseMoved' ? (this.buttons === 0 ? 'none' : this.heldButton) : button
    /* A protocol event, not a screen: the keys below are the browser's names. */
    const hand = this.handScale()
    const took = await this.input('Input.dispatchMouseEvent', { // ui-copy-ignore
      type, // ui-copy-ignore
      x: point.x * hand, // ui-copy-ignore
      y: point.y * hand, // ui-copy-ignore
      button: named, // ui-copy-ignore
      buttons: held, // ui-copy-ignore
      clickCount: point.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
      /* The keys the hand holds, in the browser's own bits: alt 1, ctrl 2,
         meta 4, shift 8. A page reads them from every mouse event. */
      modifiers: point.modifiers ?? 0, // ui-copy-ignore
      pointerType: 'mouse',
    })
    /* The held button is remembered between events, so a move in the middle of
       a drag is dispatched with it even when the pane did not say so. */
    if (took === true) {
      this.buttons = held
      this.heldButton = held === 0 ? 'none' : button
    }
    return took
  }

  /**
   * @param {{x: number, y: number, dx?: number, dy?: number}} args - wheel over a point.
   * @returns {Promise<void>} resolves when Chrome took it.
   */
  async wheel(args) {
    await this.revive()
    this.movePointer(args)
    if (this.flashBridge !== null && (await this.flashInput('mouseWheel', args)) === true) return true
    /* A wheel turned while the button is down is still a drag: the page reads
       the held button off every event it gets, and a wheel that says no button
       is down cancels the drag the hand never let go of. */
    const hand = this.handScale()
    return await this.input('Input.dispatchMouseEvent', {
      type: 'mouseWheel', // ui-copy-ignore
      x: args.x * hand, // ui-copy-ignore
      y: args.y * hand, // ui-copy-ignore
      deltaX: args.dx ?? 0, // ui-copy-ignore
      deltaY: args.dy ?? 0, // ui-copy-ignore
      button: 'none', // ui-copy-ignore
      buttons: this.buttons, // ui-copy-ignore
      modifiers: args.modifiers ?? 0, // ui-copy-ignore
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
    await this.revive()
    /* The shape of a keystroke is decided in flash-input.cjs, where it is
       tested: a named key spelled the way a page spells it (`ArrowUp`) is not a
       key code the window knows, and used to arrive as an empty key. */
    const events = flashInputPlanner.keyEvents({ type, key: key?.key, text: key?.text, modifiers: key?.modifiers })
    if (events.length === 0) return false
    for (const event of events) {
      if ((await this.flashPost(event)) !== true) return false
    }
    return true
  }

  async key(type, key) {
    await this.revive()
    this.touched = Date.now()
    if (this.flashBridge !== null && (await this.flashKey(type, key)) === true) return true
    const virtual = key.keyCode ?? key.windowsVirtualKeyCode ?? 0
    return await this.input('Input.dispatchKeyEvent', {
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
          const spec = charSpec(one)
          /* A character no key can make (Chinese, an emoji) arrives as an
             input-method commit: inventing a keycode for it would be a lie. */
          if (spec === null) {
            await this.input('Input.insertText', { text: one }).catch(() => {})
            continue
          }
          /* The shape a keyboard has: the down event carries the key's own code
             and its text, the up event carries the code and no text. A page
             that pairs the two — a remote desktop, a game, an editor with its
             own keymap — sees nothing when the up half is missing, however
             many downs arrive. */
          const base = {
            key: spec.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.keyCode,
            nativeVirtualKeyCode: spec.keyCode,
            modifiers: spec.modifiers,
          }
          await this.input('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: one, unmodifiedText: one }).catch(() => {})
          await this.input('Input.dispatchKeyEvent', { type: 'keyUp', ...base, text: undefined, unmodifiedText: undefined }).catch(() => {})
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
    return await this.input('Input.insertText', { text })
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
    const asked = Number(options.scale ?? 1)
    const hand = Number.isFinite(asked) && asked > 0 ? Math.max(0.1, Math.min(4, asked)) : 1
    /** @param {number} scale - the clip scale to try. @returns {Promise<{data: string, size: {width: number, height: number}|null}>} the capture and its real pixels. */
    const once = async (scale) => {
      /** @type {any} */
      const args = { format: 'png' }
      if (options.rect) {
        args.clip = { ...options.rect, scale }
        args.captureBeyondViewport = options.full === true
      } else if (options.full === true) {
        const { result } = await this.cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({w: Math.max(document.documentElement.scrollWidth, innerWidth), h: Math.max(document.documentElement.scrollHeight, innerHeight)})',
          returnByValue: true,
        })
        const size = JSON.parse(String(result?.value ?? '{"w":1440,"h":900}'))
        args.clip = { x: 0, y: 0, width: Math.min(size.w, 8000), height: Math.min(size.h, 20000), scale }
        args.captureBeyondViewport = true
      }
      const { data } = await this.cdp.send('Page.captureScreenshot', args)
      const body = String(data ?? '')
      return { data: body, size: pngSize(body) }
    }
    const rect = options.rect ?? null
    const wantWidth = rect === null ? 0 : Math.max(1, Math.round(Number(rect.width) * hand))
    const wantHeight = rect === null ? 0 : Math.max(1, Math.round(Number(rect.height) * hand))
    let got = await once(hand)
    /* The pixels a clip comes back with are not the CSS pixels it was asked
       for: a page zoom or a device ratio multiplies them, and a caller that
       crops the file against its own numbers then marks the wrong box. The
       file says how many pixels it holds, so ask it, and when the answer is a
       different scale, spend one more capture at the scale the page really
       rendered. */
    if (wantWidth > 0 && got.size !== null && Math.abs(got.size.width - wantWidth) > 1) {
      const real = (got.size.width / wantWidth) * hand
      if (real > 0.05 && real < 8 && Math.abs(real - hand) > 0.01) got = await once(real)
    }
    return {
      data: got.data,
      width: got.size === null ? 0 : got.size.width,
      height: got.size === null ? 0 : got.size.height,
      scale: hand,
      asked: { width: wantWidth, height: wantHeight },
    }
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
    /* Non-zero while this sidecar is asking the browser for a tab of its own. */
    this.making = 0
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
    /* Whether the game window is audible: the launch flag decides the start,
       the sound button changes it while the page runs. */
    this.soundOn = /^(1|true|yes|on)$/i.test(String(process.env.DSH_FLASH_SOUND ?? '').trim())
    /* Whether the launched runtime really carries the plugin, asked once at
       launch: null means it has not been asked. */
    this.flashCheck = null
    /* The Flash app serves its own frames; the screencast cannot see a plugin. */
    this.flashBridge = null
    /* A rest taken because the window stopped answering is not carried into
       the next launch: a browser that starts clean is given a clean chance. */
    this.flashInputFails = 0
    this.flashInputPausedUntil = 0
    this.flashButtons = 0
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
    /* The person asked for the page from the column and keeps it until they
       hand it back: a touch costs the agent a few seconds, this costs it the
       page, so the pane says so and the tools refuse to act until it ends. */
    this.held = false
    /* When the browser was last asked for anything, and the rhythm of those
       asks: the two numbers that decide when a pause has become a departure. */
    this.use = new GapClock()
    this.useAt = 0
    /* The moment this browser may be put down, or 0 while it has no clock. */
    this.restAt = 0
    /* The lifecycle beat, and what it last found. */
    this.beat = null
    this.resting = false
    this.memMb = 0
    this.memAt = 0
    this.pressure = 'ok'
    this.budgetMb = Math.max(200, Number(options.budgetMb ?? BUDGET_MB) || BUDGET_MB)
    /* A window this browser is never given less than, or more than: a test can
       shrink both, and a chat that works in fast steps still gets grace. */
    this.restFloor = Math.max(1000, Number(options.restFloor ?? MIN_REST_MS) || MIN_REST_MS)
    this.restCeiling = Math.max(this.restFloor, Number(options.restCeiling ?? MAX_REST_MS) || MAX_REST_MS)
    /* How often it has been put down and brought back, and how long the last
       wake took: a rest that costs more than it saves is a bug worth seeing. */
    this.rests = 0
    this.sleptAt = 0
    this.wakeMs = 0
    /* Restarts inside a window: three in ten minutes is a browser that is
       broken, not a browser that was needed. */
    this.crashes = []
    this.restartWindow = Math.max(10_000, Number(options.restartWindow ?? 10 * 60_000) || 10 * 60_000)
    /* The shutdown in flight, if any: a launch that starts while the last
       browser is still being put away would have its fresh socket closed by
       the one going out. */
    this.closing = null
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
    /* The person's own hold has no countdown: it ends when they say so. */
    if (this.held === true) return this.holdMs
    if (this.person === undefined || this.person.at === 0) return 0
    const left = this.holdMs - (Date.now() - this.person.at)
    return left > 0 ? left : 0
  }

  /** @returns {boolean} whether the person is holding the page. */
  get taken() {
    return this.held === true
  }

  /**
   * The person took the page from the column: every action waits for them,
   * without a countdown, until they hand it back.
   */
  takeOver() {
    this.held = true
    this.person = { at: Date.now(), kind: 'takeover', x: 0, y: 0, seen: false } // ui-copy-ignore
  }

  /** Take the page back now, without waiting out the hold. */
  release() {
    this.held = false
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
      /* A parked page is still the chat's page: waking it costs a protocol call,
         and a tool that read without waking it would see a page that never runs
         its scripts again. */
      await had.thaw?.()
      if (url !== undefined && url !== '') await had.navigate(url)
      return had
    }
    /* Two calls that start together are one chat, and a chat has one tab: the
       second waits for the first tab instead of opening a twin nobody holds. */
    const underway = this.opening?.get(id)
    if (underway !== undefined) {
      const page = await underway
      await page.thaw?.()
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
    /* A tab a chat claimed is a tab that chat holds, even when the mirror is on
       another one: pruning it would take away the tab a cross-tab read needs. */
    for (const set of this.claims.values()) {
      for (const id of set) owned.add(String(id))
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
      /* The chat that owns this tab is told it went away, the same way a reaped
         idle tab tells it: without the note the pane keeps showing its last
         frame and looks like a page that stopped taking clicks. */
      ;(this.expired ??= new Map()).set(String(row.id), Date.now())
      try {
        row.page.markGone()
      } catch {
        /* a tab with no pane needs no note */
      }
      await row.page.stopCast().catch(() => {})
      await fetch(`http://127.0.0.1:${String(row.port)}/json/close/${row.target}`, { signal: AbortSignal.timeout(800) }).catch(() => {}) // ui-copy-ignore
    }
    if (over > 0) this.note('closed tabs over the cap — their addresses are kept')
  }

  /**
   * Close tabs nobody is watching that have sat untouched past the idle window.
   * The cap alone keeps at most six around; this keeps the working set near the
   * chats actually in use, which is what the memory number follows.
   * @returns {Promise<void>} done.
   */
  /**
   * Closes tabs nobody watches, keeping their address for the chat.
   * @param {boolean} [all] - close them whatever their age, for memory pressure.
   */
  async reapIdleTabs(all = false) {
    const now = Date.now()
    if (now - Number(this.reapedAt ?? 0) < 60_000 && all !== true) return
    this.reapedAt = now
    for (const [id, page] of this.pages) {
      const target = String(page.targetId ?? '')
      if ((page.frames?.size ?? 0) !== 0 || target === '' || page.port === 0) continue
      if (page === this.page) continue
      if (all !== true && now - Number(page.touched ?? 0) < TAB_IDLE_MS) continue
      this.pages.delete(id)
      /* The column is told the tab is gone, so a chat coming back to the front
         does not re-expand a pane for a page that already went away. */
      ;(this.expired ??= new Map()).set(String(id), Date.now())
      try {
        page.markGone()
      } catch {
        /* a tab with no pane needs no note */
      }
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
      /* A parked page is still the chat's page: waking it costs a protocol call,
         and a tool that read without waking it would see a page that never runs
         its scripts again. */
      await had.thaw?.()
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
    /* A tab opened here is not a popup a click opened: the follow armed by the
       last snapshot would otherwise adopt this tab and close it while the
       first CDP call was still on its way. */
    this.page?.disarmFollow?.()
    /* A warm tab is a third of the price of a cold start, so where it goes is
       worth a line of its own under the same switch as the start trace. */
    const trace = process.env.DSH_INNER_BROWSER_TRACE === '1'
    const t0 = Date.now()
    const marks = []
    const mark = (name) => {
      if (trace) marks.push(`${name} ${Date.now() - t0}`)
    }
    mark('pre')
    this.making += 1
    let created
    let target
    try {
      created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(address)}`, { method: 'PUT', signal: AbortSignal.timeout(3000) }) // ui-copy-ignore
      if (!created.ok) throw new Error('sidecar: could not open a tab')
      target = await created.json()
    } finally {
      this.making -= 1
    }
    mark('http')
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('sidecar: new tab has no socket')
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.ready
    mark('ws')
    const page = await this.bind(await new SidecarPage(cdp, this.profile, port, () => this.holding()).start()) // ui-copy-ignore
    mark('start')
    if (trace) console.error(`trace:tab ${marks.join(' ')}`)
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
      /* A page parked while nobody watched has to be running before it can be
         driven; this is the whole point of freezing rather than closing it. */
      if (mine.frozen === true) await mine.thaw()
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

  /**
   * Records a browser that stopped working, and reports whether it has stopped
   * working so often that starting it again would only produce another crash
   * on the person's screen. Three in ten minutes is a broken browser, not a
   * browser the chat needed; saying so once is more useful than a loop.
   * @returns {boolean} true when it is time to stop trying automatically.
   */
  died() {
    const now = Date.now()
    this.crashes = [...this.crashes.filter((at) => now - Number(at) < this.restartWindow), now]
    return this.crashes.length > 3
  }

  /** @returns {Error} the error a chat sees instead of a fourth doomed launch. */
  tooManyCrashes() {
    const error = new Error('the browser has stopped 3 times in a few minutes; not starting it again — open it again when you need it')
    this.note(error.message)
    return error
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
          if (this.died()) throw this.tooManyCrashes()
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
          if (this.died()) throw this.tooManyCrashes()
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
        if (this.died()) throw this.tooManyCrashes()
        return this.launch(wasAt)
      }).finally(() => {
        this.starting = null
      })
      return this.starting
    }
    const asked = Date.now()
    this.starting = this.launch(options.url).finally(() => {
      this.starting = null
    })
    /* How long a rest actually cost is the number that decides whether resting
       was worth it; a silent multi-second wake is a regression, not a detail. */
    return this.starting.then((page) => {
      if (Number(this.sleptAt ?? 0) > 0) {
        this.wakeMs = Date.now() - asked
        this.note(`woke in ${String(this.wakeMs)} ms`)
        this.sleptAt = 0
      }
      return page
    })
  }

  /**
   * Ask the Flash-era browser which plugins it actually loaded.
   * @returns {Promise<{ok: boolean, name: string} | null>} the answer, or null when it could not be asked.
   */
  async checkFlash() {
    this.flashCheck = null
    const page = this.page
    if (page === null || page === undefined) return null
    try {
      const out = await page.cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(Array.from(navigator.plugins).map((one) => one.name))',
        returnByValue: true,
      })
      const said = out?.result?.value
      const names = JSON.parse(typeof said === 'string' ? said : '[]')
      this.flashCheck = flashVerdict(names)
    } catch {
      /* A page that cannot answer is not evidence either way. */
      this.flashCheck = null
    }
    return this.flashCheck
  }

  /** @param {string | undefined} url - first address. @returns {Promise<SidecarPage>} the page. */
  async launch(url) {
    /* Where a cold start goes, when someone asks: `DSH_INNER_BROWSER_TRACE=1`
       writes one line per start with the milliseconds each stage took. */
    const trace = process.env.DSH_INNER_BROWSER_TRACE === '1'
    const t0 = Date.now()
    const marks = []
    const mark = (name) => {
      if (trace) marks.push(`${name} ${Date.now() - t0}`)
    }
    /* A rest and the next call can collide: wait for the browser that is going
       out to be gone before starting the one that is coming in. */
    if (this.closing !== null) await this.closing.catch(() => {})
    mark('closing')
    /* Chromium 87 opening the profile a current Chrome owns would downgrade it
       and lock it, so the Flash-era browser keeps a profile of its own. The two
       never share a directory; a game signed into one is signed in there only. */
    const dir = this.flash ? `${profileDir(this.profile)}-flash` : profileDir(this.profile)
    /* A profile whose cookie store went missing would look signed out at the
       next step even though the person never signed out, so the working copy
       is put back before the browser is asked to read it. */
    restoreLogin(dir)
    mark('login')
    let port = await this.runningPort(dir) // ui-copy-ignore
    if (port === 0) port = await this.spawnChrome(dir) // ui-copy-ignore
    else {
      /* A browser found on the profile is adopted, not restarted. Whether this
         process may close it later depends on who started it: somebody still
         alive, or somebody who has gone and left the browser behind. */
      const owner = markerPid(dir)
      this.owns = ownsBrowser({ pid: process.pid, owner }) || mayClaim({ pid: process.pid, owner }, pidAlive(owner))
      if (this.owns && owner !== process.pid) {
        /* Taking it over means writing it down, so a later run knows whose it
           is and the marker never points at a process that is gone. */
        try {
          writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() })) // ui-copy-ignore
        } catch {
          /* a profile that cannot take a marker leaves it somebody else's */
        }
      }
    }
    mark('browser')
    const ws = await this.pageSocket(port) // ui-copy-ignore
    mark('socket')
    const cdp = new Cdp(ws)
    await cdp.ready
    this.cdp = cdp
    mark('cdp')
    this.page = await this.bind(await new SidecarPage(cdp, this.profile, port, () => this.holding()).start()) // ui-copy-ignore
    mark('page')
    if (url !== undefined && url !== '') this.lastUrl = String(url)
    await this.restoreSessionCookies()
    mark('cookies')
    await this.page.cast()
    mark('cast')
    if (url !== undefined && url !== '') await this.page.navigate(url)
    mark('navigate')
    /* A runtime that opens a port is not yet a runtime that plays: ask the page
       whether the plugin is really in it, so a broken install is said out loud
       instead of showing up as a black movie. */
    if (this.flash) await this.checkFlash()
    this.touch()
    /* Sign-ins outlive this browser: what works now is worth a copy, taken
       while the cookies are known good rather than after they are lost. */
    snapshotLogin(dir)
    this.backup?.()
    this.backup = setInterval(() => snapshotLogin(dir), 10 * 60_000)
    /* A ten-minute clock is not a reason to keep this process alive. */
    this.backup.unref?.()
    this.backup.unref?.()
    this.logger?.info?.('dsh-inner-browser-use: sidecar up on port %s (%s)', port, this.headless ? 'headless' : 'windowed') // ui-copy-ignore
    if (trace) console.error(`sidecar-start: ${Date.now() - t0} ms · ${marks.join(' · ')}`) // ui-copy-ignore
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
      '--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
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
      /* Nothing here talks to Google while the person is not reading: the
         update, the crash reporter and the network pings all cost a process,
         a socket and a wake-up on a page that is only being looked at. */
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-pings',
      '--disable-extensions',
      '--disable-default-apps',
      /* A page nobody looks at can hand its heap back when it is parked; the
         renderer needs the flag before it will collect on request. */
      '--js-flags=--expose-gc',
      /* Six tabs never need six renderers: the cap keeps the resident cost of a
         browsing session flat, while four still keeps unrelated sites apart. */
      '--renderer-process-limit=4',
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
    /* An escape hatch for measuring one flag against another without editing
     * the source: space-separated extra switches, never a replacement. */
    const extra = String(process.env.DSH_INNER_BROWSER_CHROME_FLAGS ?? '').trim()
    if (extra !== '') args.push(...extra.split(/\s+/))
    if (flash !== null) {
      /* Electron takes these switches through its own command line, not the
         argv it hands the app, so the runtime app reads them from here. */
      flash.port = Number(process.env.DSH_INNER_BROWSER_FLASH_PORT ?? 9200 + Math.floor(Math.random() * 400))
      flash.bridgePort = flash.port + 1
      args.length = 0
      /* Silent by default: a game in the column must not put its music on
         somebody's desktop. `DSH_FLASH_SOUND=1` turns it on, the pane's sound
         button toggles it live. */
      const soundAsked = /^(1|true|yes|on)$/i.test(String(process.env.DSH_FLASH_SOUND ?? '').trim())
      if (soundAsked !== true) args.push('--mute-audio')
      this.soundOn = soundAsked
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
    /* The Flash runtime is Electron: its GPU and renderer helpers are children
       that survive a signal sent to the launcher alone, and a leftover renderer
       keeps drawing (and playing) in the background. Its own group makes one
       kill cover the whole tree. */
    const child = spawn(binary, args, { detached: process.platform !== 'win32', stdio: 'ignore', env: flashEnv })
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
    /* Chrome writes the port in a few hundred milliseconds. A fixed 100 ms sleep
       before the first look hands away a tenth of every cold start, and a 100 ms
       tick rounds the rest up; so look at once, then poll closely until it shows
       up, still giving up after the same fifteen seconds. */
    const deadline = Date.now() + 15_000
    let tick = 0
    for (;;) {
      if (existsSync(file)) {
        const port = Number(String(readFileSync(file, 'utf8')).split('\n')[0] ?? 0) // ui-copy-ignore
        if (Number.isFinite(port) && port > 0) return port // ui-copy-ignore
      }
      if (Date.now() >= deadline) break
      await wait(tick)
      tick = tick < 40 ? tick + 5 : 100
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
   * Read-only links to the other tabs this chat holds, so one question can be
   * answered by the tab that has the answer. A handle can read (it has a
   * connection) and must be closed; it never starts a screencast, moves the
   * mirror or replaces the page this chat is driving.
   * @param {string} session - chat asking.
   * @param {number} [limit] - how many other tabs at most, 1 to 3.
   * @returns {Promise<Array<{title: string, url: string, cdp: any, close: () => void}>>} handles.
   */
  async elsewhere(session, limit = 3) {
    const most = Math.max(1, Math.min(3, Number(limit) || 3))
    const shown = await this.windowsFor(session)
    const rows = await this.tabs(session)
    /* The chat-level tab list drops the connection address, so the browser's own
       list is what a read-only handle is opened from. */
    const source = this.pageFor(String(session ?? '')) ?? this.page
    const raw = typeof source?.tabs === 'function' ? await source.tabs() : []
    const byId = new Map(raw.map((tab) => [String(tab.targetId), tab]))
    const out = []
    for (const row of shown) {
      if (out.length >= most) break
      if (row.current === true) continue
      const tab = byId.get(String(rows[row.index]?.targetId ?? ''))
      if (tab === undefined || String(tab.webSocketUrl ?? '') === '') continue
      try {
        const cdp = new Cdp(tab.webSocketUrl)
        await cdp.ready
        out.push({
          title: String(row.title === '' ? tab.title : row.title),
          url: String(row.url === '' ? tab.url : row.url),
          cdp,
          close: () => cdp.close(),
        })
      } catch {
        /* A tab that will not open is one tab less; the read still happens. */
      }
    }
    return out
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
    page.busy = () => this.making > 0
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
    /* The port is open a little before the page target answers, so the first
       probes are close together: a flat 200 ms gap costs a fifth of a second of
       every cold start on average for nothing. */
    let tick = 10
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
      await wait(tick)
      tick = tick < 100 ? tick + 15 : 100
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
   * Starts the idle clock again: the browser was just asked for something, and
   * that ask is also the measurement that teaches it how long this chat pauses
   * between steps while it is still working.
   * @param {number} [ms] - an explicit window, when a pane the person closed is
   *   a stronger signal than the learned rhythm.
   */
  touch(ms) {
    const now = Date.now()
    this.use.record(now)
    this.useAt = now
    this.restAt = now + (Number.isFinite(ms) ? Math.max(0, Number(ms)) : this.restWindow())
    this.armRest()
    this.wakeClock()
  }

  /**
   * Puts the precise edge on the clock: the beat would catch the deadline
   * anyway, this only makes it exact.
   */
  armRest() {
    if (this.idle !== null) clearTimeout(this.idle)
    if (this.restAt === 0) {
      this.idle = null
      return
    }
    /* The timer is the precise edge; the beat is what makes it survive a lost
       timer, a plugin reload or a laptop that slept through the deadline. */
    this.idle = setTimeout(() => {
      this.idle = null
      void this.beatNow().catch(() => {})
    }, Math.max(0, Number(this.restAt) - Date.now()))
    this.idle.unref?.()
  }

  /** @returns {number} ms of silence from this chat that still means "working". */
  restWindow() {
    return Math.min(this.restCeiling, Math.max(this.restFloor, this.use.restAfter()))
  }

  /** Starts the lifecycle beat while a browser is up. */
  wakeClock() {
    if (this.beat !== null || this.stopping === true) return
    this.beat = setInterval(() => {
      void this.beatNow().catch(() => {})
    }, BEAT_MS)
    this.beat.unref?.()
  }

  /** Stops the beat and any pending rest: the browser is gone or handed over. */
  sleepClock() {
    if (this.beat !== null) clearInterval(this.beat)
    this.beat = null
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = null
    this.restAt = 0
  }

  /**
   * One lifecycle beat: has the pause become a departure, and does the browser
   * cost more than it is being used for.
   * @returns {Promise<void>} done, possibly with the browser put away.
   */
  async beatNow() {
    if (!this.alive || this.stopping === true) {
      this.sleepClock()
      return
    }
    const now = Date.now()
    const watched = this.watched()
    const verdict = decide({
      now,
      lastUse: this.useAt,
      restAt: this.restAt,
      watched,
      quietAfter: this.use.quietAfter(),
    })
    if (verdict === 'rest') {
      this.rests += 1
      this.sleptAt = now
      /* The reason outlives the browser: a chat asking later finds out why the
         page it left is gone, instead of a silent blank column. */
      this.note(`unused for ${String(Math.round((now - Number(this.useAt)) / 1000))} s with no pane watching; put away`)
      await this.shutdown().catch(() => {})
      return
    }
    if (verdict !== 'rest') {
      /* Someone is still watching, or the chat is still working: the clock
         starts again from now, and the next edge is scheduled. */
      if (watched > 0) this.restAt = now + this.restWindow()
      if (this.idle === null && this.restAt > 0) this.armRest()
    }
    if (verdict === 'quiet') {
      if (this.resting !== true) {
        this.resting = true
        /* A picture nobody looks at still costs a screencast and an encoded
           frame per beat. The page stays, the painting stops. */
        for (const page of [this.page, ...this.pages.values()]) {
          if (page === null || page === undefined) continue
          if ((page.frames?.size ?? 0) !== 0) continue
          if (typeof page.stopCast !== 'function') continue
          await page.stopCast().catch(() => {})
          /* Chrome's own Page Lifecycle park: timers and fetches stop, the DOM,
             the scroll position and the CDP session stay. No competitor drives
             this state at all, and it is the difference between a tab that has
             to be reloaded and one that resumes where it was. */
          await page.freeze().catch(() => {})
        }
        this.restNote = 'no pane is watching; the page is parked and the mirror paused'
      }
    } else if (this.resting === true) {
      this.resting = false
      this.restNote = ''
    }
    await this.weigh(now, watched)
  }

  /**
   * What the browser costs, and what to do about it: tabs nobody watches go
   * first, and the browser itself goes when nobody watches at all.
   * @param {number} now - the moment of this look.
   * @param {number} watched - panes watching a picture right now.
   * @returns {Promise<void>} done.
   */
  async weigh(now, watched) {
    if (now - Number(this.memAt ?? 0) < SAMPLE_MS) return
    this.memAt = now
    const pid = Number(this.child?.pid ?? 0)
    this.memMb = pid > 0 ? Math.round(treeBytes(pid) / 1024 / 1024) : 0
    if (this.memMb < this.budgetMb) {
      this.pressure = 'ok'
      return
    }
    if (this.pressure === 'ok') {
      this.pressure = 'tight'
      this.note(`holding ${String(this.memMb)} MB; closing tabs no pane is watching`)
      await this.trimTabs().catch(() => {})
      await this.reapIdleTabs(true).catch(() => {})
      return
    }
    if (watched === 0) {
      this.pressure = 'high'
      this.rests += 1
      this.sleptAt = Date.now()
      await this.shutdown().catch(() => {})
    }
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
    this.sleepClock()
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
       the plugin instance it was started for. The same node the plugin runs on
       does the watching on every platform: Windows has no `/bin/sh`, and one
       code path means the one that was measured here is the one that ships. */
    const guard = armWatcher({ app, chrome })
    if (guard === 0) return
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(watcherFile(dir), JSON.stringify({ appPid: app, pid: guard, chrome, at: Date.now() }))
    } catch {
      /* a watcher that cannot write its note still closes the browser */
    }
  }

  async shutdown() {
    /* One at a time: a rest that fires while a call already asked the browser
       to close must not close the socket that call is about to use. */
    if (this.closing !== null) return this.closing
    const going = this.putAway()
    this.closing = going
    try {
      await going
    } finally {
      if (this.closing === going) this.closing = null
    }
  }

  /** Put the browser away once; `shutdown()` keeps two of these from overlapping.
   * @returns {Promise<void>} done. */
  async putAway() {
    this.idleAt = 0
    if (this.sizeClock !== null) clearTimeout(this.sizeClock)
    this.sizeClock = null
    /* Nothing to wait for once the browser is going: a beat that fired into a
       stopped browser would try to put it away a second time. */
    this.sleepClock()
    /* A browser this process did not start belongs to somebody else — another
       app on the same profile, or a script that connected to it — and closing
       it would close the person's window. Let go of it instead: drop the socket
       and leave the browser running. */
    const mine = this.owns === true
    /* The bridge's number outlives `flashBridge` below: the sweep at the end needs
       to know which bridge was this session's. */
    const bridge = this.flashBridge
    if (mine && this.page !== null) {
      /* Ask Chrome to close first: a browser that is killed outright may lose
         the last minute of cookies, and keeping the person signed in is the
         point. */
      /* Neither of these may throw on the way out: a rejected save would skip
         the cleanup below and leave a dead browser's clocks running. */
      await this.saveSessionCookies().catch(() => {})
      try {
        snapshotLogin(profileDir(this.profile))
      } catch {
        /* a profile that cannot be read is not a reason to hang */
      }
    }
    if (this.backup !== undefined) clearInterval(this.backup)
    this.backup = undefined
    /* A page somebody is watching polls its own bridge; that loop has to end
       before the bridge goes away, or it keeps waking up on a page that no
       longer exists and this process never gets to exit. */
    for (const page of [this.page, ...(this.pages?.values() ?? [])]) {
      if (page === null || page === undefined) continue
      page.casting = false
      page.stopped = true
      page.frames?.clear()
    }
    /* The bridge is an Electron app in its own process: a SIGTERM it can ignore
       leaves that process (and this one) alive. Ask it to close, then fall back
       to signals below. */
    if (this.flashBridge !== null && mine) {
      await fetch(`http://127.0.0.1:${this.flashBridge}/shutdown`, { method: 'POST' }).catch(() => {})
    }
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
                if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
                  try {
                    process.kill(-child.pid, 'SIGKILL')
                  } catch {
                    /* no group of its own: the launcher is still worth a shot */
                  }
                }
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
    /* A Flash helper that outlived both the group kill and its launcher keeps
       painting and keeps playing; nothing else in the app can see it. Match by
       the number only this session's bridge was given. `ps -E` is macOS; on other
       platforms the group kill above is what there is. */
    if (bridge !== null && process.platform === 'darwin') {
      try {
        const dump = spawnSync('ps', ['-E', '-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        for (const pid of pidsWithMark(dump.stdout, `DSH_FLASH_BRIDGE_PORT=${bridge}`)) {
          if (pid === process.pid) continue
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* a sweep that cannot run must not fail the put-away */
      }
    }
    /* The child's pipes are the last thing holding this process open: after the
       browser is gone there is nobody to read them, and a referenced pipe keeps
       the event loop alive forever instead of letting the call return. */
    for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr]) stream?.destroy?.()
    this.child?.unref?.()
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
      writeSealed(file, jar)
    } catch {
      /* a browser that is already gone has nothing to save */
    }
  }

  /** @returns {Promise<void>} puts back what saveSessionCookies kept. */
  async restoreSessionCookies() {
    /* Sealed by this version; plain JSON by one before it. Both are read, so an
       update never signs anyone out. */
    const jar = readSealed(sessionJar(profileDir(this.profile)))
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
      flash: this.flash, // ui-copy-ignore
      sound: this.soundOn === true, // ui-copy-ignore
      /* The person holds the page: a chat that asks before acting reads this,
         and the pane draws the control chip from it. */
      held: this.held === true, // ui-copy-ignore
      flashCheck: this.flashCheck, // ui-copy-ignore
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
      /* What this browser costs right now: the whole process tree, renderers
         included. Reported so a chat can decide whether to let it rest. */
      memory: this.alive ? treeBytes(Number(this.child?.pid ?? 0)) : 0,
      /* When it would be put away if nobody came back, and why: 0 means the
         browser is either watched or not on a clock. */
      closesIn: this.restAt === 0 || this.stopping === true ? 0 : Math.max(0, Number(this.restAt) - Date.now()),
      /* The learned rhythm: the rest window this chat earned, and the quiet
         window it is given before the mirror is paused. */
      restIn: this.restAt === 0 ? 0 : Math.max(0, Number(this.restAt) - Date.now()),
      restWindow: this.use.restAfter(),
      quietAfter: this.use.quietAfter(),
      typicalGap: this.use.typical(),
      /* What the lifecycle beat last found. */
      resting: this.resting === true,
      restNote: this.restNote ?? '',
      /* How many times it has been put down, how long the last wake took, and
         how long it has been waiting for a wake right now. */
      rests: this.rests,
      sleptAt: this.sleptAt,
      wakeMs: this.wakeMs,
      /* Memory policy, so a chat can see the ladder before it is climbed. */
      memoryMb: this.memMb,
      budgetMb: this.budgetMb,
      pressure: this.pressure,
      /* Parked pages and the restarts that happened recently: a browser that
         has to be restarted three times in ten minutes is broken, and saying so
         is better than restarting it for ever. */
      parked: [this.page, ...this.pages.values()].filter((page) => page?.frozen === true).length,
      restarts: this.crashes.length,
      error: this.alive ? '' : this.lastError,
    }
  }
}
