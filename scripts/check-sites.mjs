#!/usr/bin/env node
/**
 * What the second read of the same site costs.
 *
 *   node scripts/check-sites.mjs
 *
 * Serves two pages on two origins: an app shell with three hundred buttons and
 * a document of twelve thousand characters. Reads each one three times and
 * checks that the first read teaches the next — the app opens as a map, the
 * document is asked for less — and that the lesson is on disk for the next run.
 * Exits non-zero when a site stops being learned.
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-sites-'))

const buttons = Array.from({ length: 300 }, (_, i) => `<button>action ${i + 1}</button>`).join('')
const app = `<!doctype html><meta charset="utf-8"><title>app shell</title>
<h1>app shell</h1><p>a shell with three hundred things to click.</p><div>${buttons}</div>`
const words = Array.from({ length: 240 }, (_, i) => `Paragraph ${i + 1}: ` + 'the quick brown fox jumps over the lazy dog and keeps running through the field '.repeat(3)).join('</p><p>')
const doc = `<!doctype html><meta charset="utf-8"><title>long document</title>
<article><h1>long document</h1><p>${words}</p></article>`

const server = createServer((request, response) => {
  const body = String(request.url ?? '').startsWith('/doc') ? doc : app
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
const appUrl = `http://127.0.0.1:${port}/app`
const docUrl = `http://localhost:${port}/doc`

const { Sidecar } = await import('../sidecar.js')
const { saveTactics, sidecarTools, sessionScope, workScope } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'sites-check', headless: true })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
const cwd = mkdtempSync(join(tmpdir(), 'dsh-sites-cwd-'))
/* Same binding the plugin does: the chat and the project a call belongs to. */
const run = (name, args) => sessionScope.run('sites-check', () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: 'sites-check' } })))
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
const text = (said) => String(said?.text ?? '')
try {
  await sidecar.launch('about:blank')
  await sidecar.watch(() => {})
  await sidecar.ensure({ session: 'sites-check' })

  await run('browser_open', { url: appUrl })
  const appFirst = text(await run('browser_view', {}))
  const appSecond = text(await run('browser_view', {}))
  const appThird = text(await run('browser_view', {}))
  console.log('--- app, third read ---\n' + appThird.slice(0, 1200))
  check(!/^map: /m.test(appFirst), 'the first read of a big site is the page itself')
  check(!/^map: /m.test(appSecond), 'one read is not yet a lesson')
  check(/^map: \d+ controls/m.test(appThird), 'the third read opens as a map of what is there')
  check(/this site reads big \(2 read\(s\)/.test(appThird), 'the map says which site it learned and why')
  check(appThird.length < appFirst.length, `the map costs less than the page (${String(appThird.length)} < ${String(appFirst.length)} chars)`)

  await run('browser_open', { url: docUrl })
  const docFirst = text(await run('browser_read', {}))
  const docSecond = text(await run('browser_read', { force: true }))
  const docThird = text(await run('browser_read', {}))
  console.log('--- doc, third read (head) ---\n' + docThird.slice(0, 400))
  console.log('--- doc, third read (tail) ---\n' + docThird.slice(-300))
  check(docFirst.length > 4000, `a long document really is long (${String(docFirst.length)} chars)`)
  check(docSecond.length > 4000, 'the forced second read is the whole thing again')
  check(/this site reads long \(2 read\(s\), ~\d{4,} chars of text\): cut at 3500 characters/.test(docThird), 'the third read says it was cut short and how to go past it')
  check(docThird.length < docFirst.length, `the learned read costs less (${String(docThird.length)} < ${String(docFirst.length)} chars)`)

  await saveTactics()
  const file = join(process.env.DSH_INNER_BROWSER_STATE_DIR, 'sites.json')
  check(existsSync(file), 'the lesson is written where the next run will find it')
  const kept = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  check(kept[`http://127.0.0.1:${port}`]?.controls >= 60, 'the app origin remembers how many controls it has')
  check(kept[`http://localhost:${port}`]?.text >= 5000, 'the document origin remembers how long its text is')
} catch (error) {
  failed += 1
  console.log('FAIL ' + String(error?.stack ?? error))
} finally {
  await sidecar.close?.().catch(() => {})
  server.close()
}
console.log(failed === 0 ? 'sites: ok' : `sites: ${String(failed)} failed`)
process.exitCode = failed === 0 ? 0 : 1
