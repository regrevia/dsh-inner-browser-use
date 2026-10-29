/* A page from the Flash era needs two things this plugin cannot put in its own
   tarball: a browser that still speaks PPAPI, and the plugin itself. The first
   is a Chromium build (BSD, redistributable); the second is Adobe's, which may
   not be shipped. So the switch fetches both once, into the person's own state
   directory, and afterwards the plugin works offline. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Root of everything the Flash runtime keeps. */
export const FLASH_DIR = join(homedir(), '.dsh', 'inner-browser-use', 'flash')

/** Chromium 87 is the last build with PPAPI, and the last Electron 11. */
const ELECTRON_VERSION = process.env.DSH_FLASH_ELECTRON_VERSION ?? '11.3.0'

/** Launchers known to carry a Pepper Flash plugin build. */
const LAUNCHERS = ['百田游戏安全管家.app', '百田游戏管家.app', 'Flash Player.app']

/** Where a Pepper Flash plugin may already live on this machine. */
const PLUGIN_PATHS = LAUNCHERS.flatMap((name) => [
  join('/Applications', name, 'Contents', 'Resources', 'libs', 'PepperFlashPlayer.plugin'),
  join(homedir(), 'Applications', name, 'Contents', 'Resources', 'libs', 'PepperFlashPlayer.plugin'),
  join('/Library/Internet Plug-Ins', 'PepperFlashPlayer.plugin'),
])

/** @param {string} path - candidate. @returns {boolean} true when it is a plugin bundle. */
function isPlugin(path) {
  return existsSync(join(path, 'Contents', 'Info.plist'))
}

/** @returns {string | undefined} the plugin already installed here. */
export function findPlugin() {
  const noted = process.env.DSH_INNER_BROWSER_FLASH_PLUGIN
  if (noted !== undefined && existsSync(noted)) return noted
  const own = join(FLASH_DIR, 'plugin', 'PepperFlashPlayer.plugin')
  if (isPlugin(own)) return own
  return PLUGIN_PATHS.find((path) => isPlugin(path))
}

/** @param {string} bundle - a .plugin bundle. @returns {string} the loadable plugin file. */
export function pluginExecutable(bundle) {
  const inner = join(bundle, 'Contents', 'MacOS', 'PepperFlashPlayer')
  return existsSync(inner) ? inner : bundle
}

/** @returns {string} where the Chromium 87 binary would be. */
export function electronPath() {
  return join(FLASH_DIR, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
}

/** @returns {{ electron: string, plugin: string } | null} the runtime, when ready. */
export function readyFlash() {
  const electron = electronPath()
  const bundle = findPlugin()
  if (!existsSync(electron) || bundle === undefined) return null
  return { electron, plugin: pluginExecutable(bundle) }
}

/** @returns {string} the Chromium 87 build matching this machine. */
function electronUrl() {
  const noted = process.env.DSH_FLASH_ELECTRON_URL
  if (noted !== undefined) return noted
  /* Flash exists as an x86_64 library only, so the browser that hosts it must
     be x86_64 as well; on Apple silicon both run under Rosetta. */
  return `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-darwin-x64.zip`
}

/**
 * Fetch one URL to a file, saying how far along it is.
 * @param {string} url - what to fetch.
 * @param {string} file - where it lands.
 * @param {(seen: number, total: number) => void} [progress] - byte counter.
 * @returns {Promise<void>} resolves when the file is complete.
 */
async function download(url, file, progress) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`flash: ${url} answered ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const chunks = []
  let seen = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    seen += chunk.length
    progress?.(seen, total)
  }
  const body = Buffer.concat(chunks)
  if (total > 0 && body.length !== total) throw new Error(`flash: short download (${body.length}/${total})`)
  mkdirSync(join(file, '..'), { recursive: true })
  await import('node:fs/promises').then((fs) => fs.writeFile(file, body))
}

/**
 * Make the Flash runtime usable on this machine, fetching what is missing.
 * @param {{ progress?: (line: string) => void }} [options] - reporting hook.
 * @returns {Promise<{ electron: string, plugin: string }>} the runtime.
 */
export async function ensureFlash(options = {}) {
  const say = options.progress ?? (() => {})
  mkdirSync(FLASH_DIR, { recursive: true })
  let plugin = findPlugin()

  if (!existsSync(electronPath())) {
    const zip = join(FLASH_DIR, 'cache', `electron-v${ELECTRON_VERSION}-darwin-x64.zip`)
    if (!existsSync(zip) || statSync(zip).size < 40_000_000) {
      const url = electronUrl()
      say(`下载 Chromium 87（约 80 MB）: ${url}`)
      let last = 0
      await download(url, zip, (seen, total) => {
        if (seen - last > 8_000_000) {
          last = seen
          say(`  ${Math.round(seen / 1e6)} MB${total === 0 ? '' : ` / ${Math.round(total / 1e6)} MB`}`)
        }
      })
    }
    const staging = join(FLASH_DIR, 'electron.tmp')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    say('解压 Chromium 87')
    execFileSync('/usr/bin/unzip', ['-q', '-o', zip, '-d', staging], { stdio: 'ignore' })
    const app = join(staging, 'Electron.app')
    if (!existsSync(app)) throw new Error('flash: the archive had no Electron.app')
    rmSync(join(FLASH_DIR, 'electron'), { recursive: true, force: true })
    renameSync(staging, join(FLASH_DIR, 'electron'))
    say('Chromium 87 就绪')
  }

  if (plugin === undefined) {
    throw new Error('flash: 这台机器上没有 Pepper Flash 插件；装一次任意带 Flash 的游戏客户端（例如百田游戏安全管家），或用 DSH_INNER_BROWSER_FLASH_PLUGIN 指向已有的 PepperFlashPlayer.plugin')
  }

  const electron = electronPath()
  const pluginFile = pluginExecutable(plugin)
  say(`Flash 运行时就绪: ${electron}`)
  say(`插件: ${pluginFile}`)
  return { electron, plugin: pluginFile }
}

/**
 * Human-readable state, without fetching anything.
 * @returns {{ ready: boolean, electron: boolean, plugin: string | null, dir: string }} the state.
 */
export function flashStatus() {
  const plugin = findPlugin() ?? null
  return {
    ready: existsSync(electronPath()) && plugin !== null,
    electron: existsSync(electronPath()),
    plugin: plugin === null ? null : pluginExecutable(plugin),
    dir: FLASH_DIR,
  }
}
