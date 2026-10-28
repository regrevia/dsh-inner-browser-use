#!/usr/bin/env node
/**
 * What the two ways of acting actually change, measured on one page.
 *
 *   node scripts/check-modes.mjs
 *
 * A real mouse and real keys arrive as trusted events with their full event
 * trail; acting on the page's own controls arrives untrusted and leaves key
 * handlers alone. That difference is the reason both ways exist, so it is
 * measured rather than assumed.
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = mkdtempSync(join(tmpdir(), 'dsh-modes-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')
const { readPage, locate, clickInDom, writeInDom } = await import('../read.js')

const page500 = `<!doctype html><meta charset="utf-8"><title>modes</title>
<button id="b" style="width:160px;height:60px">Dial</button>
<label for="f">Name</label><input id="f" style="width:240px;height:40px">
<script>
window.log = []
for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'input', 'change']) {
  addEventListener(type, (e) => window.log.push({ type, trusted: e.isTrusted }), true)
}
</script>`

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page500)
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const url = `http://127.0.0.1:${server.address().port}/`
const sidecar = new Sidecar({ profile: 'modes-check', headless: true })
let chrome = 0
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

try {
  await sidecar.launch(url)
  const page = sidecar.page
  chrome = sidecar.child?.pid ?? 0
  const evalIn = async (expression) => {
    const reply = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.value
  }
  const read = await readPage(page, { mode: 'text', maxChars: 800 })
  const byName = (want) => read.controls.find((control) => String(control.name).trim() === want)
  const button = byName('Dial')
  const field = read.controls.find((control) => String(control.kind).startsWith('input'))
  if (button === undefined || field === undefined) throw new Error(`page did not offer both controls: ${JSON.stringify(read.controls)}`)

  /* A real mouse on the button. */
  await evalIn('window.log = []')
  const spot = await locate(page, button.ref)
  await page.mouse('mouseMoved', { x: spot.x, y: spot.y })
  await page.mouse('mousePressed', { x: spot.x, y: spot.y, clickCount: 1 })
  await page.mouse('mouseReleased', { x: spot.x, y: spot.y, clickCount: 1 })
  await wait(120)
  const humanClick = await evalIn('JSON.stringify(window.log)')

  /* The page's own click on the same button. */
  await evalIn('window.log = []')
  await evalIn(clickInDom(button.ref))
  await wait(120)
  const domClick = await evalIn('JSON.stringify(window.log)')

  /* Real keys into the field. */
  await evalIn('window.log = []')
  await page.mouse('mousePressed', { x: field.x ?? 0, y: field.y ?? 0, clickCount: 1 }).catch(() => {})
  const fieldSpot = await locate(page, field.ref)
  await page.mouse('mouseMoved', { x: fieldSpot.x, y: fieldSpot.y })
  await page.mouse('mousePressed', { x: fieldSpot.x, y: fieldSpot.y, clickCount: 1 })
  await page.mouse('mouseReleased', { x: fieldSpot.x, y: fieldSpot.y, clickCount: 1 })
  await page.humanType('abc')
  await wait(150)
  const humanType = await evalIn('JSON.stringify(window.log)')

  /* The page's own input events on the same field. */
  await evalIn('window.log = []')
  await evalIn(`(() => { const reg = window.__dshRead; const hit = reg && reg.find(${field.ref}); if (hit) hit.el.value = '' })()`)
  await evalIn(writeInDom(field.ref, 'abc', { clear: true }))
  await wait(150)
  const domType = await evalIn('JSON.stringify(window.log)')
  const finalValue = await evalIn(`(() => { const reg = window.__dshRead; const hit = reg && reg.find(${field.ref}); return hit ? hit.el.value : null })()`)

  const count = (lines, type) => JSON.parse(lines).filter((line) => line.type === type).length
  const trusted = (lines) => JSON.parse(lines).filter((line) => line.trusted === true).length
  console.log(JSON.stringify({
    refs: { button: button.ref, field: field.ref },
    humanClick: { trustedEvents: trusted(humanClick), pointerdown: count(humanClick, 'pointerdown'), click: count(humanClick, 'click') },
    domClick: { trustedEvents: trusted(domClick), pointerdown: count(domClick, 'pointerdown'), click: count(domClick, 'click') },
    humanType: { trustedEvents: trusted(humanType), keydown: count(humanType, 'keydown'), input: count(humanType, 'input') },
    domType: { trustedEvents: trusted(domType), keydown: count(domType, 'keydown'), input: count(domType, 'input'), value: finalValue },
  }, null, 1))
} finally {
  try {
    await sidecar.shutdown()
  } catch {
    /* a browser that already went needs no shutdown */
  }
  if (chrome !== 0) {
    try {
      process.kill(chrome, 'SIGKILL')
    } catch {
      /* it went with the socket */
    }
  }
  await new Promise((done) => server.close(done))
  rmSync(state, { recursive: true, force: true })
}
