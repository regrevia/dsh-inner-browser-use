#!/usr/bin/env node
/**
 * Is the picture the game, or the window the game sits in?
 *
 *   node scripts/check-flash-fit.mjs [url]
 *
 * A window is not a layout: resizing the offscreen window changes what is
 * captured, not how far the page spreads its game, so a fixed-size game framed
 * by the window ends up stretched with a white margin beside it and black
 * padding below. This asks the runtime for a tall, narrow column and then
 * checks the two things that make that impossible: the window it frames on is
 * the box the plugin occupies, and the JPEG it hands out is exactly that box.
 * Its own profile and state directory; both are closed.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://account.100bt.com/game/auth/login.html?gameName=aola&action=startgame&platform=100bt'
process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-fit-'))

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** The width and height a JPEG file itself declares, without decoding it. */
function jpegSize(body) {
  for (let at = 2; at < body.length - 9;) {
    if (body[at] !== 0xff) { at += 1; continue }
    const marker = body[at + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: body.readUInt16BE(at + 7), height: body.readUInt16BE(at + 5) }
    }
    at += 2 + body.readUInt16BE(at + 2)
  }
  return { width: 0, height: 0 }
}

const sidecar = new Sidecar({ profile: 'flash-fit', headless: false, flash: true })
let ok = false
try {
  const started = Date.now()
  await sidecar.launch('about:blank')
  await sidecar.page.navigate(url).catch(() => {})
  await wait(10_000)
  const base = `http://127.0.0.1:${sidecar.flashBridge}`
  /* The shape a right-hand column has: taller than it is wide, and taller than
     the 900-pixel page the runtime was created with. */
  const asked = { width: 760, height: 1240 }
  const reply = await fetch(`${base}/resize?w=${asked.width}&h=${asked.height}`)
    .then((answer) => answer.json()).catch(() => null)
  await wait(700)
  const body = Buffer.from(await (await fetch(`${base}/frame.jpg`)).arrayBuffer())
  const frame = jpegSize(body)
  const bounds = reply?.bounds ?? {}
  const content = reply?.content ?? null
  /* Two promises, both checkable without knowing the site: the window follows
     the game when the page names one, and the picture is the window. */
  const framed = content === null
    ? bounds.width === asked.width && bounds.height === asked.height
    : bounds.width === content.width && bounds.height === content.height
  /* The pane is drawn on a high-density screen, so the bridge hands over more
     pixels than the game's own size. `scale` says how many. */
  const scale = Number(reply?.scale ?? 1)
  const matches = frame.width === Math.round(bounds.width * scale) && frame.height === Math.round(bounds.height * scale)
  ok = reply?.viewport?.width === asked.width && reply?.viewport?.height === asked.height && framed && matches && scale >= 1
  console.log(JSON.stringify({
    url: String(reply?.url ?? url).slice(0, 80),
    asked,
    bounds,
    content,
    scale,
    frame,
    frameKB: Math.round(body.length / 1024),
    ms: Date.now() - started,
    ok,
  }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 160) }))
} finally {
  await sidecar.shutdown().catch(() => {})
}
process.exitCode = ok ? 0 : 1
