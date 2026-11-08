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
import { pathToFileURL } from 'node:url'
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
window.__dbl = []
addEventListener('dblclick', (event) => {
  window.__dbl.push({ x: event.clientX, y: event.clientY, detail: event.detail, target: (event.target && event.target.id) || '' })
}, true)
addEventListener('mousemove', (event) => {
  window.__moves.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, target: (event.target && event.target.id) || '' })
}, true)
addEventListener('mousedown', (event) => {
  window.__presses.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, target: (event.target && event.target.id) || '' })
}, true)
addEventListener('wheel', (event) => {
  window.__wheels.push({ x: event.clientX, y: event.clientY, buttons: event.buttons, button: event.button, dy: Math.round(event.deltaY) })
}, true)
window.__reset = () => { window.__moves = []; window.__wheels = []; window.__presses = []; window.__dbl = []; return true }
</script>`

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** The size a JPEG carries, read from its own header rather than a decoder. */
function jpegSize(jpeg) {
  const bytes = Buffer.from(jpeg, 'base64')
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) { at += 1; continue }
    const marker = bytes[at + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: bytes.readUInt16BE(at + 7), h: bytes.readUInt16BE(at + 5) }
    }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return null
}
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
  /* The browser's own report is the size to trust: ask until it agrees with
     the request instead of assuming the override landed before the cast. */
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await page.remeasure()
    if (page.view?.width === WIDE && page.view?.height === TALL) break
    await wait(100)
  }
  await page.cast()
  const settled = Date.now() + 6000
  while (Date.now() < settled) {
    await wait(150)
    if (Number(page.seq ?? 0) > 0) break
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

/** A screen that scales by 150% is how Windows usually arrives. */
async function scaled(page) {
  const width = 2000
  const height = 1200
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1.5, mobile: false })
  /* The scale the display reports is what caps the cast: ask for it until the
     browser agrees, because a measure taken mid-resize says 1 and the picture
     then arrives at the page's size instead of the display's. */
  const scaleDeadline = Date.now() + 4000
  while (Date.now() < scaleDeadline) {
    await page.remeasure()
    if (Math.abs(Number(page.dpr ?? 0) - 1.5) < 0.01) break
    await wait(100)
  }
  await page.stopCast()
  let pictureFrame = null
  let hand = null
  page.frames.add((message) => { if (typeof message.jpeg === 'string') pictureFrame = message })
  page.pointerSinks.add((message) => { hand = message })
  await page.cast()
  const densityDeadline = Date.now() + 6000
  while (Date.now() < densityDeadline) {
    await wait(150)
    const size = pictureFrame === null ? null : jpegSize(pictureFrame.jpeg)
    if (size !== null && Math.abs(size.w - Math.round(page.view.width * Number(page.dpr ?? 1))) <= 2) break
  }
  await run(page, 'window.__reset()')
  /* The page says where it thinks it is; a picture at a different scale must
     still land on the page's own pixel, not one and a half of them. */
  const at = await run(page, 'JSON.stringify({ inner: [innerWidth, innerHeight], dpr: devicePixelRatio, at: [window.__moves.length] })')
  /* Some Chrome builds take input coordinates in device pixels while a
     device-metrics override is active, and divide them by the scale on the way
     in; others take them in CSS pixels. Which one this browser does is not the
     pane's business, so it is measured once, and every point below is sent in
     the unit this browser actually reads. */
  await run(page, 'window.__reset()')
  /* Read the page's own report of where a point landed. Each send starts from
     an empty record, so the last entry is the answer to that send alone. */
  const lastSeen = async () => JSON.parse(await run(page, 'JSON.stringify(window.__moves)')).at(-1)
  /* Some Chrome builds take input coordinates in device pixels while a
     device-metrics override is active and divide them by the scale on the way
     in; others take CSS pixels, and a few change their mind between two events
     of the same drag. So the unit is not assumed: a point is sent, the page is
     asked where it landed, and a point that landed elsewhere is sent again in
     whatever unit the page just answered in. */
  let factor = 1
  const send = async (point) => {
    await run(page, 'window.__reset()')
    let seen = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      /* A browser that has just resized can swallow the first move, and some
         builds skip a move over a point the pointer is already on. Both look
         like silence, so every retry steps away from the point first: a move
         to a different place always produces an event. */
      if (attempt > 0) {
        await page.mouse('mouseMoved', { x: Math.round(13 * factor), y: Math.round(17 * factor) })
        await wait(60)
        await run(page, 'window.__reset()')
      }
      const sent = { x: Math.round(point.x * factor), y: Math.round(point.y * factor) }
      await page.mouse('mouseMoved', sent)
      await wait(140 + attempt * 90)
      seen = await lastSeen()
      if (seen === undefined || seen === null) continue
      if (Math.abs(seen.x - point.x) <= 1 && Math.abs(seen.y - point.y) <= 1) return seen
      if (seen.x > 0) factor = sent.x / seen.x
    }
    return seen
  }
  const sentAt = { x: 100, y: 100 }
  const rawSeen = await (async () => {
    await page.mouse('mouseMoved', sentAt)
    await wait(180)
    return lastSeen()
  })()
  const units = [1, 1.25, 1.5, 2, 0.75, 2 / 3]
  const unit = rawSeen === undefined || rawSeen === null || rawSeen.x <= 0 ? 0 : sentAt.x / rawSeen.x
  check('a point sent to the page is counted in a unit this browser uses', units.some((one) => Math.abs(unit - one) <= one * 0.04),
    `a point at 100,100 arrived at ${JSON.stringify(rawSeen ?? null)}`)
  if (unit > 0) factor = unit
  const middle = aimAt({ fx: 0.5, fy: 0.5, fw: width, fh: height, pw: page.view.width, ph: page.view.height }, page.view)
  const seen = await send(middle)
  check('a scaled screen resolves the middle to the page, not to the device', seen !== undefined && seen !== null && Math.abs(seen.x - 1000) <= 2 && Math.abs(seen.y - 600) <= 2,
    `the page saw ${JSON.stringify(seen ?? null)} instead of 1000,600 (page reports ${at}, input unit ${Math.round(unit * 1000) / 1000})`)
  /* The last page pixel is pinned by arithmetic, and a point two pixels inside
     it is delivered just below: at 150% the extreme edge is a point some Chrome
     builds decline to report at all (the window's last device pixel is not the
     page's last pixel), so the probe proves the corner resolves to the last
     pixel and that a point at the corner of the page reaches it — not that the
     browser echoes the very last pixel of a scaled window. */
  const corner = aimAt({ fx: 1, fy: 1, fw: width, fh: height, pw: page.view.width, ph: page.view.height }, page.view)
  check('a scaled screen resolves the far corner to the last page pixel',
    corner !== null && corner.x === width - 1 && corner.y === height - 1,
    `the corner resolved to ${JSON.stringify(corner ?? null)} on ${String(width)}x${String(height)} (page ${String(at)})`)

  const nearCornerSeen = await send({ x: width - 3, y: height - 3 })
  check('a scaled screen lands a near-corner point on that page pixel',
    nearCornerSeen !== undefined && nearCornerSeen !== null && Math.abs(nearCornerSeen.x - (width - 3)) <= 1 && Math.abs(nearCornerSeen.y - (height - 3)) <= 1,
    `the near corner resolved to ${JSON.stringify(nearCornerSeen ?? null)} on ${String(page.view.width)}x${String(page.view.height)} (page ${String(at)}, factor ${Math.round(factor * 100) / 100})`)

  /* The arrow the pane draws comes from this message: it is in page points,
     while the picture beside it is in device pixels. Mixing the two drew the
     hand a third of the way short of the click on a 150% display. */
  page.movePointer({ x: Math.round(width / 2), y: Math.round(height / 2) })
  await wait(300)
  const pixels = pictureFrame === null ? null : jpegSize(pictureFrame.jpeg)
  const points = Number(hand?.w ?? 0)
  const density = points > 0 && pixels !== null ? pixels.w / points : 0
  /* A frame may be capped by the encoder, so its density is not fixed; what
     must hold is that the header counts the pixels the JPEG really has and
     that the picture is never coarser than the page. */
  /* The header counts page points on purpose: those are the units the pane
     and the page both use, and the density of the picture may differ from
     them. What must hold is that header and hand speak the same unit. */
  check('a scaled frame counts the page points the hand counts',
    points > 0 && Math.abs(Number(pictureFrame?.w ?? 0) - points) <= 1 && Math.abs(Number(pictureFrame?.h ?? 0) - Number(hand?.h ?? 0)) <= 1,
    `the header said ${String(pictureFrame?.w)}x${String(pictureFrame?.h)} and the hand counted ${points}x${String(hand?.h)}`)
  check('a scaled picture is not coarser than the page it shows',
    density >= 1, `picture ${String(pixels?.w ?? null)} px for a ${String(points)} point page`)
  check('the hand is measured in page points, not picture pixels',
    hand?.pointer !== undefined && points > 0 && Math.abs(Number(hand?.pointer?.x) / points - 0.5) < 0.01,
    `the hand said ${JSON.stringify(hand?.pointer ?? null)} in a ${String(points)} wide space`)
  return { at: JSON.parse(at), corner, hand: { points, pixels: pixels?.w ?? null, density, pointer: hand?.pointer ?? null } }
}

/** The pane sends one ask per half of a double; the page has to see a double. */
async function doubleClicked(page) {
  await run(page, 'window.__reset()')
  const spot = point(page, 0.5, 0.5, WIDE, TALL)
  /* Exactly the body the pane sends: a click, then a click that says it is the
     second half. Two single clicks would leave the page's double unopened. */
  await page.mouse('mouseMoved', spot)
  await page.mouse('mousePressed', { x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await page.mouse('mouseReleased', { x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await wait(60)
  await page.mouse('mousePressed', { x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
  await page.mouse('mouseReleased', { x: spot.x, y: spot.y, button: 'left', clickCount: 2 })
  await wait(300)
  const seen = JSON.parse(await run(page, 'JSON.stringify(window.__dbl)'))
  check('two quick clicks are one double click', seen.length === 1 && seen[0].detail === 2,
    `the page saw ${String(seen.length)} double clicks ${JSON.stringify(seen)}`)
  check('the double click landed where the hand was', seen[0] !== undefined && Math.abs(seen[0].x - spot.x) <= 1 && Math.abs(seen[0].y - spot.y) <= 1,
    `the page saw ${JSON.stringify(seen[0] ?? null)} at ${String(spot.x)},${String(spot.y)}`)
  return { doubles: seen.length }
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
    summary.dbl = await doubleClicked(page)
    const zoom = await scaled(page)
    summary.scaled = zoom.at
    summary.scaledCorner = zoom.corner ?? null
    summary.scaledHand = zoom.hand ?? null
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
    console.log(`pointer ${summary.matched}/${summary.checked} · view ${String(summary.frame?.w)}x${String(summary.frame?.h)} · map ${String(summary.mapMs)} ms · ${summary.drag.moves} moves / ${summary.drag.wheels} wheel / ${summary.dbl.doubles} double · ${String(summary.ms)} ms total`)
  }
  process.exitCode = summary.ok === true ? 0 : 1
}

/* The entry guard has to survive a Windows path: `file://C:\…` is not a URL,
   and a script that never runs still exits 0, which is a green job proving
   nothing. */
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
