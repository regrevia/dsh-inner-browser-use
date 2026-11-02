#!/usr/bin/env node
/**
 * Does the Flash bridge leave anything behind?
 *
 *   node scripts/check-flash-idle.mjs
 *
 * The bridge is an Electron app in its own process group. A SIGTERM it ignores
 * used to leave that group alive for hours, still rendering and still audible
 * after the column had closed. This starts a bridge in an isolated state
 * directory, puts the browser away, and then looks for survivors: the process
 * group the plugin spawned, the bridge port, and any Electron whose command
 * line still names this run's profile. Own profile, own state directory; both
 * are closed, and it runs on `about:blank` so nothing needs the network.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = mkdtempSync(join(tmpdir(), 'dsh-flash-idle-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** Whether a pid is alive right now. */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether any process in this run's own group is alive. */
function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}

const sidecar = new Sidecar({ profile: 'flash-idle', headless: false, flash: true })
try {
  await sidecar.launch('about:blank')
  await wait(6000)
  const bridge = sidecar.flashBridge
  check(Number.isInteger(bridge) && bridge > 0, `the bridge is up on port ${String(bridge)}`)
  const pid = sidecar.child?.pid
  check(Number.isInteger(pid) && alive(pid) === true, `the bridge runs as pid ${String(pid)}`)
  check(Number.isInteger(pid) && groupAlive(pid) === true, 'the bridge has a process group of its own')

  /* The picture has to be coming, or "no survivors" would be about a bridge
     that never worked. */
  const before = await fetch(`http://127.0.0.1:${String(bridge)}/frame.jpg`).then((r) => r.arrayBuffer()).catch(() => null)
  check(before !== null && before.byteLength > 1000, `a frame is ${String(before?.byteLength ?? 0)} bytes`)

  await sidecar.putAway()
  await wait(4000)

  check(alive(pid) === false, `pid ${String(pid)} is gone`)
  check(groupAlive(pid) === false, 'the whole process group is gone, not just the launcher')
  const answered = await fetch(`http://127.0.0.1:${String(bridge)}/frame.jpg`, { signal: AbortSignal.timeout(1200) }).then(() => true).catch(() => false)
  check(answered === false, 'the bridge port answers nothing')
} catch (error) {
  check(false, `the run did not throw: ${String(error?.message ?? error)}`)
} finally {
  await sidecar.shutdown().catch(() => {})
}

console.log(failed === 0 ? 'the bridge leaves nothing behind.' : `${String(failed)} check(s) failed.`)
process.exitCode = failed === 0 ? 0 : 1
