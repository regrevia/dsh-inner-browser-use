#!/usr/bin/env node
/**
 * Breadth: the kinds of page an agent actually meets, driven end to end.
 * One JSON line per check. A check that cannot be done is a bug, not a skip.
 *
 * Run: node scripts/breadth.mjs
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

import { readPage, renderPage, locate, contextFor, REF_GONE } from '../read.js'
import { diffRead, sidecarTools } from '../tools.js'
import { Sidecar } from '../sidecar.js'

const PAGES = {
  '/shadow': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Shadow</h1><x-card></x-card>
    <script>customElements.define('x-card', class extends HTMLElement {
      constructor() { super(); const r = this.attachShadow({ mode: 'open' })
        r.innerHTML = '<p>inside the card</p><input placeholder="card field"><button id="go">Card go</button>'
        r.querySelector('#go').addEventListener('click', () => { document.title = 'card clicked' })
      }
    })</script></body></html>`,
  '/form': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <form action="/done"><label>Email <input name="email" type="email"></label>
    <label>Size <select name="size"><option>Small</option><option>Large</option></select></label>
    <label for="nick">Nickname</label><input id="nick">
    <span id="hint">Search the catalog</span><input aria-labelledby="hint">
    <label><input type="checkbox" name="agree"> I agree</label>
    <button type="submit">Send</button></form></body></html>`,
  /* The words are in a div over a bare input: no label, no aria, no placeholder. */
  '/bare': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <form onsubmit="event.preventDefault()">
    <div class="box" style="margin-bottom:16px"><div class="lbl">Work email</div><input name="wk"></div>
    <div class="box"><div class="lbl">Team name</div><input name="tm"></div>
    <div class="box"><div class="lbl">Seats</div><select name="seats"><option value="1">One</option><option value="2">Two</option><option value="3">Three</option></select></div>
    <button type="submit">Send</button></form></body></html>`,
  '/words': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <button onclick="document.title='alpha clicked'">Alpha</button>
    <button onclick="document.title='beta clicked'">Beta sent</button>
    <button onclick="document.title='split clicked'"><span>Sign</span><span>in</span></button></body></html>`,
  '/login': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <form onsubmit="event.preventDefault(); document.title = 'in as ' + document.querySelector('input[name=user]').value">
    <label>Username <input name="user"></label>
    <label>Password <input name="pass" type="password"></label>
    <button type="submit">Log in</button></form></body></html>`,
  '/dialog': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <button onclick="document.title = confirm('sure?') ? 'yes' : 'no'">Ask</button></body></html>`,
  '/frame': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Frame</h1>
    <iframe srcdoc="<p>inside the frame</p><input placeholder='Frame field'><button id='go'>Frame go</button>"
      style="width:520px;height:260px;border:1px solid #999"></iframe>
    <script>window.wire = () => {
      const doc = document.querySelector('iframe').contentDocument
      doc.querySelector('#go').addEventListener('click', () => { document.title = 'frame clicked' })
    }
    document.querySelector('iframe').addEventListener('load', window.wire)</script></body></html>`,
  '/pop': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Pop</h1>
    <button id='pop' onclick="window.open('/done?popped=1','_blank')">Open tab</button></body></html>`,
  '/done': `<!doctype html><html><body><h1>Done</h1><p>the form arrived</p></body></html>`,
  '/upload': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Upload</h1><input type="file" aria-label="Pick file">
    <p id='out'>nothing</p>
    <script>document.querySelector('input').addEventListener('change', (event) => {
      document.getElementById('out').textContent = event.target.files[0].name
    })</script></body></html>`,
  '/xhr': `<!doctype html><html><body><h1>Network</h1><p id='out'>waiting</p>
    <script>fetch('/api/ping').then((r) => r.json()).then((data) => { document.getElementById('out').textContent = data.said })</script>
    </body></html>`,
  '/download': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Download</h1><a id='get' href="/file" download="report.txt">Get file</a></body></html>`,
  '/cross': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Cross</h1>
    <iframe src="http://localhost:__PORT__/partner" style="width:520px;height:240px;border:1px solid #999"></iframe>
    </body></html>`,
  '/list': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Catalog</h1><ul id="rows">${Array.from({ length: 30 }, (_, i) => `<li><a href="/item?id=${i + 1}">Item ${i + 1} sold</a> — <span>$${i + 1}</span></li>`).join('')}</ul>
    </body></html>`,
  '/cover': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Covered</h1>
    <button id="under" onclick="document.title='under clicked'">Under the banner</button>
    <p><label for="note">Note</label> <input id="note" name="note"></p>
    <div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">
      We use cookies to remember you. <button id="yes" onclick="document.getElementById('banner').remove()">Accept</button></div></div>
    </body></html>`,
  '/guard': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Guarded</h1>
    <button id="under" onclick="document.title='under clicked'">Under the banner</button>
    <div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div style="margin:120px auto;width:280px;background:#fff;padding:16px">
      Delete this account? <button id="gone" onclick="document.title='deleted'">Delete forever</button></div></div>
    </body></html>`,
  /* A site's own check page: the browser is asked to prove a person is there.
     Nothing about it is broken, so it must not be read as content. */
  '/check': '<!doctype html><html><head><title>请稍候…</title></head><body><p>Checking</p></body></html>',
  /* A list that redraws itself: every element is thrown away and made again
     with the same words. Refs from a read before the redraw point at elements
     that no longer exist, which is the everyday way a ref goes stale while the
     control is still on screen. */
  '/redraw': `<!doctype html><html><body style="font:16px system-ui;padding:24px">
    <h1>Redraw</h1><div id="list"></div>
    <div id="modal" style="display:none"><button id="kill">Discard draft</button></div>
    <script>
    window.paint = () => {
      const list = document.getElementById('list')
      list.innerHTML = ''
      const button = document.createElement('button')
      button.id = 'keep'
      button.textContent = 'Keep going'
      button.addEventListener('click', () => { document.title = 'kept clicked' })
      list.appendChild(button)
    }
    window.paint()
    window.repaint = () => { window.paint(); document.getElementById('modal').style.display = 'block' }
    </script></body></html>`,
  '/partner': `<!doctype html><html><body style="font:16px system-ui;padding:12px">
    <p>a partner frame Chrome keeps apart</p><input placeholder="Partner field">
    <input type="file" aria-label="Partner file" onchange="document.title = 'partner got ' + this.files[0].name">
    <button id='pg' onclick="window.top.postMessage('partner clicked','*');document.title='partner clicked'">Partner go</button>
    </body></html>`,
}

const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ said: 'pong' }))
    return
  }
  if (req.url.split('?')[0] === '/file') {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' })
    res.end('the file arrived')
    return
  }
  const html = PAGES[req.url.split('?')[0]]
  if (html === undefined) {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<h1>not here</h1>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html.replaceAll('__PORT__', String(server.address().port)))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const line = (check, ok, detail = '') => console.log(JSON.stringify({ check, ok, detail }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Evaluate, but never wait on a page that is paused by a dialog. */
const js = async (page, expression) => {
  const raced = await Promise.race([
    page.cdp.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null),
    sleep(2500).then(() => null),
  ])
  return raced?.result?.value
}

const control = (read, name) => read.controls.find((c) => c.name.toLowerCase().includes(name.toLowerCase()))

const click = async (page, ref) => {
  const spot = await locate(page, ref)
  if (spot.gone === true) return spot
  await page.mouse('mousePressed', spot)
  await page.mouse('mouseReleased', spot)
  return spot
}

const sidecar = new Sidecar({ profile: 'breadth' })
let page
try {
  page = await sidecar.ensure({ url: `${base}/shadow` })

  const shadow = await readPage(page, { mode: 'full', maxChars: 2000 })
  const field = control(shadow, 'card field')
  line('shadow-read', shadow.text.includes('inside the card') && field !== undefined, shadow.text.replace(/\s+/g, ' ').slice(0, 60))
  const cardButton = control(shadow, 'Card go')
  if (cardButton !== undefined) {
    await click(page, cardButton.ref)
    line('shadow-click', (await js(page, 'document.title')) === 'card clicked')
  } else line('shadow-click', false, 'button not numbered')

  await page.navigate(`${base}/form`)
  const form = await readPage(page, { mode: 'forms', maxChars: 1600 })
  const email = control(form, 'Email')
  if (email === undefined) line('form-type', false, 'field not numbered')
  else {
    await click(page, email.ref)
    await page.insertText('a@b.c')
    line('form-type', (await js(page, 'document.querySelector("input[name=email]").value')) === 'a@b.c')
    const formTools = sidecarTools(sidecar, { last: undefined })
    const typeTool = formTools.find((tool) => tool.name === 'sidecar_type')
    const keyTool = formTools.find((tool) => tool.name === 'sidecar_key')
    await typeTool.execute({ ref: email.ref, text: 'q', clear: true })
    await keyTool.execute({ key: 'Backspace' })
    line('backspace', (await js(page, 'document.querySelector("input[name=email]").value')) === '')
    await typeTool.execute({ ref: email.ref, text: 'a@b.c', clear: true })
    const doFill = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_do')
    const said = await doFill.execute({ steps: [{ field: 'Email', text: 'a@b.c', clear: true }], read: 'none' })
    line('do-clear', (await js(page, 'document.querySelector("input[name=email]").value')) === 'a@b.c', String(said.text).slice(0, 60))
  }
  const size = control(form, 'Size')
  if (size !== undefined) {
    await click(page, size.ref)
    const selected = await js(page, `(() => {
      const select = document.querySelector('select[name=size]')
      select.value = 'Large'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return select.value
    })()`)
    line('form-select', selected === 'Large')
  }
  const after = await readPage(page, { mode: 'forms', maxChars: 1600 })
  const nick = control(form, 'Nickname')
  const hint = control(form, 'Search the catalog')
  line('form-names', nick !== undefined && hint !== undefined, `${nick?.name ?? 'none'} | ${hint?.name ?? 'none'}`)

  const changed = diffRead(form, after, { maxChars: 2000 })
  const whole = renderPage(after, { mode: 'forms', maxChars: 1600 })
  line('changed-only', changed.includes('a@b.c') && changed.length < whole.length / 2, `${changed.length} chars vs ${whole.length}`)

  const agree = control(after, 'I agree')
  if (agree !== undefined) {
    await click(page, agree.ref)
    line('form-checkbox', (await js(page, 'document.querySelector("input[name=agree]").checked')) === true)
  }
  const send = control(after, 'Send')
  if (send !== undefined) {
    await click(page, send.ref)
    let arrived = false
    for (let i = 0; i < 20 && !arrived; i += 1) {
      await sleep(150)
      arrived = String(await js(page, 'location.href')).includes('/done')
    }
    line('form-submit', arrived, String(await js(page, 'location.href')))
  }

  /* A label in a div, a bare input under it: clicking the words must still put
     the typing in the field the words belong to, not wherever focus was. */
  await page.navigate(`${base}/bare`)
  const bareDo = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_do')
  const bareSaid = await bareDo.execute({ steps: [{ field: 'Work email', text: 'me@x.y' }], read: 'none' })
  const bareValue = await js(page, 'document.querySelector("input[name=wk]").value')
  const teamValue = await js(page, 'document.querySelector("input[name=tm]").value')
  line('do-field-bare', bareValue === 'me@x.y' && teamValue === '', `${bareValue} | ${teamValue} | ${String(bareSaid.text).replace(/\n/g, ' / ').slice(0, 80)}`)
  const teamSaid = await bareDo.execute({ steps: [{ field: 'Team name', text: 'core' }], read: 'none' })
  line('do-field-bare-second', (await js(page, 'document.querySelector("input[name=tm]").value')) === 'core', String(teamSaid.text).slice(0, 80))
  const typeBare = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_type')
  const typed = String((await typeBare.execute({ field: 'Work email', text: 'z@z.z', clear: true })).text)
  line('type-by-words', (await js(page, 'document.querySelector("input[name=wk]").value')) === 'z@z.z' && typed.includes('typed into "Work email"'), typed.replace(/\n/g, ' / ').slice(0, 100))
  const selectBare = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_select')
  const picked = String((await selectBare.execute({ field: 'Seats', value: 'Two' })).text)
  line('select-by-words', (await js(page, 'document.querySelector("select[name=seats]").value')) === '2' && picked.includes('chose Two in Seats'), picked.replace(/\n/g, ' / ').slice(0, 110))

  await page.navigate(`${base}/login`)
  const doTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_do')
  const doSaid = await doTool.execute({ steps: [{ field: 'Username', text: 'ada' }, { field: 'Password', text: 'pw' }, { tap: 'Log in' }], read: 'none' })
  await sleep(250)
  line('do-by-words', (await js(page, 'document.title')) === 'in as ada' && String(doSaid.text).includes('typed into "Username"'), String(doSaid.text).replace(/\n/g, ' / ').slice(0, 120))

  await page.navigate(`${base}/words`)
  const wordsTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_click')
  const wordsSaid = await wordsTool.execute({ text: 'Beta sent' })
  await sleep(250)
  line('click-by-words', (await js(page, 'document.title')) === 'beta clicked' && String(wordsSaid.text).startsWith('ok click'), String(wordsSaid.text).slice(0, 80))
  const splitSaid = String((await wordsTool.execute({ text: 'Sign in' })).text)
  line('click-split-words', (await js(page, 'document.title')) === 'split clicked' && splitSaid.startsWith('ok click'), splitSaid.replace(/\n/g, ' / ').slice(0, 90))

  await page.navigate(`${base}/dialog`)
  const ask = control(await readPage(page, { mode: 'text', maxChars: 600 }), 'Ask')
  if (ask !== undefined) {
    await click(page, ask.ref)
    await sleep(300)
    line('dialog-open', page.dialog !== null && page.dialog !== undefined, JSON.stringify(page.dialog ?? null))
    await page.cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
    await sleep(400)
    line('dialog-accepted', (await js(page, 'document.title')) === 'yes')
  }

  await page.navigate(`${base}/pop`)
  await sleep(300)
  const popRead = await readPage(page, { mode: 'full', maxChars: 2000 })
  const popButton = popRead.controls.find((c) => c.name.toLowerCase().includes('open tab'))
  if (popButton === undefined) line('pop-follow', false, popRead.controls.map((c) => c.name).join(' | '))
  else {
    await click(page, popButton.ref)
    await sleep(400)
    const said = await page.adoptOpened()
    const now = await js(page, 'location.href')
    line('pop-follow', String(now).includes('/done') && said.includes('/done'), `${said} -> ${now}`)
  }

  await page.navigate(`${base}/frame`)
  await sleep(400)
  const framed = await readPage(page, { mode: 'full', maxChars: 2000 })
  const insideField = framed.controls.find((c) => c.name.toLowerCase().includes('frame field'))
  line('frame-read', insideField !== undefined && insideField.ref >= 900000, insideField ? `ref ${insideField.ref}` : framed.controls.map((c) => c.name).join(' | '))
  if (insideField !== undefined) {
    await click(page, insideField.ref)
    await page.insertText('in frame')
    const said = await js(page, `document.querySelector('iframe').contentDocument.querySelector('input').value`)
    line('frame-type', said === 'in frame', String(said))
    const frameButton = framed.controls.find((c) => c.name.toLowerCase().includes('frame go'))
    if (frameButton !== undefined) {
      await click(page, frameButton.ref)
      await sleep(300)
      line('frame-click', (await js(page, 'document.title')) === 'frame clicked', String(await js(page, 'document.title')))
    } else line('frame-click', false, 'button not numbered')
  }

  await page.navigate(`${base}/cross`)
  await sleep(900)
  const crossed = await readPage(page, { mode: 'full', maxChars: 2000 })
  const partnerField = crossed.controls.find((c) => c.name.toLowerCase().includes('partner field'))
  line('frame-cross-read', partnerField !== undefined && partnerField.ref >= 900000, partnerField ? `ref ${partnerField.ref}` : crossed.controls.map((c) => c.name).join(' | '))
  const partnerButton = crossed.controls.find((c) => c.name.toLowerCase().includes('partner go'))
  if (partnerButton !== undefined) {
    await click(page, partnerButton.ref)
    await sleep(400)
    const frames = await page.frameList()
    const apart = frames.find((f) => f.url.includes('localhost'))
    const session = apart === undefined ? undefined : page.childSession(apart.frameId)
    const said = session === undefined ? undefined : (await page.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, session).catch(() => null))?.result?.value
    line('frame-cross-click', said === 'partner clicked', String(said))
  } else line('frame-cross-click', false, 'button not numbered')

  const partnerFile = crossed.controls.find((c) => String(c.name).toLowerCase().includes('partner file'))
  const fileRoute = partnerFile === undefined ? null : await contextFor(page, partnerFile.ref)
  if (fileRoute === null) line('frame-cross-upload', false, 'file input not numbered')
  else {
    const chosen = '/tmp/breadth-partner.txt'
    writeFileSync(chosen, 'handed over')
    const evaluate = { expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${fileRoute.local}); return hit ? hit.el : null })()` }
    if (fileRoute.contextId !== undefined) evaluate.contextId = fileRoute.contextId
    const handle = await page.cdp.send('Runtime.evaluate', evaluate, fileRoute.sessionId)
    const node = await page.cdp.send('DOM.describeNode', { objectId: handle.result?.objectId }, fileRoute.sessionId)
    await page.cdp.send('DOM.setFileInputFiles', { files: [chosen], backendNodeId: node.node.backendNodeId }, fileRoute.sessionId)
    let said = ''
    for (let i = 0; i < 20 && !said.includes('breadth-partner.txt'); i += 1) {
      await sleep(200)
      const title = await page.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, fileRoute.sessionId)
      said = String(title.result?.value ?? '')
    }
    line('frame-cross-upload', said === 'partner got breadth-partner.txt', said)
  }

  await page.navigate(`${base}/download`)
  const getIt = control(await readPage(page, { mode: 'text', maxChars: 600 }), 'Get file')
  if (getIt === undefined) line('download-click', false, 'link not numbered')
  else {
    const beforeAt = String(page.downloads()[0]?.at ?? '')
    await click(page, getIt.ref)
    let files = []
    for (let i = 0; i < 30; i += 1) {
      await sleep(200)
      files = page.downloads()
      if (String(files[0]?.at ?? '') > beforeAt) break
    }
    const newest = files[0]
    line('download-click', String(newest?.at ?? '') > beforeAt && String(newest?.name ?? '').startsWith('report') && newest.bytes === 16, JSON.stringify(files.slice(0, 2)))
  }

  await page.navigate(`${base}/xhr`)
  let ping
  for (let i = 0; i < 30 && ping === undefined; i += 1) {
    await sleep(200)
    ping = page.networkList().find((row) => row.url.endsWith('/api/ping'))
  }
  line('network-list', ping !== undefined && ping.status === 200 && ping.method === 'GET', JSON.stringify(ping ?? null))

  await page.navigate(`${base}/upload`)
  const uploadForm = await readPage(page, { mode: 'forms', maxChars: 800 })
  const pick = control(uploadForm, 'Pick file')
  if (pick === undefined) line('upload-file', false, 'file input not numbered')
  else {
    const chosen = '/tmp/breadth-upload.txt'
    writeFileSync(chosen, 'picked')
    const handle = await page.cdp.send('Runtime.evaluate', {
      expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${pick.ref}); return hit ? hit.el : null })()`,
    })
    const objectId = handle.result?.objectId
    const node = await page.cdp.send('DOM.describeNode', { objectId })
    await page.cdp.send('DOM.setFileInputFiles', { files: [chosen], backendNodeId: node.node.backendNodeId })
    let said = ''
    for (let i = 0; i < 20 && said !== 'breadth-upload.txt'; i += 1) {
      await sleep(200)
      const out = await page.cdp.send('Runtime.evaluate', { expression: `document.getElementById('out').textContent`, returnByValue: true })
      said = String(out.result?.value ?? '')
    }
    line('upload-file', said === 'breadth-upload.txt', said)
  }

  const pdf = await page.pdf()
  line('pdf-print', pdf.startsWith('JVBERi') && pdf.length > 1000, `${pdf.length} base64 chars`)

  const gone = await locate(page, 99999)
  line('gone-ref', gone.gone === true && typeof REF_GONE === 'string')

  /* A crashed renderer must not end the session: the next call starts a new one
     on the address the person was looking at. */
  await page.navigate(`${base}/dense`)
  const tabPort = sidecar.page.port
  await fetch(`http://127.0.0.1:${tabPort}/json/new?${encodeURIComponent(`${base}/light`)}`, { method: 'PUT' }).catch(() => null)
  await sleep(400)
  const tabsTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_tabs')
  const listed = await tabsTool.execute({ action: 'list' })
  const rows = String(listed.text).split('\n')
  const otherRow = rows.findIndex((row) => row.includes('/light'))
  const switched = otherRow < 0 ? { text: 'unlisted' } : await tabsTool.execute({ action: 'switch', index: otherRow })
  const onLight = String(sidecar.page?.url ?? '').includes('/light')
  const closed = otherRow < 0 ? { text: '' } : await tabsTool.execute({ action: 'close', index: 0 })
  page = sidecar.page
  line('tabs', rows.length >= 2 && otherRow >= 0 && onLight && String(closed.text).includes('/dense'), `${rows.length} rows | ${switched.text} | ${closed.text} | ${String(listed.text).replace(/\n/g, ' / ').slice(0, 160)}`)

  await page.navigate(`${base}/list`)
  const extractTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_extract')
  const extracted = String((await extractTool.execute({ select: '#rows li' })).text)
  const wholeList = renderPage(await readPage(page, { mode: 'text', maxChars: 4000 }), { mode: 'text', maxChars: 4000 })
  const budgetList = renderPage(await readPage(page, { mode: 'text', maxChars: 500 }), { mode: 'text', maxChars: 500 })
  line('extract-rows', /^30 of 30 rows/.test(extracted) && extracted.includes('/item?id=30') && budgetList.includes('/item?id=30') === false, `${extracted.length} chars vs ${wholeList.length} whole, ${budgetList.length} at a 500-char budget · ${extracted.split('\n')[1]?.slice(0, 70)}`)

  await page.navigate(`${base}/cover`)
  const coverRead = await readPage(page, { mode: 'text', maxChars: 2000 })
  const under = control(coverRead, 'Under the banner')
  const clickTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_click')
  const covered = String((await clickTool.execute({ ref: under.ref })).text)
  const through = (await js(page, 'document.title')) === 'under clicked'
  line('covered-click', covered.includes('covers it') && covered.includes('We use cookies') && covered.includes('clicked Accept on it first') && through, `${through ? 'click went through' : 'click stayed under'} | ${covered.replace(/\n/g, ' / ').slice(0, 130)}`)

  await page.navigate(`${base}/cover`)
  const fieldRead = await readPage(page, { mode: 'forms', maxChars: 2000 })
  const note = control(fieldRead, 'Note')
  const typeTool0 = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_type')
  const typedThrough = String((await typeTool0.execute({ ref: note.ref, text: 'held' })).text)
  line('type-through-overlay', typedThrough.includes('clicked Accept on it first') && (await js(page, 'document.querySelector("#note").value')) === 'held', typedThrough.replace(/\n/g, ' / ').slice(0, 130))

  await page.navigate(`${base}/cover`)
  const doTool0 = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_do')
  const batch = String((await doTool0.execute({ steps: [{ tap: 'Under the banner' }], read: 'none' })).text)
  const batchThrough = (await js(page, 'document.title')) === 'under clicked'
  line('do-through-overlay', batchThrough && batch.includes('after Accept on a banner, clicked "Under the banner"'), `${batchThrough ? 'click went through' : 'click stayed under'} | ${batch.replace(/\n/g, ' / ').slice(0, 120)}`)

  await page.navigate(`${base}/cover`)
  const batchField = String((await doTool0.execute({ steps: [{ field: 'Note', text: 'kept' }], read: 'none' })).text)
  line('do-field-overlay', String(await js(page, 'document.querySelector("#note").value')) === 'kept' && batchField.includes('after Accept on a banner, typed into "Note"'), batchField.replace(/\n/g, ' / ').slice(0, 120))

  await page.navigate(`${base}/guard`)
  const guardRead = await readPage(page, { mode: 'text', maxChars: 2000 })
  const underGuard = control(guardRead, 'Under the banner')
  const guarded = String((await clickTool.execute({ ref: underGuard.ref })).text)
  const untouched = (await js(page, 'document.title')) === '' && String(await js(page, 'document.getElementById("modal") === null')) === 'false'
  line('guarded-overlay', guarded.includes('covers it') && guarded.includes('Delete this account') && guarded.includes('clicked') === false && untouched, guarded.replace(/\n/g, ' / ').slice(0, 120))

  /* A ref the page invalidated by redrawing is not a dead end: the words are
     still on screen, so the click goes where the control is now. A control that
     really left still takes the refusal with it. */
  await page.navigate(`${base}/redraw`)
  const followState = { last: undefined }
  const followTools = sidecarTools(sidecar, followState)
  await followTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 400 })
  const keepControl = followState.refs.find((c) => c.name.toLowerCase().includes('keep going'))
  await js(page, 'window.repaint()')
  const staleNow = await locate(page, keepControl.ref)
  const followed = String((await followTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: keepControl.ref })).text)
  const keptTitle = String(await js(page, 'document.title'))
  line('ref-follows-redraw', staleNow.gone === true && keptTitle === 'kept clicked' && followed.includes('has a new number'), `${staleNow.gone === true ? 'ref was stale' : 'ref still pointed at something'} | title=${keptTitle} | ${followed.replace(/\n/g, ' / ').slice(0, 150)}`)

  await page.navigate(`${base}/redraw`)
  const refuseState = { last: undefined }
  const refuseTools = sidecarTools(sidecar, refuseState)
  await refuseTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 400 })
  const keepGone = refuseState.refs.find((c) => c.name.toLowerCase().includes('keep going'))
  await js(page, "document.getElementById('list').innerHTML = '<button>Something else</button>'")
  const reallyGone = String((await refuseTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: keepGone.ref })).text)
  line('ref-refuses-really-gone', reallyGone.includes('Call sidecar_view'), reallyGone.replace(/\n/g, ' / ').slice(0, 150))

  const stateTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_state')
  const stateSaid = await stateTool.execute({})
  const counted = Number(String(stateSaid.text).match(/refs followed (\d+)/)?.[1] ?? -1)
  line('follow-counted', counted >= 1, `${String(counted)} | ${String(stateSaid.text).replace(/\n/g, ' / ').slice(0, 160)}`)
  /* Nothing here draws the column, so the state has to say that out loud and
     name the one thing that fixes it. A silent "viewers 0" reads as a bug. */
  const unseenSaid = String(stateSaid.text).includes('refresh it once')
  line('mirror-honest', unseenSaid, unseenSaid ? 'says nothing is drawing it, and how to fix it' : String(stateSaid.text).replace(/\n/g, ' / ').slice(0, 160))

  /* The person takes the mirror by hand: actions wait for them and say so,
     reads still work (looking helps), and sidecar_resume hands the page back. */
  const holdState = { last: undefined }
  const holdTools = sidecarTools(sidecar, holdState)
  await holdTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 300 })
  const holdTarget = holdState.refs.find((c) => ['btn', 'button'].includes(c.kind))
  sidecar.humanUse({ kind: 'click', x: 12, y: 12 })
  const heldRead = String((await holdTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 200 })).text)
  line('hold-allows-read', /Something else/.test(heldRead) || heldRead.includes('button'), heldRead.replace(/\n/g, ' / ').slice(0, 120))
  const heldText = String((await holdTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: holdTarget.ref })).text)
  line('hold-refuses-action', heldText.includes('person is using the mirror') && heldText.includes('sidecar_resume'), heldText.replace(/\n/g, ' / ').slice(0, 150))
  await holdTools.find((tool) => tool.name === 'sidecar_resume').execute({})
  const afterResume = String((await holdTools.find((tool) => tool.name === 'sidecar_click').execute({ ref: holdTarget.ref })).text)
  line('resume-lets-go', afterResume.startsWith('ok '), afterResume.replace(/\n/g, ' / ').slice(0, 150))

  await page.navigate(`${base}/check`)
  const checkTools = sidecarTools(sidecar, { last: undefined })
  const checkSaid = String((await checkTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 300 })).text)
  await page.navigate(`${base}/words`)
  const plainSaid = String((await checkTools.find((tool) => tool.name === 'sidecar_view').execute({ mode: 'text', max_chars: 300 })).text)
  const checkWords = 'headless false'
  line('check-page-named', checkSaid.includes(checkWords) && !plainSaid.includes(checkWords), `check page says ${checkSaid.includes(checkWords)} | a real page says ${plainSaid.includes(checkWords)} | ${checkSaid.split('\n').pop().slice(0, 110)}`)

  sidecar.person = { at: Date.now() - 2000, kind: 'click', x: 40, y: 60, seen: false }
  const lookTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_view')
  const viewSaid = await lookTool.execute({ mode: 'text', max_chars: 400 })
  line('person-note', String(viewSaid.text).includes('the person also used the page: click at 40,60'), String(viewSaid.text).trim().split(/\n/).pop().slice(0, 90))

  const beforeCrash = sidecar.page
  await Promise.race([beforeCrash.cdp.send('Page.crash').catch(() => {}), sleep(1200)])
  await sleep(500)
  const crashAt = Date.now()
  const viewTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'sidecar_view')
  const recovered = await viewTool.execute({ max_chars: 400 })
  page = sidecar.page
  await sleep(200)
  const backUrl = String(page?.url ?? '')
  line('crash-recovery', String(recovered.text).length > 20 && backUrl.includes('/words'), `${Date.now() - crashAt} ms back | ${backUrl} | ${String(sidecar.lastError).slice(0, 60)}`)
} catch (error) {
  /* A run that breaks should say where, not just what: the stack is the only
     thing that turns a red line into a fix. */
  const at = String(error?.stack ?? '').split('\n').slice(1, 3).map((row) => row.trim().replace(/^at /, '')).join(' ← ')
  line('crashed', false, `${String(error?.message ?? error)}${at === '' ? '' : ` · ${at}`}`)
} finally {
  await sidecar.shutdown()
  server.close()
  process.exit(0)
}
