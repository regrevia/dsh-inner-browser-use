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
/** A page that only acts when it is double-clicked, the way a file list does. */
function dblPage() {
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px/1.4 system-ui;padding:24px">
<h1>Files</h1>
<button id="go" style="padding:10px 18px">Open item</button>
<script>
window.clicks = 0; window.doubles = 0
const go = document.getElementById('go')
go.addEventListener('click', () => { window.clicks += 1 })
go.addEventListener('dblclick', () => { window.doubles += 1 })
</script>`
}

function domePage(kind) {
  const banner = kind === 'covered'
    ? '<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">We use cookies to remember you. <button onclick="document.getElementById(\'banner\').remove()">Accept</button></div></div>'
    : kind === 'guarded'
      ? '<div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">Delete this account? <button onclick="document.getElementById(\'banner\').remove()">Delete forever</button></div></div>'
      : ''
  return `<!doctype html><html><body style="font:16px system-ui;padding:24px"><h1>Cover</h1><button id="t" onclick="document.title='hit'">Target</button>${banner}</body></html>`
}

/** A page worth measuring: one of controls, one of words, one nearly empty. */
export function page(name) {
  const ticker = '<span id="t" style="position:fixed;top:0;left:0">0</span><script>let n=0;const t=document.getElementById("t");(function loop(){t.textContent=String(++n);requestAnimationFrame(loop)})()</script>'
  if (name === 'text') {
    const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(8)
    const body = Array.from({ length: 60 }, (_, i) => `<p>${i + 1}. ${paragraph}</p>`).join('')
    return `<!doctype html><html><head><title>text page</title></head><body><main><h1>Reading</h1>${body}</main>${ticker}</body></html>`
  }
  if (name === 'game') {
    return `<!doctype html><html><head><title>game page</title></head><body style="margin:0;background:#111">
<canvas id="c" width="640" height="400"></canvas>
<script>
window.__log=[]
const at=()=>Math.round(performance.now())
addEventListener('keydown',(e)=>{window.__log.push({t:'down',k:e.key,c:at()})})
addEventListener('keyup',(e)=>{window.__log.push({t:'up',k:e.key,c:at()})})
addEventListener('pointerdown',(e)=>{window.__log.push({t:'pdown',c:at()})})
addEventListener('pointerup',(e)=>{window.__log.push({t:'pup',c:at()})})
const c=document.getElementById('c'),x=c.getContext('2d');let n=0
;(function loop(){n+=1;x.fillStyle='#111';x.fillRect(0,0,640,400);x.fillStyle='#2bd';x.fillRect((n*3)%600,150,40,40);requestAnimationFrame(loop)})()
</script></body></html>`
  }
  if (name === 'popup') {
    return `<!doctype html><html><head><title>popup page</title></head><body><main><h1>Popup</h1>
<button id="sync">Open now</button><button id="lazy">Open later</button>
<script>document.getElementById('sync').onclick=()=>window.open('/child','_blank');document.getElementById('lazy').onclick=()=>setTimeout(()=>window.open('/child','_blank'),80)</script>
</main></body></html>`
  }
  if (name === 'hard') {
    return `<!doctype html><html><head><title>hard page</title></head><body style="margin:0;font:16px system-ui;padding:16px">
<div id="panel" style="height:80px;overflow:auto;border:1px solid #ccc"><div style="height:600px">spacer</div><button id="deep">Deep button</button></div>
<label>When <input type="date" id="when"></label>
<label>Note <input id="note"></label>
<select id="pick"><option>Alpha</option><option>Beta</option></select>
<script>
document.getElementById('deep').onclick = () => { document.title = 'deep-' + document.getElementById('panel').scrollTop }
document.getElementById('when').onchange = (e) => { document.title = 'date-' + e.target.value }
document.getElementById('pick').onchange = (e) => { document.title = 'pick-' + e.target.value }
</script></body></html>`
  }
  if (name === 'list') {
    /* A listing page is mostly repetition: a header menu repeated in the foot,
       the same button on every card. Reading it should cost a line per idea. */
    const menu = Array.from({ length: 8 }, (_, i) => `<a href="/n${i}">Home</a><a href="/c${i}">Catalog</a>`).join('')
    const cards = Array.from({ length: 30 }, (_, i) => `<div class="card"><a href="/p${i}">Product ${i}</a><button>Add to cart</button><span>$ ${i}.99</span></div>`).join('')
    return `<!doctype html><html><head><title>list page</title></head><body><header>${menu}</header><main>${cards}</main><footer>${menu}</footer>${ticker}</body></html>`
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

/** Latency ceilings a release must stay under, checked at the end. */
const LIMITS = { click: 220, 'cover-click': 240, 'double-click': 300, 'do-step': 240, 'do-session': 280, 'crash-recovery': 2600, 'mirror-fps': 36, 'hard-forms': 240, type: 200 }
const tried = []
/** @param {string} name - a key of LIMITS. @param {number} ms - measured. */
function budget(name, ms) {
  tried.push({ name, ms, limit: LIMITS[name] })
}

/** @param {number} ms - how long. */
function wait(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}

async function main() {
  const live = process.argv.includes('--live')
  /** @type {Record<string, {server: import('node:http').Server, url: string}>} */
  const servers = {}
  for (const name of ['dense', 'text', 'list', 'light', 'game', 'popup', 'hard']) {
    const html = page(name)
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(String(req.url ?? '/').startsWith('/child') ? '<!doctype html><title>child page</title><h1>Child</h1>' : html)
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
  /* A 60 fps page must not cost a pane 60 frames a second: the downlink is
     paced, and this measures what a viewer actually receives. */
  await sidecar.page.navigate(servers.game.url)
  await wait(400)
  let watched = 0
  let watchedBytes = 0
  const fan = (frame) => { watched += 1; watchedBytes += String(frame.jpeg ?? '').length }
  sidecar.page.frames.add(fan)
  const pacedAt = Date.now()
  await wait(3000)
  const pacedMs = Date.now() - pacedAt
  sidecar.page.frames.delete(fan)
  const fps = Math.round((watched / pacedMs) * 1000 * 10) / 10
  emit('mirror-fps', {
    fps,
    frameKB: watched === 0 ? 0 : Math.round(watchedBytes / watched / 1024),
    bandwidthKBps: Math.round(watchedBytes / (pacedMs / 1000) / 1024),
  })
  budget('mirror-fps', fps)
  /* The same page while a person moves the mouse: every frame goes out. */
  let busyCount = 0
  const busyFan = () => { busyCount += 1 }
  sidecar.page.frames.add(busyFan)
  const busyAt = Date.now()
  const keeping = setInterval(() => {
    sidecar.page.movePointer({ x: 200 + (busyCount % 40), y: 300 })
  }, 120)
  await wait(2000)
  clearInterval(keeping)
  const busyMs = Date.now() - busyAt
  sidecar.page.frames.delete(busyFan)
  emit('mirror-fps-busy', { fps: Math.round((busyCount / busyMs) * 1000 * 10) / 10 })

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

  for (const name of ['dense', 'text', 'list', 'light', 'game']) {
    await sidecar.page.navigate(servers[name].url)
    await wait(300)
    for (const mode of name === 'dense' || name === 'list' ? ['text', 'links', 'forms', 'full'] : ['text']) {
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

  const clickTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_click')
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
    if (label !== 'guarded') budget('cover-click', times[1])
    server.close()
  }

  /* A double-click is one call and two presses: a page that only acts on
     dblclick used to need two clicks, and the second one could land after the
     first had already changed the page. */
  {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(dblPage())
    })
    await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
    const url = `http://127.0.0.1:${String(server.address().port)}/`
    const times = []
    let seen = {}
    for (let i = 0; i < 3; i += 1) {
      await sidecar.page.navigate(url)
      await wait(200)
      const at = Date.now()
      await clickTool.execute({ text: 'Open item', double: true })
      times.push(Date.now() - at)
      const counts = await sidecar.page.cdp.send('Runtime.evaluate', { expression: '({ clicks: window.clicks, doubles: window.doubles })', returnByValue: true })
      seen = counts?.result?.value ?? {}
    }
    times.sort((left, right) => left - right)
    emit('double-click', { medianMs: times[1], ...seen })
    budget('double-click', Number(seen.doubles ?? 0) === 0 ? 99_999 : times[1])
    server.close()
  }

  /* Where a plain click spends its milliseconds: this is the window that waits
     for a popup the page never opens. Measured on its own so the cost stays
     visible instead of hiding inside the click number. */
  {
    const times = []
    for (let i = 0; i < 3; i += 1) {
      await sidecar.page.navigate(servers.light.url)
      const at = Date.now()
      const followed = await sidecar.page.adoptOpened()
      times.push(Date.now() - at)
      if (followed !== '') emit('popup-wait', { warned: 'a popup appeared on a page that opens none' })
    }
    emit('popup-wait', { medianMs: times[1], runs: times })
  }

  /* A click that opens a tab: followed when it opens at once, and still followed
     when the page opens it from its own timer after the call has answered. */
  {
    const clickAt = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_click')
    const rows = []
    for (const [text, late] of [['Open now', false], ['Open later', true]]) {
      await sidecar.page.navigate(servers.popup.url)
      const at = Date.now()
      const said = String((await clickAt.execute({ text })).text)
      const ms = Date.now() - at
      await wait(late ? 900 : 200)
      const landed = String(sidecar.page.url ?? '') === `${servers.popup.url}child`
      rows.push({ text, ms, followedAtOnce: landed && said.includes('/child'), landed })
    }
    emit('popup-click', { rows, ok: rows.every((row) => row.landed) })
    if (!rows.every((row) => row.landed)) budget('popup-click', 99_999)
  }

  const doTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_do')
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
    budget('do-step', times[1])
    server.close()
  }
  await sidecar.page.navigate(servers.dense.url)
  await wait(200)
  const clickAt = Date.now()
  await sidecar.page.mouse('mousePressed', { x: 200, y: 380 })
  await sidecar.page.mouse('mouseReleased', { x: 200, y: 380 })
  emit('click', { ms: Date.now() - clickAt })
  budget('click', Date.now() - clickAt)
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
  await holdTools.find((tool) => tool.name === 'browser_view').execute({ mode: 'text', max_chars: 600 })
  const holdReadMs = Date.now() - holdReadAt
  if (!Array.isArray(holdState.refs) || holdState.refs.length === 0) {
    emit('hold', { skipped: 'no controls after the read', refs: Array.isArray(holdState.refs) ? 0 : -1 })
  }
  const holdTarget = (holdState.refs ?? []).find((control) => ['btn', 'button'].includes(control.kind)) ?? { ref: 1 }
  sidecar.humanUse({ kind: 'click', x: 40, y: 60 })
  const holdAt = Date.now()
  const held = String((await holdTools.find((tool) => tool.name === 'browser_click').execute({ ref: holdTarget.ref })).text)
  const holdMs = Date.now() - holdAt
  const readDuringHoldAt = Date.now()
  await holdTools.find((tool) => tool.name === 'browser_view').execute({ mode: 'text', max_chars: 200 })
  const readDuringHoldMs = Date.now() - readDuringHoldAt
  await holdTools.find((tool) => tool.name === 'browser_resume').execute({})
  const resumedAt = Date.now()
  const resumed = String((await holdTools.find((tool) => tool.name === 'browser_click').execute({ ref: holdTarget.ref })).text)
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
  /* A web game is the hardest input there is: a key that must stay down, two at
     once for a diagonal, and a canvas that changes every frame. The page itself
     records when each event arrived, so this measures delivery, not intent. */
  await sidecar.page.navigate(servers.game.url)
  await wait(300)
  const readLog = async () => {
    const reply = await sidecar.page.cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__log || [])', returnByValue: true })
    return JSON.parse(String(reply?.result?.value ?? '[]'))
  }
  const keyTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_key')
  const downAt = Date.now()
  await keyTool.execute({ key: 'd', hold_ms: 300, read: false })
  const delivered = Date.now() - downAt
  const log = await readLog()
  const went = log.filter((row) => row.t === 'down').map((row) => row.c)
  const came = log.filter((row) => row.t === 'up').map((row) => row.c)
  const heldFor = went.length > 0 && came.length > 0 ? came[0] - went[0] : 0
  await keyTool.execute({ key: 'ArrowLeft+ArrowUp', hold_ms: 200, read: false })
  const chordLog = await readLog()
  const chordDown = chordLog.filter((row) => row.t === 'down').map((row) => row.k)
  const chordUp = chordLog.filter((row) => row.t === 'up').map((row) => row.k)
  const pointerTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_click')
  await pointerTool.execute({ x: 200, y: 200, hold_ms: 200, read: false })
  const pointerLog = await readLog()
  const pointerDown = pointerLog.find((row) => row.t === 'pdown')
  const pointerUp = pointerLog.find((row) => row.t === 'pup')
  emit('game-input', {
    holdRoundTripMs: delivered,
    pageSawDown: went.length > 0,
    heldMs: heldFor,
    chordTogether: chordDown.includes('ArrowLeft') && chordDown.includes('ArrowUp'),
    chordReleased: chordUp.includes('ArrowLeft') && chordUp.includes('ArrowUp'),
    pointerHeldMs: pointerDown !== undefined && pointerUp !== undefined ? pointerUp.c - pointerDown.c : -1,
  })
  /* The form controls people wrap in a page are where a browser agent usually
     misses: a button inside a scrolling panel, a date input, a dropdown with no
     label. Each has to say what it did, and the page has to agree. */
  await sidecar.page.navigate(servers.hard.url)
  await wait(200)
  const hardTools = sidecarTools(sidecar, { last: undefined })
  const pickTool = (name) => hardTools.find((tool) => tool.name === name)
  const peek = async () => {
    const said = await pickTool('browser_eval').execute({ code: 'document.title' })
    return String(said?.text ?? '')
  }
  const formsAt = Date.now()
  await pickTool('browser_view').execute({})
  const deepAt = Date.now()
  await pickTool('browser_click').execute({ text: 'Deep button' })
  const deepMs = Date.now() - deepAt
  const deepSaid = await peek()
  const dateAt = Date.now()
  await pickTool('browser_type').execute({ text: '2026-03-04', field: 'When' })
  const dateMs = Date.now() - dateAt
  const dateSaid = await peek()
  const typeAt = Date.now()
  await pickTool('browser_type').execute({ text: 'hello there', field: 'Note' })
  const typeMs = Date.now() - typeAt
  const typeSet = String((await pickTool('browser_eval').execute({ code: "document.getElementById('note').value" }))?.text ?? '') === 'hello there'
  const pickAt = Date.now()
  await pickTool('browser_select').execute({ value: 'Beta' })
  const pickMs = Date.now() - pickAt
  const pickSaid = await peek()
  budget('type', typeMs)
  emit('hard-forms', {
    ms: Date.now() - formsAt,
    deepMs,
    dateMs,
    typeMs,
    pickMs,
    deepHit: deepSaid.startsWith('deep-') && !deepSaid.endsWith('-0'),
    dateSet: dateSaid === 'date-2026-03-04',
    typeSet,
    pickSet: pickSaid === 'pick-Beta',
  })
  /* Typing into a date field is human typing on purpose; the click and the
     dropdown are the two that must stay instant. */
  budget('hard-forms', Math.max(deepMs, pickMs))
  /* A whole task, not one step: twenty click-then-look rounds on the same page,
     counted the way a model pays for it — every character a tool hands back. */
  await sidecar.page.navigate(servers.dense.url)
  await wait(200)
  const sessionTools = sidecarTools(sidecar, { last: undefined })
  const viewTool = sessionTools.find((tool) => tool.name === 'browser_view')
  const clickTool2 = sessionTools.find((tool) => tool.name === 'browser_click')
  await viewTool.execute({ mode: 'text', max_chars: 800 })
  let sessionMs = 0
  let sessionChars = 0
  for (let i = 1; i <= 20; i += 1) {
    const at = Date.now()
    const clicked = await clickTool2.execute({ text: `Item ${i}` })
    const seen = await viewTool.execute({ changed_only: true })
    sessionMs += Date.now() - at
    sessionChars += String(clicked?.text ?? '').length + String(seen?.text ?? '').length
  }
  emit('do-session', {
    steps: 20,
    ms: sessionMs,
    perStepMs: Math.round(sessionMs / 20),
    chars: sessionChars,
    tokens: Math.round(sessionChars / 3.4),
  })
  budget('do-session', Math.round(sessionMs / 20))
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
  budget('crash-recovery', Date.now() - backAt)
  await sidecar.shutdown()
  for (const row of Object.values(servers)) row.server.close()
  const over = tried.filter((row) => row.ms > row.limit)
  emit('budget', { checks: tried.length, over, ok: over.length === 0 })
  process.exitCode = over.length === 0 ? 0 : 1
}

/* Run as a program; imported, it is a page generator and nothing else. */
if (import.meta.url === `file://${process.argv[1]}`) await main()
