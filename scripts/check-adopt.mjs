/**
 * E2E: a fresh instance must attach to the browser another one left running.
 *
 * This is the reload path itself, reduced to two objects in one process: the
 * app reloads, the old half that held the browser is gone, the new half has no
 * `child` and finds the browser through the profile's `DevToolsActivePort`.
 * What matters is that the second half does not start a second Chrome — a
 * relaunch is what loses the tabs, the logins and the picture.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const state = mkdtempSync(join(tmpdir(), 'dsh-adopt-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')

const page = 'data:text/html,<title>kept</title><h1>kept</h1><button>Send</button>'
const first = new Sidecar({ profile: 'adopt-check', headless: true })
const started = Date.now()
await first.ensure({ session: 'session-adopt-a', url: page })
const firstMs = Date.now() - started
const chrome = Number(first.child?.pid ?? 0)
if (chrome === 0) throw new Error('the first instance did not start a browser')
const where = String(first.pageFor('session-adopt-a')?.url ?? '')

/* No shutdown, no handoff: the app is simply gone and this is a new half. */
const second = new Sidecar({ profile: 'adopt-check', headless: true })
const before = Date.now()
const attached = await second.ensure({ session: 'session-adopt-a', url: page })
const attachMs = Date.now() - before
const reused = chrome === Number(second.child?.pid ?? 0) || second.child === null
const aliveNow = execFileSync('ps', ['-o', 'pid=', '-p', String(chrome)], { encoding: 'utf8' }).trim() !== ''
await attached.readTitle()
const title = attached.title

console.log(JSON.stringify({
  firstMs,
  attachMs,
  chrome,
  secondChild: second.child === null ? null : Number(second.child?.pid ?? 0),
  reusedBrowser: reused && aliveNow,
  url: where,
  title,
  state,
}))

/* The second half owns the browser now: asking it to stop is the only way this
   script may end, or a headless Chrome stays behind on this machine. */
await second.shutdown()
/* Killing a pid that was already closed is noise, not a cleanup: look first. */
const stillThere = (() => {
  try {
    return execFileSync('ps', ['-o', 'pid=', '-p', String(chrome)], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
})()
if (stillThere) {
  try {
    execFileSync('kill', [String(chrome)])
  } catch {
    /* already gone */
  }
}
rmSync(state, { recursive: true, force: true })
