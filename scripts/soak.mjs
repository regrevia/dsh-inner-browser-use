#!/usr/bin/env node
/**
 * Does a long session grow without bound?
 *
 *   node scripts/soak.mjs [cycles]
 *
 * One headless browser, one tab, one chat, over and over: open a page, read it,
 * take a snapshot, read the same page again (the unchanged short-circuit), open
 * the other page. Memory and page count are sampled every few cycles. The run
 * fails when RSS climbs past the ceiling or a second tab appears, so a leak in
 * the screencast, the CDP client or the read cache shows up as a number here
 * instead of as a slow machine next week.
 *
 * Bounded on purpose: 24 cycles by default, about twenty seconds, no internet.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-soak-'))
const cycles = Math.max(4, Math.min(Number(process.argv[2] ?? 24) || 24, 200))

const buttons = Array.from({ length: 120 }, (_, i) => `<button>action ${i + 1}</button>`).join('')
const words = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: ` + 'the quick brown fox jumps over the lazy dog. '.repeat(6)).join('</p><p>')
const pages = {
  '/app': `<!doctype html><meta charset="utf-8"><title>app shell</title><h1>app shell</h1><div>${buttons}</div>`,
  '/doc': `<!doctype html><meta charset="utf-8"><title>long document</title><article><h1>long document</h1><p>${words}</p></article>`,
}

const server = createServer((request, response) => {
  const body = pages[String(request.url ?? '').split('?')[0]] ?? pages['/app']
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const appUrl = `http://127.0.0.1:${port}/app`
const docUrl = `http://127.0.0.1:${port}/doc`

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const sidecar = new Sidecar({ profile: 'soak', headless: true })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
const cwd = mkdtempSync(join(tmpdir(), 'dsh-soak-cwd-'))
/* Same binding the plugin does: the chat and the project a call belongs to. */
const run = (name, args) => sessionScope.run('soak', () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: 'soak' } })))
const text = (said) => String(said?.text ?? '')

/* macOS reports every renderer's RSS in full, shared pages included, so a
   healthy headless tree sits far above what one page needs; the bar is a
   ceiling this machine never approaches plus growth over the run. */
const ceilingMb = 2500
const samples = []
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

const startedAt = Date.now()
try {
  await sidecar.launch('about:blank')
  await sidecar.watch(() => {})
  await sidecar.ensure({ session: 'soak' })

  let reads = 0
  let snapshots = 0
  for (let i = 0; i < cycles; i += 1) {
    const url = i % 2 === 0 ? appUrl : docUrl
    await run('browser_open', { url })
    reads += text(await run('browser_view', {})).length > 0 ? 1 : 0
    await run('browser_view', {})
    if (i % 3 === 0) {
      snapshots += 1
      await run('browser_shot', {})
    }
    if (i % 2 === 1) await run('browser_read', {})
    if (i % 4 === 3 || i === cycles - 1) {
      /* sidecar.state() already reports what the whole process tree holds, so
         no pid has to be found and no second sampling path exists. */
      const state = await sidecar.state()
      const mb = Math.round(Number(state?.memory ?? 0) / 1e6)
      samples.push({ cycle: i + 1, mb, pages: Number(state?.pages ?? 0) })
      console.log(`     cycle ${String(i + 1).padStart(3)} · ${String(mb)} MB · pages ${String(state?.pages)}`)
    }
    /* A quiet moment, so a leak in the close/reopen path is not hidden by the
       next navigation arriving before the old page is gone. */
    if (i % 6 === 5) await new Promise((settle) => setTimeout(settle, 250))
  }

  const first = samples[0] ?? { mb: 0 }
  const last = samples.at(-1) ?? first
  const growth = last.mb - first.mb
  const seconds = Math.round((Date.now() - startedAt) / 100) / 10
  check(reads > 0, `the browser answered every cycle (${String(reads)} of ${String(cycles)})`)
  check(samples.every((one) => one.pages <= 1), `one page per chat is kept (max ${String(Math.max(...samples.map((one) => one.pages)))})`)
  check(last.mb < ceilingMb, `RSS stays inside this machine's ceiling (${String(last.mb)} < ${String(ceilingMb)} MB)`)
  check(growth < 250, `RSS growth over ${String(cycles)} cycles is bounded (${growth >= 0 ? '+' : ''}${String(growth)} MB)`)
  console.log(`soak: ${failed === 0 ? 'ok' : `${String(failed)} failed`} · ${String(cycles)} cycles, ${String(seconds)} s, rss ${String(first.mb)} → ${String(last.mb)} MB, pages ${String(last.pages)}, ${String(snapshots)} shots, ${String(reads)} reads`)
} catch (error) {
  failed += 1
  console.log('FAIL ' + String(error?.stack ?? error))
} finally {
  await sidecar.close?.().catch(() => {})
  server.close()
}
process.exitCode = failed === 0 ? 0 : 1
