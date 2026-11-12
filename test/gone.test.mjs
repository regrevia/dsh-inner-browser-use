import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/* The state directory is read when the driver module loads, so point it at a
   scratch place before importing: nothing here starts Chrome. */
const dir = mkdtempSync(join(tmpdir(), 'dshib-gone-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = dir

const { deathNote, noteDeath, portWaitFailure } = await import('../sidecar.js')
const { goneMidRead, sidecarTools } = await import('../tools.js')

const SNAP = { url: 'http://x/dense', title: 'Dense', text: 'words that were true a moment ago', controls: [], frames: [], cursor: '', bytes: 12 }

/** A page that answers every read with the same words, and a driver whose
 *  liveness the test decides. @param {() => boolean} alive - is it running. */
function rig(alive) {
  const page = {
    url: 'http://x/dense',
    title: 'Dense',
    wantUrl: 'http://x/dense',
    evaluate: async () => JSON.stringify(SNAP),
    send: async () => ({}),
    cdp: { send: async () => ({}), closed: false },
    crashing: () => false,
    troubleOf: () => '',
  }
  const sidecar = { headless: true, flash: false, ensure: async () => page, holdOf: () => '' }
  Object.defineProperty(sidecar, 'alive', { get: alive })
  const tools = sidecarTools(sidecar, { last: undefined })
  const find = (name) => tools.find((tool) => tool.name === name)
  return { page, sidecar, view: find('browser_view'), open: find('browser_open') }
}

test('a browser that closed mid-read is reported, and its last words are not', async () => {
  let running = true
  const one = rig(() => running)
  const live = String((await one.view.execute({})).text)
  assert.match(live, /Dense/)

  running = false
  /* The same read, from a browser that is gone: the snapshot is a lie now. */
  const gone = String((await one.view.execute({})).text)
  assert.equal(gone, goneMidRead({ alive: false }))
  assert.doesNotMatch(gone, /words that were true a moment ago/)
  assert.match(gone, /browser_open/)
})

test('opening a page from a browser that stopped says so instead of the page', async () => {
  const one = rig(() => false)
  const said = String((await one.open.execute({ url: 'http://x/dense' })).text)
  assert.equal(said, goneMidRead({ alive: false }))
  assert.doesNotMatch(said, /words that were true a moment ago/)
})

test('a running browser is never refused for being alive', () => {
  assert.equal(goneMidRead({ alive: true }), '')
  assert.notEqual(goneMidRead({ alive: false }), '')
  assert.notEqual(goneMidRead({}), '')
})

test('a browser that ends by itself always leaves a line, however fast', () => {
  const fast = deathNote({ pid: 91777, code: 0, signal: null, profile: 'default', fast: true, ms: 900 })
  assert.match(fast, /exit code 0/)
  assert.match(fast, /after ms 900/)
  const quiet = deathNote({ pid: 1, code: 0, signal: null, profile: 'default' })
  assert.doesNotMatch(quiet, /after ms/)
})

test('what Chrome printed on its way out is quoted in the log', () => {
  const line = deathNote({ pid: 12, code: 21, signal: null, profile: 'p', fast: true, ms: 120, err: 'Failed to create a ProcessSingleton\nAborting now\n' })
  assert.match(line, /stderr Failed to create a ProcessSingleton Aborting now/)
  assert.doesNotMatch(line, /\n/)
})

test('a death that was asked for is still not a death', () => {
  const log = join(dir, 'browser.log')
  const before = existsSync(log) ? readFileSync(log, 'utf8') : ''
  noteDeath({ pid: 1, code: 0, signal: null, profile: 'default', asked: true }, dir)
  const after = existsSync(log) ? readFileSync(log, 'utf8') : ''
  assert.equal(after, before)
  noteDeath({ pid: 2, code: 0, signal: null, profile: 'default', fast: true, ms: 700, err: 'Trying to load the allocator multiple times' }, dir)
  const text = readFileSync(log, 'utf8')
  assert.match(text, /pid 2 profile default exit code 0 signal none after ms 700 stderr Trying to load/)
})

test('a browser that ends before its port is not waited for until the deadline', () => {
  assert.equal(portWaitFailure(null), '')
  const said = portWaitFailure({ code: 21, signal: null, ms: 123, err: 'Failed to create a ProcessSingleton\nfor your profile directory.\n' })
  assert.match(said, /exit code 21/)
  assert.match(said, /after 123 ms/)
  assert.match(said, /Failed to create a ProcessSingleton for your profile directory\./)
  assert.doesNotMatch(said, /\n/)
  assert.match(portWaitFailure({ code: null, signal: 'SIGKILL', ms: 40 }), /signal SIGKILL/)
  /* Long stderr is cut, and cut from the front: the end is what names the cause. */
  const long = portWaitFailure({ code: 1, signal: null, ms: 9, err: 'x'.repeat(400) + 'THE CAUSE' })
  assert.match(long, /THE CAUSE/)
  assert.ok(long.length < 400)
})
