#!/usr/bin/env node
/**
 * Live proof that the hand lands where it looks, on this machine's Chrome.
 * The page is laid out wider than the picture that reaches the pane, which is
 * the case a scaled mirror gets wrong: the page records the point it received,
 * the point the hit test put under the hand, and the button mask on every
 * event, so a fraction that is resolved against the picture instead of the page
 * fails here rather than in a chat.
 *
 *   node scripts/pointer.mjs          # the whole matrix
 *   node scripts/pointer.mjs --json   # one machine-readable line
 *
 * Exit code 0 means every point matched and every event carried the button a
 * real hand would hold. Another platform runs the same file.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sidecar } from '../sidecar.js?v=1'
import { aimAt } from '../pixels.js?v=1'

process.env.DSH_INNER_BROWSER_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'dsh-pointer-'))

const WIDE = 3000
const TALL = 1600

const PAGE = `<!doctype html><meta charset="utf-8"><title>pointer</title>
<style>html,body{margin:0;height:100%;background:#fff}
#box{position:absolute;left:2600px;top:1300px;width:200px;height:200px;background:#08f}
#under{position:absolute;left:0;top:0;right:0;bottom:0}</style>
<div id="under"></div><div id="box"></div>
<script>
window.__moves = []
window.__wheels = []
window.__presses = []
addEventListener('mousemove', (event) => {
  window.__moves.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, target: (event.target && event.target.id) || '' })
}, true)
addEventListener('mousedown', (event) => {
  window.__presses.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, target: (event.target && event.target.id) || '' })
}, true)
addEventListener('wheel', (event) => {
  window.__wheels.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, button: event.button, dy: Math.round(event.deltaY) })
}, true)
window.__reset = () => { window.__moves = []; window.__wheels = []; window.__presses = []; return true }
</script>`

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const rows = []
const startedAt = Date.now()

/** @param {any} page - sidecar page. @param {string} code - expression. */
async function run(page, code) {
  const out = await page.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true })
  if (out?.exceptionDetails) throw new Error(String(out.exceptionDetails.text ?? 'page threw'))
  return out?.result?.value
}

/** @param {string} label - what is checked. @param {boolean} ok - passed. @param {string} [detail] - why not. */
function check(label, ok, detail) {
  rows.push({ label, ok: ok === true, ...(detail === undefined ? {} : { detail }) })
}

/** @param {any} page - the sidecar page. @param {number} fx - across. @param {number} fy - down. @param {number} pw - page width. @param {number} ph - page height. */
function point(page, fx, fy, pw, ph) {
  const view = page.view ?? { width: 0, height: 0 }
  return aimAt({ fx, fy, fw: view.width, fh: view.height, pw, ph }, view)
}

/** The page is laid out wide, and the pane is told both sizes the way the client tells it. */
async function layWide(sidecar) {
  const page = sidecar.page
  await page.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDE,
    height: TALL,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await page.stopCast()
  await page.cast()
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await wait(150)
    if (page.view?.width === WIDE && page.view?.height === TALL && Number(page.seq ?? 0) > 0) break
  }
  return page
}

/** @param {any} page - sidecar page. */
async function mapped(page) {
  await run(page, 'window.__reset()')
  const middle = point(page, 0.5, 0.5, WIDE, TALL)
  await page.mouse('mouseMoved', middle)
  await wait(400)
  const moves = JSON.parse(await run(page, 'JSON.stringify(window.__moves)'))
  const seen = moves.at(-1)
  check('middle of a wide page is the middle of it', seen !== undefined && Math.abs(seen.x - 1500) <= 1 && Math.abs(seen.y - 800) <= 1,
    seen === undefined ? 'the page saw no move' : `the page saw ${String(seen.x)},${String(seen.y)}, not 1500,800`)
  check('the pane believed the page size', page.view?.width === WIDE && page.view?.height === TALL,
    `the pane believes ${String(page.view?.width)}x${String(page.view?.height)}`)

  /* A picture capped in pixels is not the page: a pane that was handed an
     800-wide picture of a 3000-wide page must still land on 1500. */
  const capped = aimAt({ fx: 0.5, fy: 0.5, fw: 800, fh: 600, pw: WIDE, ph: TALL }, { width: 800, height: 600 })
  await page.mouse('mouseMoved', capped)
  await wait(400)
  const smaller = JSON.parse(await run(page, 'JSON.stringify(window.__moves)')).at(-1)
  check('a picture smaller than the page still lands on the page', smaller !== undefined && Math.abs(smaller.x - 1500) <= 1 && Math.abs(smaller.y - 800) <= 1,
    smaller === undefined ? 'the page saw no move' : `the page saw ${String(smaller.x)},${String(smaller.y)}, not 1500,800`)

  const corner = point(page, 1, 1, WIDE, TALL)
  check('the far corner is the last pixel, not one past it', corner !== null && corner.x === WIDE - 1 && corner.y === TALL - 1,
    `the corner resolved to ${JSON.stringify(corner)}`)

  const box = point(page, (2700 / WIDE), (1400 / TALL), WIDE, TALL)
  await page.mouse('mouseMoved', box)
  await wait(400)
  const overBox = JSON.parse(await run(page, 'JSON.stringify(window.__moves)')).at(-1)
  check('a target on the far side is under the hand', overBox?.target === 'box',
    `the hand landed on ${JSON.stringify(overBox?.target ?? '')} at ${String(overBox?.x)},${String(overBox?.y)}`)
}

/** @param {any} page - sidecar page. */
async function dragged(page) {
  await run(page, 'window.__reset()')
  const from = point(page, 0.2, 0.3, WIDE, TALL)
  const to = point(page, 0.8, 0.7, WIDE, TALL)
  await page.mouse('mousePressed', { x: from.x, y: from.y, button: 'left', clickCount: 1 })
  await page.mouse('mouseMoved', { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) })
  await page.mouse('mouseMoved', to)
  const held = await page.wheel({ x: to.x, y: to.y, dx: 0, dy: 120 })
  await wait(400)
  const moves = JSON.parse(await run(page, 'JSON.stringify(window.__moves)'))
  const wheels = JSON.parse(await run(page, 'JSON.stringify(window.__wheels)'))
  const presses = JSON.parse(await run(page, 'JSON.stringify(window.__presses)'))
  await page.mouse('mouseReleased', { x: to.x, y: to.y, button: 'left', clickCount: 1 })

  check('the press was at the point the hand went to', presses[0] !== undefined && Math.abs(presses[0].x - from.x) <= 1 && Math.abs(presses[0].y - from.y) <= 1,
    JSON.stringify(presses[0] ?? null))
  check('every move of a drag carries the held button', moves.length >= 2 && moves.every((one) => one.buttons === 1),
    `button masks ${JSON.stringify(moves.map((one) => one.buttons))}`)
  check('the wheel was taken by the page', held === true && wheels.length === 1, `wheel took ${String(held)}`)
  check('a wheel turned mid-drag keeps the held button', wheels[0]?.buttons === 1,
    `the page saw buttons ${String(wheels[0]?.buttons)} on the wheel`)
  check('a wheel is not a button press', wheels[0]?.button === 0, `the page saw button ${String(wheels[0]?.button)}`)
  return { moves: moves.length, wheels: wheels.length }
}

/** Run the whole probe. */
async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${String(server.address().port)}/`
  const sidecar = new Sidecar({ profile: 'pointer' })
  const summary = { platform: process.platform, node: process.version, wide: `${String(WIDE)}x${String(TALL)}` }
  try {
    await sidecar.launch(url)
    const page = await layWide(sidecar)
    summary.frame = { w: page.view?.width ?? 0, h: page.view?.height ?? 0 }
    const lay = Date.now()
    await mapped(page)
    summary.mapMs = Date.now() - lay
    const drag = Date.now()
    summary.drag = await dragged(page)
    summary.dragMs = Date.now() - drag
  } finally {
    await sidecar.shutdown().catch(() => {})
    server.close()
  }
  const failed = rows.filter((row) => row.ok !== true)
  summary.checked = rows.length
  summary.matched = rows.length - failed.length
  summary.failed = failed.slice(0, 20)
  summary.ms = Date.now() - startedAt
  summary.ok = failed.length === 0
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary))
  } else {
    for (const row of failed) console.log(`FAIL ${row.label}: ${row.detail ?? ''}`)
    console.log(`pointer ${summary.matched}/${summary.checked} · view ${String(summary.frame?.w)}x${String(summary.frame?.h)} · map ${String(summary.mapMs)} ms · ${summary.drag.moves} moves / ${summary.drag.wheels} wheel · ${String(summary.ms)} ms total`)
  }
  process.exitCode = summary.ok === true ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
