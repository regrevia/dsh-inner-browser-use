#!/usr/bin/env node
/**
 * Report what this plugin can see right now: the bridge, which chats have a
 * page, where their files would land, and whether the inner browser keeps its
 * cookies on disk. Run it while the app is open; it changes nothing.
 *
 *   node scripts/doctor.mjs
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROUTE = '/dsh-inner-browser-use'
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/**
 * The bridge answers on the same address as the app's own window, and the app
 * picks that port each time it starts, so the addresses to try are the one that
 * was asked for, then the one the running app is listening on.
 * @returns {Promise<string[]>} candidate addresses, without a trailing slash.
 */
async function addresses() {
  const asked = (process.env.DSH_BRIDGE ?? '').trim().replace(/\/+$/, '')
  const found = asked === '' ? [] : [asked]
  found.push('http://127.0.0.1:49661')
  try {
    const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'DeepSeek'], { timeout: 4_000 })
    for (const line of String(stdout).split('\n')) {
      const hit = /127\.0\.0\.1:(\d{4,5})\s/.exec(line)
      if (hit !== null) {
        const address = `http://127.0.0.1:${hit[1]}`
        if (found.includes(address) === false) found.push(address)
      }
    }
  } catch {
    /* no lsof, or nothing listening: the fixed address is all that is left */
  }
  return found
}

let base = ''

/**
 * @param {string} path - route under the bridge.
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

const state = await get(`${ROUTE}/state`)
console.log(`bridge   ${state === null ? 'not answering' : 'answering'}`)
if (state === null) {
  console.log('         start the app, or set DSH_BRIDGE to the bridge address')
  process.exit(0)
}

const client = state.client
const age = client?.at === undefined ? '' : ` (${Math.round((Date.now() - Date.parse(client.at)) / 1000)}s ago)`
console.log(`page     ${client === undefined ? 'no page has reported yet' : `${client.session ?? 'unknown chat'}${age}`}`)
console.log(`chats    ${state.connected.length === 0 ? 'none open' : state.connected.join(', ')}`)
console.log(`waiting  ${state.pending}`)
for (const [chat, folder] of Object.entries(state.folders ?? {})) {
  console.log(`files    ${chat} -> ${folder === '' ? 'unknown folder' : folder}`)
}

const kept = await get(`${ROUTE}/cookies?key=doctor`).then((body) => Array.isArray(body?.cookies))
console.log(`sign-in  ${kept ? 'kept per workspace' : 'not being kept'}`)
