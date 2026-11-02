#!/usr/bin/env node
/**
 * What one action costs through the tool surface, not through the protocol.
 *
 *   node scripts/bench-actions.mjs [--reps 14] [--json out.json]
 *
 * `bench-resource.mjs` times a protocol round trip; a model pays for the tool
 * call around it — naming the control, waiting for the page, shaping the text
 * it gets back. Five actions cover what an agent does on a page: read it, look
 * at its controls, click one, type into one, take a picture, and run a line of
 * JavaScript. Every number is wall clock around `tool.execute`, the same call
 * `browser_*` makes, on a page served from this process.
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-bench-actions-'))
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at === -1 ? fallback : argv[at + 1]
}
const reps = Math.max(3, Number(argOf('--reps', '14')))
const sink = argOf('--json', null)

const rows = Array.from({ length: 60 }, (_, i) => `<li><a href="/row-${String(i)}">row ${String(i)}</a></li>`).join('')
const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>actions</title>' +
    '<h1>actions</h1>' +
    '<form><label>Search <input id="q" name="q"></label> <button id="go" type="button">Go</button></form>' +
    '<p id="tick">0</p>' +
    `<p>${'the page has to cost what a page costs. '.repeat(40)}</p>` +
    `<ul>${rows}</ul>`)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/page`
const done = async (code = 0) => {
  process.exitCode = code
  server.closeAllConnections()
  await new Promise((settle) => { server.close(() => settle()) })
}

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const sidecar = new Sidecar({ profile: 'bench-actions', headless: true, budgetMb: 4000 })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => {
  const found = tools.find((one) => one.name === name)
  if (found === undefined) throw new Error(`no ${name}`)
  return found
}
const cwd = mkdtempSync(join(tmpdir(), 'dsh-bench-actions-cwd-'))
const chat = 'session-bench-actions'
const run = (name, args) => sessionScope.run(chat, () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: chat } })))
const text = (said) => String(said?.text ?? '')
const round = (ms) => Math.round(ms)

/** @param {number[]} samples - milliseconds. @returns {{median: number, p95: number, min: number, max: number}} spread. */
function spread(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
  return { median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) }
}

const report = { reps }
try {
  const started = Date.now()
  const opened = await run('browser_open', { url })
  report.open_ms = round(Date.now() - started)
  if (!/actions/.test(text(opened))) throw new Error(`open said: ${text(opened).slice(0, 200)}`)
  /* The page's own title, so the first read does not wait on a navigation. */
  await run('browser_eval', { code: 'document.readyState' })

  const timed = []
  /* A read of a page that has not moved is answered from what this chat already
     has — that is the cheap path, and it is measured on its own. A page that
     did move pays for the words, so those reps poke the page first, outside the
     timed span. */
  const poke = 'document.getElementById("tick").textContent = String(Date.now()) + Math.random()'
  const acts = [
    ['read', 'browser_read', {}, poke],
    ['read_repeat', 'browser_read', {}, ''],
    ['view', 'browser_view', {}, poke],
    ['view_repeat', 'browser_view', {}, ''],
    ['click', 'browser_click', { text: 'Go' }, ''],
    ['type', 'browser_type', { text: 'bench' }, ''],
    ['shot', 'browser_shot', { name: 'bench' }, ''],
    ['eval', 'browser_eval', { code: 'document.title' }, ''],
  ]
  for (const [label, name, args, before] of acts) {
    const samples = []
    const chars = []
    /* Two warm calls: the first press of a code path pays for lazily built
       maps, and a benchmark of steady state should not include them. */
    for (let i = 0; i < reps + 2; i += 1) {
      if (before !== '') await run('browser_eval', { code: before })
      const at = Date.now()
      const said = await run(name, { ...args })
      const ms = Date.now() - at
      if (i >= 2) {
        samples.push(ms)
        chars.push(text(said).length)
      }
      if (label === 'type') {
        /* Each rep types into whatever is focused; empty it so the field never
           grows to a size that makes layout the thing being measured. */
        await run('browser_eval', { code: 'document.getElementById("q").value = ""' })
      }
    }
    const row = { ...spread(samples), chars: round(chars.reduce((sum, one) => sum + one, 0) / chars.length) }
    timed.push([label, row])
    console.log(`${label.padEnd(11)} median ${String(row.median).padStart(4)} ms  p95 ${String(row.p95).padStart(4)} ms  max ${String(row.max).padStart(4)} ms  ${String(row.chars).padStart(6)} chars`)
  }
  report.actions = Object.fromEntries(timed)

  /* One page that is paged through the real tool entry point is what a caller
     feels; the numbers above are that. */
  const readChars = report.actions.read.chars
  const viewChars = report.actions.view.chars
  report.tokens = {
    read: Math.ceil(readChars / 4),
    read_repeat: Math.ceil(report.actions.read_repeat.chars / 4),
    view: Math.ceil(viewChars / 4),
    view_repeat: Math.ceil(report.actions.view_repeat.chars / 4),
  }
  console.log(`open   ${String(report.open_ms).padStart(4)} ms  (cold, one page)`)
  console.log(`tokens read ${String(report.tokens.read)} (repeat ${String(report.tokens.read_repeat)})  view ${String(report.tokens.view)} (repeat ${String(report.tokens.view_repeat)})  — chars / 4`)

  let failed = 0
  const check = (ok, said) => {
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${said}`)
  }
  for (const [label, row] of timed) check(row.median < 500 && row.max < 2000, `${label} at the tool surface: median ${String(row.median)} ms, max ${String(row.max)} ms`)
  check(readChars > 200, `a read returns ${String(readChars)} chars`)
  check(report.tokens.read < 1500, `a read costs about ${String(report.tokens.read)} tokens`)
  check(report.tokens.read_repeat < report.tokens.read, `a repeat read costs ${String(report.tokens.read_repeat)} tokens instead of ${String(report.tokens.read)}`)
  check(report.tokens.view_repeat < report.tokens.view, `a repeat view costs ${String(report.tokens.view_repeat)} tokens instead of ${String(report.tokens.view)}`)
  check(failed === 0, `${String(failed)} check(s) failed`)
  if (sink !== null) writeFileSync(sink, `${JSON.stringify(report)}\n`)
  console.log(JSON.stringify(report))
  await sidecar.shutdown().catch(() => {})
  await done(failed === 0 ? 0 : 1)
} catch (error) {
  console.error(`FAIL ${String(error?.message ?? error)}`)
  await sidecar.shutdown().catch(() => {})
  await done(1)
}
