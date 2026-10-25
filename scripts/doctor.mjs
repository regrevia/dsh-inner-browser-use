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
const DEFAULT_BASE = 'http://127.0.0.1:49661'
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

/** @param {string} path - route under the bridge. @returns {Promise<any>} parsed body or null. */
async function get(path) {
  try {
    const response = await fetch(process.env.DSH_BRIDGE ?? DEFAULT_BASE + path, { signal: AbortSignal.timeout(4_000) })
    if (response.ok !== true) return null
    return await response.json()
  } catch {
    return null
  }
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

const jars = existsSync(APP)
  ? await run('grep', ['-m2', '-ao', 'dsh-sidebar-browser-', APP], { maxBuffer: 1 << 22 })
      .then((out) => out.stdout.trim() !== '')
      .catch(() => false)
  : false
console.log(`memory   ${jars ? 'a login lasts until the app quits' : 'the app bundle is not where expected'}`)
