/**
 * The Flash switch has two halves: choosing the runtime, and knowing whether
 * the runtime that came up actually carries the plugin. The second half is what
 * this file pins down — a runtime that opens a port and plays nothing used to
 * look healthy from outside.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-check-'))

const { Sidecar, flashVerdict } = await import('../sidecar.js')
const { sidecarTools } = await import('../tools.js')

test('a runtime with the plugin is called loaded, and said by name', () => {
  assert.deepEqual(flashVerdict(['Shockwave Flash']), { ok: true, name: 'Shockwave Flash' })
  assert.deepEqual(flashVerdict(['PDF Viewer', 'shockwave flash']), { ok: true, name: 'shockwave flash' })
})

test('a runtime without it says so instead of guessing', () => {
  assert.deepEqual(flashVerdict([]), { ok: false, name: '' })
  assert.deepEqual(flashVerdict(['PDF Viewer']), { ok: false, name: '' })
  assert.deepEqual(flashVerdict(undefined), { ok: false, name: '' })
  assert.deepEqual(flashVerdict('Shockwave Flash'), { ok: false, name: '' })
})

test('a fresh browser has not asked the question yet', async () => {
  const sidecar = new Sidecar({ profile: 'flash-check', headless: true, flash: true })
  assert.equal(sidecar.flashCheck, null)
  const state = await sidecar.state()
  assert.equal(state.flash, true)
  assert.equal(state.flashCheck, null)
})

test('browser_state tells the plugin question apart from the runtime mode', async () => {
  const sidecar = new Sidecar({ profile: 'flash-check', headless: true, flash: true })
  const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
  const stateTool = tools.find((one) => one.name === 'browser_state')
  const said = await stateTool.execute({}, { agent: { id: 'flash-check' } })
  assert.match(said.text, /Flash-era runtime — open, plugin not checked yet/)
  /* The same browser, now with the answer: the row must carry it. */
  sidecar.flashCheck = flashVerdict(['Shockwave Flash'])
  const again = await stateTool.execute({}, { agent: { id: 'flash-check' } })
  assert.match(again.text, /Flash-era runtime — plugin loaded \(Shockwave Flash\)/)
  sidecar.flashCheck = flashVerdict(['PDF Viewer'])
  const missing = await stateTool.execute({}, { agent: { id: 'flash-check' } })
  assert.match(missing.text, /no Flash plugin is loaded/)
})

test('a Chrome browser never mentions a Flash plugin', async () => {
  const sidecar = new Sidecar({ profile: 'chrome-check', headless: true, flash: false })
  sidecar.flashCheck = flashVerdict(['Shockwave Flash'])
  const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
  const said = await tools.find((one) => one.name === 'browser_state').execute({}, { agent: { id: 'chrome-check' } })
  assert.match(said.text, /Chrome runtime/)
  assert.doesNotMatch(said.text, /plugin loaded/)
})
