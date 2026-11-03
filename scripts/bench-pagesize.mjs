#!/usr/bin/env node
/**
 * What a page costs once it is big: does the read budget hold, and what does the
 * unchanged-check fingerprint add on top of the text it has to walk?
 *
 *   node scripts/bench-pagesize.mjs [--reps 7] [--json out.json]
 *
 * Three pages are served from this process — 5 KB, 60 KB and 340 KB of visible
 * text — and the same four calls run on each: read it, look at its controls,
 * click a button, and time `pageMark` both ways in the page (length only, the
 * 0.47.21 shape, versus length plus the djb2 checksum, the 0.47.22 shape). The
 * last column is the answer to "did the fingerprint tax big pages": it must stay
 * inside a millisecond on 340 KB, or the cheaper hash has to come back.
 *
 * Fails when a read on any page returns no text, when a read gets slower than
 * 200 ms, or when the checksum costs more than 3 ms on the large page.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-bench-pagesize-'))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const reps = Math.max(3, Number(argOf('--reps', '7')))
const sink = argOf('--json', null)

const SENTENCE = 'the page has to cost what a page costs. '
const pages = [
  { name: 'small', paragraphs: 12 },
  { name: 'medium', paragraphs: 320 },
  { name: 'large', paragraphs: 2500 },
]
const bodyFor = (paragraphs) => Array.from({ length: paragraphs }, (_, i) =>
  `<p>paragraph ${String(i)} — ${SENTENCE.repeat(3)}</p>`).join('')
const server = createServer((request, response) => {
  const asked = pages.find((one) => request.url === `/${one.name}`) ?? pages[0]
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>' + asked.name + '</title>' +
    `<h1>${asked.name}</h1>` +
    '<form><label>Search <input id="q" name="q"></label>' +
    '<label>Name <input id="n" name="n"></label>' +
    '<button id="go" type="button">Go</button></form>' +
    '<p id="tick">0</p>' +
    `<div id="main">${bodyFor(asked.paragraphs)}</div>`)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${String(server.address().port)}`
const done = async (code = 0) => {
  process.exitCode = code
  server.closeAllConnections()
  await new Promise((settle) => { server.close(() => settle()) })
}

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope, pageMark } = await import('../tools.js')

const sidecar = new Sidecar({ profile: 'bench-pagesize', headless: true, budgetMb: 4000 })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => {
  const found = tools.find((one) => one.name === name)
  if (found === undefined) throw new Error(`no ${name}`)
  return found
}
const cwd = mkdtempSync(join(tmpdir(), 'dsh-bench-pagesize-cwd-'))
const chat = 'session-bench-pagesize'
const run = (name, args) => sessionScope.run(chat, () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: chat } })))
const text = (said) => String(said?.text ?? '')
const round = (ms) => Math.round(ms * 10) / 10
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/* Both shapes of the unchanged-check fingerprint, timed in the page. The old
   one only counted characters; the new one also sums them, which is the whole
   difference this bench is about. */
const MARK_BOTH = '(function () {' +
  'const body = document.body;' +
  'const oldMark = () => { const words = body.innerText; return document.title + "|" + location.href + "|" + words.length + "|" + document.querySelectorAll("*").length };' +
  'const newMark = () => { const words = body.innerText; let sum = 5381;' +
  'for (let i = 0; i < words.length; i += 1) { sum = ((sum * 33) ^ words.charCodeAt(i)) >>> 0 }' +
  'return document.title + "|" + location.href + "|" + words.length + "|" + document.querySelectorAll("*").length + "|" + String(sum) };' +
  'const time = (fn, howMany) => { const out = []; for (let i = 0; i < howMany; i += 1) { const at = performance.now(); fn(); out.push(performance.now() - at) } out.sort((a, b) => a - b); return out[Math.floor(out.length / 2)] };' +
  'time(oldMark, 3); time(newMark, 3);' +
  'return { text: body.innerText.length, nodes: document.querySelectorAll("*").length, oldMs: time(oldMark, 21), newMs: time(newMark, 21) }' +
  '})()'

const checks = []
const check = (fine, said) => {
  checks.push({ fine, said })
  console.log(`${fine ? 'ok  ' : 'FAIL'} ${said}`)
}

const report = { reps, pages: {} }
console.log(`bench-pagesize · ${String(reps)} reps · one headless browser, one page at a time\n`)
for (const page of pages) {
  await run('browser_open', { url: `${base}/${page.name}` })
  const mine = sidecar.pageFor(chat)
  const evalPage = async (expression) => {
    const raw = await mine.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return raw?.result?.value
  }
  const marks = await evalPage(MARK_BOTH)
  const timed = async (name, args) => {
    const at = Date.now()
    const said = await run(name, args)
    return { ms: Date.now() - at, chars: text(said).length }
  }
  const reads = []
  const views = []
  const clicks = []
  const marksHost = []
  for (let i = 0; i < reps; i += 1) {
    reads.push(await timed('browser_read', { force: true }))
    /* A view right after a read on the same page is answered from the
       unchanged-check with a notice, not with controls. One character of new
       text makes it a real view again. */
    await evalPage(`document.getElementById('tick').textContent = '${String(i)}'`)
    views.push(await timed('browser_view', { mode: 'text' }))
    clicks.push(await timed('browser_click', { text: 'Go' }))
    const at = process.hrtime.bigint()
    await pageMark(mine)
    marksHost.push(Number(process.hrtime.bigint() - at) / 1e6)
  }
  const row = {
    text: marks.text,
    nodes: marks.nodes,
    markOldMs: round(marks.oldMs),
    markNewMs: round(marks.newMs),
    markTaxMs: round(marks.newMs - marks.oldMs),
    pageMarkMs: round(median(marksHost)),
    readMs: round(median(reads.map((one) => one.ms))),
    readChars: round(median(reads.map((one) => one.chars))),
    viewMs: round(median(views.map((one) => one.ms))),
    viewChars: round(median(views.map((one) => one.chars))),
    clickMs: round(median(clicks.map((one) => one.ms))),
  }
  report.pages[page.name] = row
  console.log(`${page.name.padEnd(6)} ${String(row.text).padStart(7)} chars · ${String(row.nodes).padStart(5)} nodes · ` +
    `read ${String(row.readMs).padStart(3)} ms/${String(row.readChars).padStart(5)} chars · ` +
    `view ${String(row.viewMs).padStart(3)} ms/${String(row.viewChars).padStart(5)} chars · ` +
    `click ${String(row.clickMs).padStart(3)} ms · ` +
    `mark ${String(row.markOldMs)} → ${String(row.markNewMs)} ms (+${String(row.markTaxMs)}), host ${String(row.pageMarkMs)} ms`)
}

const small = report.pages.small
const medium = report.pages.medium
const large = report.pages.large
console.log('')
check(small.readChars > 200, `a small page reads as text (${String(small.readChars)} chars)`)
check(medium.readChars > 1000, `a medium page reads as text (${String(medium.readChars)} chars)`)
check(large.readChars > 1000, `a large page reads as text (${String(large.readChars)} chars)`)
check(large.readChars < large.text, `a large page is cut to a budget, not sent whole (${String(large.readChars)} of ${String(large.text)} chars)`)
const slowestRead = Math.max(small.readMs, medium.readMs, large.readMs)
check(slowestRead < 200, `a read stays under 200 ms on every page size (slowest ${String(slowestRead)} ms)`)
check(small.viewChars > 100 && medium.viewChars > 100 && large.viewChars > 100,
  `a view returns controls, not the unchanged notice (${String(small.viewChars)} / ${String(medium.viewChars)} / ${String(large.viewChars)} chars)`)
check(large.markTaxMs <= 3, `the checksum costs at most 3 ms on a 340 KB page (${String(large.markTaxMs)} ms)`)
check(large.pageMarkMs < 10, `the fingerprint still fits one round trip on a 340 KB page (${String(large.pageMarkMs)} ms)`)

report.ok = checks.every((one) => one.fine)
const failed = checks.filter((one) => !one.fine).length
console.log(`\n${String(checks.length)} check(s): ${String(checks.length - failed)} ok, ${String(failed)} failed`)
if (sink !== null) writeFileSync(sink, `${JSON.stringify(report, null, 2)}\n`)
await done(report.ok ? 0 : 1)
