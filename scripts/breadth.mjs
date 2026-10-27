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
import { diffRead } from '../tools.js'
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
    <label><input type="checkbox" name="agree"> I agree</label>
    <button type="submit">Send</button></form></body></html>`,
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
} catch (error) {
  line('crashed', false, String(error?.message ?? error))
} finally {
  await sidecar.shutdown()
  server.close()
  process.exit(0)
}
