#!/usr/bin/env node
/**
 * Can this browser run a Flash movie at all through Ruffle, and how fast does it draw?
 *
 *   node scripts/probe-rumble.mjs [page]
 *
 * Loads public Ruffle (their own demo page, which hosts a real SWF), then reports
 * whether a canvas appears, how big it is, and the frame rate over a second.
 * Its own profile, its own Chrome, both closed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'https://ruffle.rs/demo/'
const state = mkdtempSync(join(tmpdir(), 'dsh-rumble-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state
const { Sidecar } = await import('../sidecar.js')
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'rumble-check', headless: true })
let chrome = 0
try {
  const at = Date.now()
  await sidecar.launch(url)
  chrome = sidecar.child?.pid ?? 0
  let seen = null
  for (let i = 0; i < 10 && seen === null; i += 1) {
    await wait(600)
    const reply = await sidecar.page.cdp.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(() => {
      const ruffle = document.querySelector('ruffle-player, ruffle-object, ruffle-embed')
      const canvas = document.querySelector('.ruffle-canvas canvas, ruffle-player canvas, canvas')
      return { ruffle: ruffle ? ruffle.tagName.toLowerCase() : '', canvas: canvas ? canvas.width + 'x' + canvas.height : '' }
    })()` })
    seen = reply?.result?.value ?? {}
  }
  const fps = await sidecar.page.cdp.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `new Promise((done) => {
    let n = 0
    const t0 = performance.now()
    const tick = () => { n += 1; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else done(n) }
    requestAnimationFrame(tick)
  })` })
  const mute = await sidecar.page.cdp.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `(() => {
    const c = document.querySelector('canvas')
    if (!c) return ''
    try { const d = c.getContext('2d'); return d ? 'readable' : 'webgl' } catch { return 'blocked' }
  })()` })
  console.log(JSON.stringify({ url, ms: Date.now() - at, ...(seen ?? {}), fps: fps?.result?.value ?? 0, pixels: mute?.result?.value ?? '' }))
} finally {
  try { await sidecar.shutdown() } catch {}
  if (chrome !== 0) { try { process.kill(chrome, 'SIGKILL') } catch {} }
  rmSync(state, { recursive: true, force: true })
}
