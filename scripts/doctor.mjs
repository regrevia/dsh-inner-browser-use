#!/usr/bin/env node
/**
 * Report what the sidecar browser is doing right now: whether the Host answers,
 * whether a Chromium is attached, which profile it uses, and whether that
 * profile is outside the Host so logins outlive a restart. Reads only; nothing
 * is started, attached, or closed.
 *
 *   node scripts/doctor.mjs
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROUTE = '/dsh-inner-browser-use'
const PROFILES = join(homedir(), '.dsh', 'inner-browser-use', 'chrome')

/**
 * The Host picks its port each time it starts, so try the asked-for address
 * first and then whatever the running app is listening on.
 * @returns {Promise<string[]>} candidate addresses, without trailing slash.
 */
async function addresses() {
  const asked = (process.env.DSH_BRIDGE ?? '').trim().replace(/\/+$/, '')
  const found = asked === '' ? [] : [asked]
  found.push('http://127.0.0.1:60930')
  try {
    const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'DeepSeek'], { timeout: 4_000 })
    for (const line of String(stdout).split('\n')) {
      const hit = /127\.0\.0\.1:(\d{4,5})\s/.exec(line)
      if (hit === null) continue
      const address = `http://127.0.0.1:${hit[1]}`
      if (found.includes(address) === false) found.push(address)
    }
  } catch {
    /* no lsof, or nothing listening: the default address is all that is left */
  }
  return found
}

let base = ''

/**
 * @param {string} path - route under this plugin.
 * @returns {Promise<any>} parsed body, or null when no address answers.
 */
async function get(path) {
  const tried = base === '' ? await addresses() : [base]
  for (const address of tried) {
    try {
      const response = await fetch(address + path, { signal: AbortSignal.timeout(4_000) })
      if (response.ok !== true) continue
      base = address
      return await response.json()
    } catch {
      /* the next address may be the one this app is on */
    }
  }
  return null
}

const state = await get(`${ROUTE}/sidecar/state`)
console.log(`host     ${state === null ? `not answering under ${ROUTE}` : base}`)
if (state === null) {
  console.log('         start the app, or set DSH_BRIDGE to the app address')
  process.exitCode = 0
}

if (state !== null) {
console.log(`browser  ${state.alive === true ? `attached, ${state.headless === true ? 'headless' : 'with a window'}` : 'not running'}`)
const profileDir = join(PROFILES, String(state.profile ?? ''))
console.log(`profile  ${state.profile} in ${profileDir}`)
console.log(`stored   ${existsSync(profileDir) ? 'on disk, so cookies and logins survive a restart' : 'not created yet'}`)
if (state.alive === true) {
  console.log(`page     ${String(state.title ?? '') === '' ? String(state.url ?? '') : state.title}`)
  console.log(`viewers  ${state.viewers} | frames ${state.frames} | pointer ${state.pointer === null ? 'none' : `${state.pointer.x},${state.pointer.y}`}`)
}

const portFile = join(profileDir, 'DevToolsActivePort')
if (existsSync(portFile)) {
  const [port = '', path = ''] = readFileSync(portFile, 'utf8').trim().split('\n')
  console.log(`control  port ${port}, ${path.startsWith('/devtools/') ? 'endpoint file present' : 'endpoint file odd'}`)
} else {
  console.log('control  no DevToolsActivePort yet')
}

if (String(state.error ?? '') !== '') console.log(`error    ${state.error}`)
}
