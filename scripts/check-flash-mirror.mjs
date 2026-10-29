#!/usr/bin/env node
/**
 * Does a Flash page mirror into the column at a usable rate, and do clicks land?
 *
 *   node scripts/check-flash-mirror.mjs [url]
 *
 * Counts the frames a viewer really receives, times a press and a release
 * through the page, and reports both next to the frame size. Own profile, own
 * state directory, closed afterwards; nothing is shown on the desktop.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://account.100bt.com/game/auth/login.html?gameName=aola&action=startgame&platform=100bt'
process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-mirror-'))

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'flash-mirror', headless: false, flash: true })
let ok = false
try {
  const started = Date.now()
  await sidecar.launch('about:blank')
  const sizes = []
  const times = []
  const detach = await sidecar.watch((frame) => {
    sizes.push(Math.round(String(frame.jpeg ?? '').length * 0.75 / 1024))
    times.push(Date.now())
  })
  const navigatedAt = Date.now()
  const page = sidecar.page
  await page.navigate(url).catch(() => {})
  for (let i = 0; i < 60 && times.length === 0; i += 1) await wait(250)
  const firstFrame = Date.now() - navigatedAt
  await wait(4000)
  detach()
  const gaps = times.slice(1).map((at, index) => at - times[index]).sort((a, b) => a - b)
  const fps = gaps.length === 0 ? 0 : Math.round((1000 / (gaps[Math.floor(gaps.length / 2)] || 1000)) * 10) / 10
  const pressedAt = Date.now()
  await page.mouse('mousePressed', { x: 640, y: 420 })
  const pressMs = Date.now() - pressedAt
  const releasedAt = Date.now()
  await page.mouse('mouseReleased', { x: 640, y: 420 })
  const releaseMs = Date.now() - releasedAt
  await wait(400)
  const before = await page.picture()
  const keyAt = Date.now()
  await page.key('keyDown', { key: 'a', text: 'a' })
  const keyMs = Date.now() - keyAt
  await page.key('keyUp', { key: 'a' })
  await wait(600)
  const moved = await page.picture()
  ok = fps >= 15 && pressMs < 40 && releaseMs < 40 && keyMs < 40 && moved !== before && sizes.length > 5
  console.log(JSON.stringify({
    firstFrameMs: firstFrame,
    frames: sizes.length,
    fps,
    frameKB: sizes.length === 0 ? 0 : Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    pressMs,
    releaseMs,
    keyMs,
    responded: moved !== '' && moved !== before,
    ok,
  }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 160) }))
} finally {
  await sidecar.shutdown().catch(() => {})
}
process.exitCode = ok ? 0 : 1
