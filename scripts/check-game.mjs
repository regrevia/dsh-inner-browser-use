#!/usr/bin/env node
/**
 * A real web-game page, measured the way a player feels it: is the picture a
 * canvas, how fast does the mirror hand it over, and does a held key arrive.
 *
 *   node scripts/check-game.mjs                       # 奥拉星, the site it was written for
 *   node scripts/check-game.mjs https://www.4399.com/ # anywhere
 *
 * Uses its own profile and its own Chrome, and closes both.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://aoqi.100bt.com/'
const state = mkdtempSync(join(tmpdir(), 'dsh-game-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')
const { pressKey } = await import('../tools.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

const sidecar = new Sidecar({ profile: 'game-check', headless: true })
let chrome = 0
try {
  const launchAt = Date.now()
  await sidecar.launch(url)
  const launchMs = Date.now() - launchAt
  await wait(2500)
  const page = sidecar.page
  chrome = sidecar.child?.pid ?? 0
  const evalIn = async (expression) => {
    const reply = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.value
  }
  /* The page counts its own animation frames and its own key events: what the
     mirror can carry is only as good as what the engine draws. */
  await evalIn(`(() => {
    window.__game = { frames: 0, keys: [] }
    const tick = () => { window.__game.frames += 1; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    addEventListener('keydown', (e) => window.__game.keys.push('down:' + e.key))
    addEventListener('keyup', (e) => window.__game.keys.push('up:' + e.key))
    return true
  })()`)
  /* Count frames with nothing else going on: a screenshot loop of its own
     slows a page down, so the idle rate is the honest one. */
  const idleFrom = await evalIn('window.__game.frames')
  const idleStart = Date.now()
  await wait(1000)
  const idleMs = Date.now() - idleStart
  const idleFrames = Number(await evalIn('window.__game.frames')) - Number(idleFrom)
  const startedAt = Date.now()
  const shotTimes = []
  for (let i = 0; i < 10; i += 1) {
    const at = Date.now()
    const shot = await page.screenshot()
    shotTimes.push(Date.now() - at)
    if (i === 0) shotTimes.kb = Math.round(String(shot).length / 1024 / 0.75)
  }
  const measuredMs = Date.now() - startedAt
  const frames = await evalIn('window.__game.frames')
  await pressKey(page, 'd', 0, 200)
  const keys = await evalIn('JSON.stringify(window.__game.keys)')
  const canvases = await evalIn(`JSON.stringify([...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height))`)
  shotTimes.sort((left, right) => left - right)
  const running = shotTimes.filter((row) => row !== shotTimes.kb)
  console.log(JSON.stringify({
    url,
    launchMs,
    idleFps: Math.round((idleFrames / (idleMs / 1000)) * 10) / 10,
    framesMeasured: frames,
    measuredMs,
    fps: Math.round(Number(frames) / (measuredMs / 1000)),
    mirrorShotMedianMs: running[Math.floor(running.length / 2)],
    mirrorShotKb: shotTimes.kb,
    keyHeld: String(keys).includes('down:d') && String(keys).includes('up:d'),
    canvases: JSON.parse(String(canvases)),
  }))
} finally {
  await sidecar.shutdown()
  const alive = (() => {
    try {
      return chrome !== 0 && execFileSync('ps', ['-o', 'pid=', '-p', String(chrome)], { encoding: 'utf8' }).trim() !== ''
    } catch {
      return false
    }
  })()
  if (alive) {
    try {
      execFileSync('kill', [String(chrome)])
    } catch {
      /* already gone */
    }
  }
  rmSync(state, { recursive: true, force: true })
}
