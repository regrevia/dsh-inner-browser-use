#!/usr/bin/env node
/**
 * Can a Flash game run without ever appearing on the desktop?
 *
 *   node scripts/check-flash-window.mjs [url]
 *
 * Starts the plugin's own Flash runtime on the address, then checks three
 * things that together mean "only the column sees it": the window was never
 * shown, the picture keeps changing, and the process is not a frontmost or
 * Dock-bearing app. Its own profile and state directory; both are closed.
 */
import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://account.100bt.com/game/auth/login.html?gameName=aola&action=startgame&platform=100bt'
process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-window-'))

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'flash-window', headless: false, flash: true })
let ok = false
try {
  const started = Date.now()
  await sidecar.launch('about:blank')
  await sidecar.page.navigate(url).catch(() => {})
  await wait(10_000)
  const base = `http://127.0.0.1:${sidecar.flashBridge}`
  const info = await fetch(`${base}/info`).then((reply) => reply.json()).catch(() => null)
  const grab = async () => {
    const body = Buffer.from(await (await fetch(`${base}/frame.jpg`)).arrayBuffer())
    return { kb: Math.round(body.length / 1024), hash: createHash('sha1').update(body).digest('hex').slice(0, 8) }
  }
  const one = await grab()
  await wait(900)
  const two = await grab()
  const neverShown = info !== null && info.visible === false
  const painting = info !== null && Number(info.painted ?? 0) > 10
  const moving = one.hash !== two.hash
  ok = neverShown && painting && moving
  console.log(JSON.stringify({
    url: String(info?.url ?? url).slice(0, 80),
    visible: info?.visible,
    painted: info?.painted,
    frameKB: one.kb,
    moved: moving,
    ms: Date.now() - started,
    ok,
  }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 160) }))
} finally {
  await sidecar.shutdown().catch(() => {})
}
process.exitCode = ok ? 0 : 1
