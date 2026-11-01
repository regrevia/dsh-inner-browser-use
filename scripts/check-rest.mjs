#!/usr/bin/env node
/**
 * What putting the browser to rest costs, and what waking it back up buys.
 *
 *   node scripts/check-rest.mjs
 *
 * Opens a page, lets the rest window run out with nobody watching, and checks
 * that the browser really went away — no process, no memory, a reason on the
 * record — and that the next tool call brings it back with the same page, in
 * well under the time a cold launch takes. Exits non-zero when rest gets
 * expensive, or when waking loses the page.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rest-'))

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><meta charset="utf-8"><title>rest check</title><h1>rest check</h1><p>this page has to survive a rest.</p>')
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/page`

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
/* A short window on purpose: the point is the chain, not the length. */
const sidecar = new Sidecar({ profile: 'rest-check', headless: true, restFloor: 1200, restCeiling: 1600, budgetMb: 4000 })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
const cwd = mkdtempSync(join(tmpdir(), 'dsh-rest-cwd-'))
/* Chats are `session-…` ids: the tab memory on disk only keeps those, and a
   throwaway id would lose the page across a rest instead of testing that it
   is kept. */
const chat = 'session-rest-check'
const run = (name, args) => sessionScope.run(chat, () => workScope.run(cwd, () => tool(name).execute(args, { agent: { id: chat } })))
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
const text = (said) => String(said?.text ?? '')
let sidecarDone = false
try {
  await run('browser_open', { url })
  const before = text(await run('browser_view', {}))
  check(before.includes('this page has to survive a rest'), 'the page opened')
  const upText = text(await run('browser_state', {}))
  check(upText.includes('rests in') || upText.includes('no rest scheduled'), `the state names the rest (${upText.split('\n').filter((row) => row.includes('rest')).join(' / ')})`)
  const up = await sidecar.state()
  check(up.alive === true && up.memory > 0, `the browser is up and costs ${String(up.memory)} bytes`)

  /* Nobody is watching: this is exactly the state the pane closes into. */
  sidecar.touch(1200)
  const restAt = Date.now() + 1200
  for (let i = 0; i < 60; i += 1) {
    await wait(250)
    const said = await sidecar.state()
    if (said.alive !== true) break
    if (Date.now() > restAt + 15_000) break
  }
  const asleepText = text(await run('browser_state', {}))
  check(asleepText.includes('stopped'), 'the state says the browser is stopped')
  const asleep = await sidecar.state()
  check(asleep.alive !== true, 'the browser went away when its rest ran out')
  check(asleep.memory === 0, 'no memory is held while it rests')
  check(asleep.rests >= 1, `the rest was counted (${String(asleep.rests)})`)
  check(String(asleep.error).includes('put away') || String(asleep.restNote).length > 0, `it said why (${String(asleep.error || asleep.restNote)})`)

  const asked = Date.now()
  const after = text(await run('browser_view', {}))
  const woke = Date.now() - asked
  const back = await sidecar.state()
  check(back.alive === true, 'the next call brought it back')
  /* The address is the proof: a blank mirror would say `about:blank`, and the
     read is deduplicated against the picture from before the rest. */
  check(sidecar.pageFor(chat)?.url === url, `it came back to the same address (${String(sidecar.pageFor(chat)?.url)})`)
  check(after.includes('this page has to survive a rest') || after.includes('nothing changed since the last read'), 'the page still says what it said before the rest')
  check(woke < 4000, `the wake took ${String(woke)} ms`)
  check(back.wakeMs > 0 && back.wakeMs <= woke + 50, `the sidecar timed its own wake (${String(back.wakeMs)} ms)`)
  check(back.rests >= 1, 'the count survives the wake')
} finally {
  server.close()
  if (!sidecarDone) await sidecar.shutdown().catch(() => {})
}
console.log(failed === 0 ? '\nrest and wake hold.' : `\n${String(failed)} rest checks failed.`)
process.exitCode = failed === 0 ? 0 : 1
