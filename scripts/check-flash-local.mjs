#!/usr/bin/env node
/**
 * The Flash path, measured without the network: a page served from this
 * process, its movie from the repo's own fixture, and the same bridge a site
 * would be driven through. A site being slow or rate-limiting for a minute is
 * not a plugin regression, and this check can tell the two apart.
 *
 *   node scripts/check-flash-local.mjs
 *
 * Asserts the movie painted, frames reach a viewer, and a press, a release and
 * a key each reach the plugin in well under the time a person would notice.
 * Own profile, own state directory, closed afterwards; nothing appears on the
 * desktop.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/* The looping movie, because a still one paints once and says nothing about
   whether frames follow a moving picture. */
const movie = readFileSync(join(here, '..', 'test', 'fixtures', 'loop.swf'))
const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Flash fixture</title></head>
<body style="margin:0;background:#101820">
<embed src="/tiny.swf" type="application/x-shockwave-flash" width="400" height="300">
</body></html>`

const server = createServer((request, reply) => {
  if (request.url === '/tiny.swf') {
    reply.writeHead(200, { 'content-type': 'application/x-shockwave-flash', 'content-length': movie.length })
    reply.end(movie)
    return
  }
  reply.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  reply.end(page)
})
await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
const url = `http://127.0.0.1:${server.address().port}/`

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-local-'))
const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const hash = (buffer) => createHash('sha1').update(Buffer.from(buffer ?? '')).digest('hex').slice(0, 12)

const sidecar = new Sidecar({ profile: 'flash-local', headless: false, flash: true })
let ok = false
try {
  await sidecar.launch('about:blank')
  const seen = []
  const detach = await sidecar.watch((frame) => {
    seen.push({ at: Date.now(), shape: hash(frame.jpeg), kb: Math.round(String(frame.jpeg ?? '').length * 0.75 / 1024) })
  })
  const navigatedAt = Date.now()
  await sidecar.page.navigate(url).catch(() => {})
  for (let i = 0; i < 60 && seen.length === 0; i += 1) await wait(250)
  const firstFrameMs = Date.now() - navigatedAt
  await wait(3000)
  detach()
  const gaps = seen.slice(1).map((one, index) => one.at - seen[index].at).sort((a, b) => a - b)
  const fps = gaps.length === 0 ? 0 : Math.round((1000 / (gaps[Math.floor(gaps.length / 2)] || 1000)) * 10) / 10
  const shapes = new Set(seen.map((one) => one.shape))
  const info = await fetch(`http://127.0.0.1:${sidecar.page.flashBridge}/info`, { signal: AbortSignal.timeout(1500) }).then((one) => one.json()).catch(() => ({}))
  const pressedAt = Date.now()
  await sidecar.page.mouse('mousePressed', { x: 640, y: 420 })
  const pressMs = Date.now() - pressedAt
  const releasedAt = Date.now()
  await sidecar.page.mouse('mouseReleased', { x: 640, y: 420 })
  const releaseMs = Date.now() - releasedAt
  const keyAt = Date.now()
  await sidecar.page.key('keyDown', { key: 'a', text: 'a' })
  const keyMs = Date.now() - keyAt
  await sidecar.page.key('keyUp', { key: 'a' })
  await wait(600)
  /* The same endpoint a click uses, asked directly: the plugin took the input
     rather than a path timing out on the way there. */
  const fedReply = await fetch(`http://127.0.0.1:${sidecar.page.flashBridge}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'mouseMove', x: 200, y: 150, button: 'left', clickCount: 0 }),
    signal: AbortSignal.timeout(1500),
  }).catch((error) => ({ status: 0, text: () => Promise.resolve(String(error?.message ?? error)) }))
  const fedStatus = fedReply.status
  const fedText = await fedReply.text().catch(() => '')
  const fed = { ok: fedText.includes('"ok":true') }
  const frameKB = seen.length === 0 ? 0 : Math.round(seen.reduce((sum, one) => sum + one.kb, 0) / seen.length)
  /* The fixture movie is not a game: what is asserted here is that the movie
     painted, that frames reached a viewer, and that input arrived without a
     detour through the debugging protocol. Frame rate on moving pictures is
     measured by check-flash-mirror against a real site. */
  ok = Number(info.painted ?? 0) > 1 && seen.length >= 3 && shapes.size >= 2 && firstFrameMs < 1500 && pressMs < 40 && releaseMs < 40 && keyMs < 40 && fed.ok === true && frameKB > 0
  console.log(JSON.stringify({ url, firstFrameMs, frames: seen.length, fps, shapes: shapes.size, frameKB, painted: info.painted ?? 0, pressMs, releaseMs, keyMs, fedStatus, fedText: fedText.slice(0, 80), fed: fed.ok === true, ok }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 160) }))
} finally {
  await sidecar.shutdown().catch(() => {})
  server.close()
}
process.exitCode = ok ? 0 : 1
