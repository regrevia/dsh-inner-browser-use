#!/usr/bin/env node
/**
 * What `sidecar_prepare` says about a real page, and how long it takes to say it.
 *
 *   node scripts/check-prepare.mjs                       # 奥拉星
 *   node scripts/check-prepare.mjs https://www.4399.com/flash/16613.htm
 *
 * Own profile, own Chrome, both closed afterwards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://aoqi.100bt.com/'
const state = mkdtempSync(join(tmpdir(), 'dsh-prepare-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'prepare-check', headless: true })
let chrome = 0
try {
  await sidecar.launch(url)
  await wait(3000)
  chrome = sidecar.child?.pid ?? 0
  const tools = sidecarTools(sidecar, { refs: [], at: 0 }, { want: () => {} })
  const prepare = tools.find((tool) => tool.name === 'sidecar_prepare')
  const at = Date.now()
  const out = await prepare.execute({}, { agent: { id: 'prepare-check' } })
  console.log(JSON.stringify({ url, ms: Date.now() - at, says: out.text }, null, 1))
} finally {
  try {
    await sidecar.shutdown()
  } catch {
    /* a browser that already went needs no shutdown */
  }
  if (chrome !== 0) {
    try {
      process.kill(chrome, 'SIGKILL')
    } catch {
      /* it went with the socket */
    }
  }
  rmSync(state, { recursive: true, force: true })
}
