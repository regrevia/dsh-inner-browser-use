#!/usr/bin/env node
/**
 * Breadth: the kinds of page an agent actually meets, driven end to end.
 * One JSON line per check. A check that cannot be done is a bug, not a skip.
 *
 * Run: node scripts/breadth.mjs
 */
import { createServer } from 'node:http'

import { readPage, locate, REF_GONE } from '../read.js'
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
  '/done': `<!doctype html><html><body><h1>Done</h1><p>the form arrived</p></body></html>`,
}

const server = createServer((req, res) => {
  const html = PAGES[req.url.split('?')[0]]
  if (html === undefined) {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<h1>not here</h1>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
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

  const gone = await locate(page, 99999)
  line('gone-ref', gone.gone === true && typeof REF_GONE === 'string')
} catch (error) {
  line('crashed', false, String(error?.message ?? error))
} finally {
  await sidecar.shutdown()
  server.close()
  process.exit(0)
}
