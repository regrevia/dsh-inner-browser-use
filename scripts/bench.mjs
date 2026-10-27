#!/usr/bin/env node
/**
 * Measured numbers for the mirror and the read model, on pages that never
 * change. Run it after any change to sidecar.js, read.js or the tool surface:
 *
 *   node scripts/bench.mjs            # local pages, headless
 *   node scripts/bench.mjs --live     # add a real site
 *
 * Every number is one JSON line, so a run can be diffed against the last.
 */
import { createServer } from 'node:http'
import { Sidecar } from '../sidecar.js?v=1'
import { readPage, renderPage } from '../read.js?v=1'

/** A page worth measuring: one of controls, one of words, one nearly empty. */
function page(name) {
  const ticker = '<span id="t" style="position:fixed;top:0;left:0">0</span><script>let n=0;const t=document.getElementById("t");(function loop(){t.textContent=String(++n);requestAnimationFrame(loop)})()</script>'
  if (name === 'text') {
    const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(8)
    const body = Array.from({ length: 60 }, (_, i) => `<p>${i + 1}. ${paragraph}</p>`).join('')
    return `<!doctype html><html><head><title>text page</title></head><body><main><h1>Reading</h1>${body}</main>${ticker}</body></html>`
  }
  if (name === 'light') {
    return `<!doctype html><html><head><title>light page</title></head><body><main><h1>Hello</h1><p>A short page.</p></main>${ticker}</body></html>`
  }
  const links = Array.from({ length: 120 }, (_, i) => `<li><a href="#item-${i + 1}">Item ${i + 1}</a></li>`).join('')
  const inputs = Array.from({ length: 20 }, (_, i) => `<label>Field ${i + 1}<input name="f${i + 1}" placeholder="value ${i + 1}"></label>`).join('')
  const buttons = '<button id="go">Go</button><button id="stop">Stop</button>'
  return `<!doctype html><html><head><title>dense page</title></head><body><main><h1>Dense</h1>${inputs}<ul>${links}</ul>${buttons}${ticker}</main></body></html>`
}

/** @param {string} label - what is measured. @param {Record<string, unknown>} row - numbers. */
function emit(label, row) {
  console.log(JSON.stringify({ label, ...row }))
}

/** @param {number} ms - how long. */
function wait(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}

async function main() {
  const live = process.argv.includes('--live')
  /** @type {Record<string, {server: import('node:http').Server, url: string}>} */
  const servers = {}
  for (const name of ['dense', 'text', 'light']) {
    const html = page(name)
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const address = server.address()
    servers[name] = { server, url: `http://127.0.0.1:${String(address.port)}/` }
  }
  const sidecar = new Sidecar({ profile: 'bench' })
  const launchAt = Date.now()
  await sidecar.launch(servers.dense.url)
  /* First frame is the number a person feels when the tab opens. */
  const firstFrame = await (async () => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (sidecar.page.seq > 0) return Date.now() - launchAt
      await wait(40)
    }
    return -1
  })()
  emit('launch', { ms: Date.now() - launchAt, firstFrameMs: firstFrame })
  const before = { seq: sidecar.page.seq, bytes: sidecar.page.bytes }
  const streamAt = Date.now()
  await wait(3000)
  const elapsed = Date.now() - streamAt
  const frames = sidecar.page.seq - before.seq
  emit('stream', {
    seconds: elapsed / 1000,
    fps: Math.round((frames / elapsed) * 1000 * 10) / 10,
    frameKB: frames === 0 ? 0 : Math.round((sidecar.page.bytes - before.bytes) / frames / 1024),
  })
  for (const name of ['dense', 'text', 'light']) {
    await sidecar.page.navigate(servers[name].url)
    await wait(300)
    for (const mode of name === 'dense' ? ['text', 'links', 'forms', 'full'] : ['text']) {
      const at = Date.now()
      const read = await readPage(sidecar.page, { mode })
      const rendered = renderPage(read, { mode, maxChars: 4600 })
      emit('read', { page: name, mode, ms: Date.now() - at, controls: read.controls.length, chars: rendered.length, approxTokens: Math.round(rendered.length / 3.4) })
    }
    const firstAt = Date.now()
    const first = renderPage(await readPage(sidecar.page), { mode: 'text', maxChars: 4600 })
    const firstMs = Date.now() - firstAt
    const againAt = Date.now()
    const again = renderPage(await readPage(sidecar.page), { mode: 'text', maxChars: 4600 })
    const controlLines = (text) => text.split('\n').filter((line) => /^\d+ \[/.test(line)).join('\n')
    emit('read-repeat', { page: name, firstMs, againMs: Date.now() - againAt, stable: controlLines(first) === controlLines(again) })
  }
  await sidecar.page.navigate(servers.dense.url)
  await wait(200)
  const clickAt = Date.now()
  await sidecar.page.mouse('mousePressed', { x: 200, y: 380 })
  await sidecar.page.mouse('mouseReleased', { x: 200, y: 380 })
  emit('click', { ms: Date.now() - clickAt })
  const keyAt = Date.now()
  await sidecar.page.key('keyDown', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a' })
  await sidecar.page.key('keyUp', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 })
  emit('key', { ms: Date.now() - keyAt })
  const shotAt = Date.now()
  const shot = await sidecar.page.screenshot()
  emit('shot', { ms: Date.now() - shotAt, kb: Math.round(String(shot).length / 1024 / 0.75) })
  if (live) {
    await sidecar.page.navigate('https://example.com/')
    await wait(300)
    const at = Date.now()
    const read = await readPage(sidecar.page)
    emit('live-read', { ms: Date.now() - at, title: read.title, tokens: Math.round(renderPage(read).length / 3.4) })
  }
  await sidecar.shutdown()
  for (const row of Object.values(servers)) row.server.close()
}

await main()
