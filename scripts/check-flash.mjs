#!/usr/bin/env node
/**
 * Can this Chrome still play a Flash page, through Ruffle?
 *
 *   node scripts/check-flash.mjs https://www.4399.com/flash/16613.htm
 *
 * Injects the Ruffle player into the page before it loads, lets the page's own
 * embed be replaced, and reports what the frames ended up holding: a player, a
 * canvas with pixels, or nothing. Its own profile, its own Chrome, both closed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'https://www.4399.com/flash/16613.htm'
const rufflePath = process.argv[3] ?? '/tmp/ruffle.js'
const state = mkdtempSync(join(tmpdir(), 'dsh-flash-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'flash-check', headless: true })
let chrome = 0
try {
  await sidecar.launch(url)
  const page = sidecar.page
  chrome = sidecar.child?.pid ?? 0
  const source = readFileSync(rufflePath, 'utf8')
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.RufflePlayer = window.RufflePlayer || {};\nwindow.RufflePlayer.config = { publicPath: 'https://unpkg.com/@ruffle-rs/ruffle@0.2.0/', autoplay: 'on', unmuteOverlay: 'hidden', splashScreen: false, letterbox: 'on' };\n${source}`,
  })
  await page.cdp.send('Page.reload', { ignoreCache: true })
  await wait(12000)
  const evalIn = async (expression) => {
    const reply = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.value
  }
  const report = await evalIn(`(() => {
    const frames = [document, ...[...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument } catch { return null } })].filter(Boolean)
    return {
      frames: frames.length,
      ruffle: typeof window.RufflePlayer,
      players: frames.reduce((all, doc) => all + doc.querySelectorAll('ruffle-player, ruffle-embed').length, 0),
      canvases: frames.reduce((all, doc) => all + doc.querySelectorAll('canvas').length, 0),
      swfEmbeds: frames.reduce((all, doc) => all + doc.querySelectorAll('embed[src$=".swf"], object[data$=".swf"]').length, 0),
      text: String(document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
    }
  })()`)
  console.log(JSON.stringify({ url, ...report }, null, 1))
} finally {
  try {
    await sidecar.shutdown()
  } catch {
    /* a browser already gone needs no shutdown */
  }
  if (chrome !== 0) {
    try {
      process.kill(chrome, 'SIGKILL')
    } catch {
      /* it went with the socket */
    }
  }
  rmSync(state, { recursive: true, force: true })
}
