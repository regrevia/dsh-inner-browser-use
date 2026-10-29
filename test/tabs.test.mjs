import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/* The state directory is read when the driver module loads, so point it at a
   scratch place before importing: these tests never touch the real browser. */
const dir = mkdtempSync(join(tmpdir(), 'dshib-tabs-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = dir

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools } = await import('../tools.js')

function driver() {
  /* Nothing here starts Chrome: only the note file is under test. */
  return Object.create(Sidecar.prototype)
}

test('only a chat address is remembered, and only for a chat', () => {
  const sidecar = driver()
  sidecar.rememberTab('session-abc', 'https://example.com/a')
  sidecar.rememberTab('chat-a', 'https://example.com/b')
  sidecar.rememberTab('session-abc', 'about:blank')
  sidecar.rememberTab('', 'https://example.com/c')
  const saved = JSON.parse(readFileSync(join(dir, 'tabs.json'), 'utf8'))
  assert.deepEqual(saved, { 'session-abc': 'https://example.com/a' })
  assert.equal(sidecar.rememberedTab('chat-a'), '')
  assert.equal(sidecar.rememberedTab('session-abc'), 'https://example.com/a')
})

test('a file left by an older run is not restored for a non-chat key', () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tabs.json'), JSON.stringify({ 'chat-a': 'https://example.com/old' }))
  const sidecar = driver()
  assert.equal(sidecar.rememberedTab('chat-a'), '')
})

test('closing a tab says which page was closed, not which is left', async () => {
  const closed = []
  const sidecar = {
    alive: true,
    ensure: async () => ({}),
    tabs: async () => [{ url: 'http://x/dense', title: 'Dense' }, { url: 'http://x/light', title: 'Light' }],
    closeTab: async (index) => { closed.push(index) },
    pageFor: () => ({ url: 'about:blank' }),
    page: { url: 'about:blank' },
  }
  const tabsTool = sidecarTools(sidecar, { last: undefined }).find((tool) => tool.name === 'browser_tabs')
  const said = String((await tabsTool.execute({ action: 'close', index: 1 })).text)
  assert.deepEqual(closed, [1])
  assert.match(said, /closed tab 1 · http:\/\/x\/light/)
})
