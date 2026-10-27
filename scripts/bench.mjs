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
import { readPage, renderPage, covering } from '../read.js?v=1'
import { diffRead } from '../tools.js?v=1'
import { sidecarTools } from '../tools.js?v=1'

/**
 * One plain control, and the same page under an overlay: `covered` is a cookie
 * banner whose own button says Accept, `guarded` is a modal that says delete.
 * @param {string} kind - plain, covered or guarded.
 */
function domePage(kind) {
  const banner = kind === 'covered'
    ? '<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">We use cookies to remember you. <button onclick="document.getElementById(\'banner\').remove()">Accept</button></div></div>'
    : kind === 'guarded'
      ? '<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">Delete this account? <button onclick="document.getElementById(\'banner\').remove()">Delete forever</button></div></div>'
      : ''
  return `<!doctype html><html><body style="font:16px system-ui;padding:24px"><h1>Cover</h1><button id="t" onclick="document.title='hit'">Target</button>${banner}</body></html>`
}

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
  /* How long after a change the frame is ready for the column: capture, JPEG,
     and the CDP hop. This is the part of latency that is ours to lose. */
  await sidecar.page.navigate('data:text/html,<body style="font:40px system-ui"><h1>still</h1></body>')
  await wait(400)
  const delays = []
  let pendingAt = 0
  const sink = () => { if (pendingAt > 0) { delays.push(Date.now() - pendingAt); pendingAt = 0 } }
  sidecar.page.frames.add(sink)
  for (let i = 0; i < 12; i += 1) {
    pendingAt = Date.now()
    await sidecar.page.cdp.send('Runtime.evaluate', { expression: `document.body.style.background = 'hsl(${String(i * 30)} 60% 80%)'` })
    const deadline = Date.now() + 1500
    while (pendingAt > 0 && Date.now() < deadline) await wait(10)
    await wait(60)
  }
  sidecar.page.frames.delete(sink)
  delays.sort((left, right) => left - right)
  emit('mirror-delay', { samples: delays.length, medianMs: delays[Math.floor(delays.length / 2)] ?? -1, maxMs: delays.at(-1) ?? -1 })

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
    const before = await readPage(sidecar.page, { mode: 'text' })
    await sidecar.page.cdp.send('Runtime.evaluate', { expression: `(() => { const field = document.querySelector('input'); if (field) field.value = 'typed by the agent'; return true })()` })
    const after = await readPage(sidecar.page, { mode: 'text' })
    const diff = diffRead(before, after, { maxChars: 2000 })
    emit('read-changed', { page: name, chars: diff.length, approxTokens: Math.round(diff.length / 3.4), wholeChars: renderPage(after, { maxChars: 4600 }).length })
  }
  /* What the overlay probe costs: nothing on an uncovered control, one extra
     page-side look plus the banner's own click when something is in the way. */
  const probeTimes = []
  for (let i = 0; i < 5; i += 1) {
    const at = Date.now()
    await sidecar.page.cdp.send('Runtime.evaluate', { expression: covering(1), returnByValue: true })
    probeTimes.push(Date.now() - at)
    await wait(60)
  }
  probeTimes.sort((left, right) => left - right)
  emit('cover-probe', { samples: probeTimes.length, medianMs: probeTimes[2], maxMs: probeTimes[4] })

  const clickTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_click')
  for (const label of ['plain', 'covered', 'guarded']) {
    const html = domePage(label)
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const url = `http://127.0.0.1:${String(server.address().port)}/`
    const times = []
    let cleared = false
    for (let i = 0; i < 3; i += 1) {
      await sidecar.page.navigate(url)
      await wait(250)
      const read = await readPage(sidecar.page, { mode: 'text', maxChars: 2000 })
      const target = read.controls.find((control) => control.name === 'Target')
      const at = Date.now()
      const said = String((await clickTool.execute({ ref: target.ref })).text)
      times.push(Date.now() - at)
      cleared = said.includes('then the control')
    }
    times.sort((left, right) => left - right)
    emit('cover-click', { page: label, medianMs: times[1], runs: times.length, cleared })
    server.close()
  }

  const doTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_do')
  for (const label of ['plain', 'covered']) {
    const html = domePage(label)
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const url = `http://127.0.0.1:${String(server.address().port)}/`
    const times = []
    let through = false
    for (let i = 0; i < 3; i += 1) {
      await sidecar.page.navigate(url)
      await wait(250)
      const at = Date.now()
      const said = String((await doTool.execute({ steps: [{ tap: 'Target' }], read: 'none' })).text)
      times.push(Date.now() - at)
      through = said.includes('after Accept on a banner')
    }
    times.sort((left, right) => left - right)
    emit('do-step', { page: label, medianMs: times[1], runs: times.length, cleared: through })
    server.close()
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
  /* A hand on the mirror: the refusal is one in-process check (no browser
     roundtrip), a read still goes through, and resume costs what a click costs. */
  const holdState = { last: undefined }
  const holdTools = sidecarTools(sidecar, holdState)
  await sidecar.page.navigate(servers.dense.url)
  await wait(200)
  const holdReadAt = Date.now()
  await holdTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 600 })
  const holdReadMs = Date.now() - holdReadAt
  const holdTarget = holdState.refs.find((control) => control.kind === 'button')
  sidecar.humanUse({ kind: 'click', x: 40, y: 60 })
  const holdAt = Date.now()
  const held = String((await holdTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: holdTarget.ref })).text)
  const holdMs = Date.now() - holdAt
  const readDuringHoldAt = Date.now()
  await holdTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 200 })
  const readDuringHoldMs = Date.now() - readDuringHoldAt
  await holdTools.find((tool) => tool.name === 'sidecar_resume').execute({})
  const resumedAt = Date.now()
  const resumed = String((await holdTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: holdTarget.ref })).text)
  emit('hold', {
    refusalMs: holdMs,
    refused: held.includes('nothing was sent'),
    readMs: holdReadMs,
    readDuringHoldMs,
    resumeClickMs: Date.now() - resumedAt,
    resumed: resumed.startsWith('ok '),
  })
  if (live) {
    await sidecar.page.navigate('https://example.com/')
    await wait(300)
    const at = Date.now()
    const read = await readPage(sidecar.page)
    emit('live-read', { ms: Date.now() - at, title: read.title, tokens: Math.round(renderPage(read).length / 3.4) })
  }
  /* A crash costs one detection window plus a fresh tab, measured through the
     tool path the model actually takes. */
  await sidecar.page.navigate(servers.dense.url)
  const crashPage = sidecar.page
  await Promise.race([crashPage.cdp.send('Page.crash').catch(() => {}), wait(1500)])
  await wait(500)
  const backAt = Date.now()
  const fresh = await sidecar.ensure()
  const back = await readPage(fresh, { mode: 'text' })
  emit('crash-recovery', { ms: Date.now() - backAt, urlMatched: String(back.title).toLowerCase().includes('dense'), title: back.title })
  await sidecar.shutdown()
  for (const row of Object.values(servers)) row.server.close()
}

await main()
