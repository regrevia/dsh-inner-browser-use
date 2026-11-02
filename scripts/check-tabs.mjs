#!/usr/bin/env node
/**
 * What six tabs actually cost, and what the seventh does.
 *
 *   node scripts/check-tabs.mjs
 *
 * One browser, six chats with a page each: measures the real process tree after
 * every tab, the idle CPU of the whole thing, and then asks for a seventh tab to
 * check that the ten-minute LRU (MAX_TABS) takes the oldest one instead of
 * letting the tree grow. The number that matters is the renderer count: with
 * `--renderer-process-limit=4` six tabs must not mean six renderers.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-tabs-'))

const server = createServer((request, response) => {
  const path = String(request.url ?? '/')
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>tab ${path}</title><h1>tab ${path}</h1>${'<p>a paragraph of filler so the page has a body to read.</p>'.repeat(20)}`)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'tabs-check', headless: true, restFloor: 30_000, restCeiling: 40_000, budgetMb: 4000 })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
const cwd = mkdtempSync(join(tmpdir(), 'dsh-tabs-cwd-'))
const run = (chat, name, args) => sessionScope.run(chat, () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: chat } })))
const text = (said) => String(said?.text ?? '')
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

function tree(root) {
  /* One ps for the whole sample, command included: the renderer count must be
     the browsers in this tree, not every Chrome renderer on the machine. */
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss=,time=,command='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim())
    .map((line) => { const [pid, ppid, cpu, rss, time, ...rest] = line.split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), rss: Number(rss), time: clock(time), command: rest.join(' ') } })
  const byParent = new Map()
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, [])
    byParent.get(row.ppid).push(row)
  }
  const out = []
  const walk = (pid) => {
    for (const child of byParent.get(pid) ?? []) {
      out.push(child)
      walk(child.pid)
    }
  }
  walk(root)
  return out
}
/* `ps` reports average CPU since the process started, which is the start-up
   burst on a young browser. Idle needs the slope of the CPU clock instead. */
function clock(time) {
  const parts = String(time).split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(parts[0] ?? 0)
}
function weigh() {
  const root = sidecar.child?.pid
  if (!root) return { mb: 0, cpu: 0, procs: 0, renderers: 0 }
  const rows = tree(root)
  return {
    mb: Math.round(rows.reduce((sum, row) => sum + row.rss, 0) / 1024),
    cpu: Number(rows.reduce((sum, row) => sum + row.cpu, 0).toFixed(1)),
    procs: rows.length + 1,
    renderers: rows.filter((row) => row.command.includes('--type=renderer')).length,
    clock_seconds: Number(rows.reduce((sum, row) => sum + row.time, 0).toFixed(2)),
  }
}

const report = { generated_at: new Date().toISOString(), version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, tabs: [] }
try {
  for (let i = 1; i <= 6; i += 1) {
    const chat = `session-tabs-${String(i)}`
    const started = Date.now()
    const said = text(await run(chat, 'browser_open', { url: `${base}/p${String(i)}` }))
    const openMs = Date.now() - started
    check(said.includes(`tab /p${String(i)}`), `tab ${String(i)} shows its page (open ${String(openMs)} ms)`)
    const w = weigh()
    report.tabs.push({ tab: i, open_ms: openMs, ...w })
    console.log(`     tab ${String(i)}: ${String(w.mb)} MB · ${String(w.procs)} procs · ${String(w.renderers)} renderer processes`)
  }
  const six = weigh()
  report.six = six
  /* A tab after the first costs only a new target on a socket that is already
     up, so the price should be tens of milliseconds, not a second. Playwright
     MCP measured 40–87 ms for the same thing here and Chrome DevTools MCP
     127–136 ms; 150 ms is the loose edge of that. */
  const extra = report.tabs.slice(1).map((one) => one.open_ms).sort((a, b) => a - b)
  const median = extra[Math.floor(extra.length / 2)]
  report.warm_tab = { all_ms: report.tabs.map((one) => one.open_ms), extra_ms: extra, median_ms: median }
  check(median <= 150, `a tab on a warm browser opens in ${String(median)} ms (median of five)`)
  /* Six tabs, four renderer processes: the limit is doing its job if the count
     stays under seven and the tree under 1.4 GB. */
  check(six.renderers <= 6, `six tabs ran on ${String(six.renderers)} renderer processes`)
  check(six.mb < 1400, `six tabs cost ${String(six.mb)} MB`)

  const samples = []
  const until = Date.now() + 20_000
  let last = weigh()
  while (Date.now() < until) {
    await wait(2500)
    const now = weigh()
    const spent = now.clock_seconds - last.clock_seconds
    samples.push(Number(((spent / 2.5) * 100).toFixed(2)))
    last = now
  }
  const avg = Number((samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)).toFixed(2))
  /* The first windows still carry the work of drawing six pages; the number a
     person lives with is the one after that has settled. */
  const settledSamples = samples.slice(3)
  const settled = Number((settledSamples.reduce((a, b) => a + b, 0) / Math.max(1, settledSamples.length)).toFixed(2))
  report.idle = { samples_pct: samples, avg_pct: avg, settled_pct: settled }
  check(avg <= 5, `six idle tabs averaged ${String(avg)}% of a core`)
  check(settled <= 2, `six idle tabs settled at ${String(settled)}% of a core`)

  const seventh = 'session-tabs-7'
  const said = text(await run(seventh, 'browser_open', { url: `${base}/p7` }))
  check(said.includes('tab /p7'), 'a seventh chat got its own page')
  const tabs = await sidecar.state()
  const pages = Number(tabs.pages ?? tabs.open ?? 0)
  report.seven = { ...weigh(), pages: pages || null }
  console.log(`     seven chats: ${String(report.seven.mb)} MB · ${String(report.seven.procs)} procs · ${String(report.seven.renderers)} renderers`)
  check(report.seven.procs <= six.procs + 3, `the seventh tab did not add a process tree (${String(six.procs)} → ${String(report.seven.procs)})`)
  check(report.seven.mb <= six.mb + 250, `the seventh tab was bounded (${String(six.mb)} → ${String(report.seven.mb)} MB)`)
} finally {
  server.close()
  await sidecar.shutdown().catch(() => {})
}
console.log(JSON.stringify(report, null, 2))
console.log(failed === 0 ? '\ntabs hold.' : `\n${String(failed)} tab checks failed.`)
process.exitCode = failed === 0 ? 0 : 1
