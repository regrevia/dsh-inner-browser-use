#!/usr/bin/env node
/**
 * What this browser costs, in the same terms the neighbours are measured in.
 *
 *   node scripts/bench-resource.mjs [--json out.json]
 *
 * Cold start, action round trip, idle memory and CPU with a page open, the
 * reversible freeze, the rest, and the wake. One process tree, one page, the
 * same protocol `docs/RESOURCES.md` uses for Playwright MCP and Chrome DevTools
 * MCP — so the numbers can sit in one table.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const sink = (() => {
  const at = process.argv.indexOf('--json')
  return at === -1 ? null : process.argv[at + 1]
})()

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>bench</title><h1>bench</h1>' +
    `<p>${'the page has to cost what a page costs. '.repeat(40)}</p>` +
    '<ul>' + Array.from({ length: 60 }, (_, i) => `<li><a href="/row-${i}">row ${i}</a></li>`).join('') + '</ul>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/page`

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'bench-resource', headless: true, restFloor: 1200, restCeiling: 1600, budgetMb: 4000 })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
const cwd = mkdtempSync(join(tmpdir(), 'dsh-bench-cwd-'))
const chat = 'session-bench-resource'
const run = (name, args) => sessionScope.run(chat, () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: chat } })))
const text = (said) => String(said?.text ?? '')

/* ps once per sample: pid, parent, cpu, rss. macOS sums shared pages per
   process, so the total overstates real memory; the neighbours are measured the
   same way, which is the only way the numbers compare. */
function tree(root) {
  const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/)).map(([pid, ppid, cpu, rss]) => ({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), rss: Number(rss) }))
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
function weigh() {
  const root = sidecar.child?.pid
  if (!root) return { mb: 0, cpu: 0, procs: 0 }
  const rows = tree(root)
  return {
    mb: Math.round(rows.reduce((sum, row) => sum + row.rss, 0) / 1024),
    cpu: Number(rows.reduce((sum, row) => sum + row.cpu, 0).toFixed(1)),
    procs: rows.length + 1,
  }
}
async function cpuOver(ms, every = 5000) {
  const samples = []
  const until = Date.now() + ms
  while (Date.now() < until) {
    samples.push(weigh().cpu)
    await wait(Math.min(every, Math.max(0, until - Date.now())))
  }
  return {
    samples_pct: samples,
    avg_pct: Number((samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)).toFixed(2)),
  }
}

const report = { generated_at: new Date().toISOString(), host: { arch: process.arch, platform: process.platform }, version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

try {
  /* Keep the rest out of the way while the page is measured. */
  const coldAt = Date.now()
  await run('browser_open', { url })
  const first = text(await run('browser_view', {}))
  report.cold_start_ms = Date.now() - coldAt
  report.view_chars = first.length
  check(first.includes('bench'), `cold start ${String(report.cold_start_ms)} ms, the view is ${String(report.view_chars)} chars`)
  check(report.cold_start_ms < 6000, 'cold start under six seconds')

  const readAt = Date.now()
  const read = text(await run('browser_read', {}))
  report.read_ms = Date.now() - readAt
  report.read_chars = read.length
  check(report.read_ms < 4000 && read.length > 200, `a read is ${String(report.read_ms)} ms and ${String(report.read_chars)} chars`)

  const evalAt = Date.now()
  for (let i = 0; i < 5; i += 1) await run('browser_eval', { code: 'document.title' })
  report.action_rtt_ms = Math.round((Date.now() - evalAt) / 5)
  check(report.action_rtt_ms < 500, `an action round trip is ${String(report.action_rtt_ms)} ms`)

  const up = weigh()
  report.open_rss_mb = up.mb
  report.open_procs = up.procs
  check(up.mb > 0, `a page open costs ${String(up.mb)} MB in ${String(up.procs)} processes`)

  /* The first seconds after a load are the page finishing; the number that
     matters is what it costs once it has finished. */
  sidecar.touch(600_000)
  await wait(5000)
  report.idle_cpu = await cpuOver(30_000)
  sidecar.touch(600_000)
  await wait(2000)
  const idle = weigh()
  report.idle_rss_mb = idle.mb
  check(true, `idle 30 s: ${String(idle.mb)} MB, ${String(report.idle_cpu.avg_pct)} % cpu`)

  /* The reversible park: the page keeps its DOM, the process keeps its share. */
  const frozenAt = Date.now()
  await sidecar.pageFor(chat)?.freeze()
  await wait(3000)
  const frozen = weigh()
  report.freeze_ms = Date.now() - frozenAt
  report.frozen_rss_mb = frozen.mb
  const frozenCpu = await cpuOver(6000)
  report.frozen_cpu_pct = frozenCpu.avg_pct
  check(report.frozen_rss_mb <= idle.mb + 8, `frozen costs ${String(report.frozen_rss_mb)} MB, was ${String(idle.mb)} MB`)

  const thawAt = Date.now()
  await sidecar.pageFor(chat)?.thaw()
  const quick = text(await run('browser_view', {}))
  report.thaw_ms = Date.now() - thawAt
  check(quick.includes('bench') || quick.includes('nothing changed'), `thaw took ${String(report.thaw_ms)} ms`)

  /* The full release and the wake that costs a cold launch. */
  sidecar.touch(600)
  for (let i = 0; i < 60; i += 1) {
    await wait(200)
    if ((await sidecar.state()).alive !== true) break
  }
  const asleep = await sidecar.state()
  report.rested = asleep.alive !== true
  report.asleep_mb = asleep.memory
  check(report.rested && asleep.memory === 0, `rest releases everything (${String(asleep.memory)} bytes)`)

  /* A person coming back arrives long after the browser has finished going
     away. Timing the wake while a shutdown is still in flight charges the
     wake for work that belongs to the rest. */
  for (let i = 0; i < 50 && sidecar.closing !== null; i += 1) await wait(100)
  const settled = await sidecar.state()
  report.awake_after_rest = settled.alive === true

  const wakeAt = Date.now()
  const back = text(await run('browser_view', {}))
  report.wake_ms = Date.now() - wakeAt
  check(sidecar.pageFor(chat)?.url === url, `wake came back to ${String(sidecar.pageFor(chat)?.url)} in ${String(report.wake_ms)} ms`)
  check(back.length > 0, 'the page still reads after the wake')
} finally {
  server.close()
  await sidecar.shutdown().catch(() => {})
}

console.log('\n' + JSON.stringify(report, null, 2))
if (sink !== null) writeFileSync(sink, JSON.stringify(report, null, 2) + '\n')
console.log(failed === 0 ? '\nresource numbers hold.' : `\n${String(failed)} bench checks failed.`)
process.exitCode = failed === 0 ? 0 : 1
