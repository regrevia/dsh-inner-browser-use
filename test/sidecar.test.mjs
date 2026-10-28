import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Sidecar, SidecarPage, VIEW, canArmWatcher, deathNote, looksLikeApp, noteDeath } from '../sidecar.js'

/** A CDP session that records what the page asked for and never answers with
 * anything of its own: these tests are about what the page tells its viewers. */
function fakeCdp() {
  const sent = []
  return {
    sent,
    send: async (method, params) => {
      sent.push([method, params])
      return {}
    },
    on: () => {},
    close: () => {},
  }
}

test('the agent arrow moves at once, without waiting for a picture', () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')
  /** @type {any[]} */
  const seen = []
  page.pointerSinks.add((message) => seen.push(message))

  page.movePointer({ x: 10.4, y: 20.6 })

  assert.deepEqual(seen, [
    { type: 'pointer', w: VIEW.width, h: VIEW.height, pointer: { x: 10, y: 21 } },
  ])
  assert.deepEqual(cdp.sent, [], 'a pointer message is not a CDP round trip')
})

test('a hand on the page hovers it without moving the agent arrow', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')
  const before = page.pointer
  /** @type {any[]} */
  const seen = []
  page.pointerSinks.add((message) => seen.push(message))

  const cursor = await page.hover({ x: 300, y: 200 })

  assert.deepEqual(page.pointer, before, 'the person moving their mouse must not take the arrow over')
  assert.deepEqual(seen, [], 'the arrow is drawn by the agent, not by every hover')
  assert.deepEqual(cdp.sent[0], [
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: 300, y: 200, button: 'none', buttons: 0, clickCount: 0, pointerType: 'mouse' },
  ])
  assert.equal(cdp.sent[1][0], 'Runtime.evaluate', 'the page is asked what cursor it wants there')
  assert.equal(typeof cursor, 'string', 'a page that cannot answer still yields a usable cursor')
})

test('a viewer that goes away stops receiving pointer messages', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')
  const seen = []
  const sink = (/** @type {any} */ message) => seen.push(message)

  page.pointerSinks.add(sink)
  page.movePointer({ x: 1, y: 2 })
  page.pointerSinks.delete(sink)
  page.movePointer({ x: 3, y: 4 })

  assert.equal(seen.length, 1)
})

/** A browser that answers and records how it was asked for, without Chrome. */
function fakeBrowser(record) {
  const sidecar = new Sidecar({ profile: 'pretend' })
  sidecar.launch = async (url) => {
    record.push(['launch', sidecar.headless, url])
    sidecar.cdp = { closed: false, send: async () => {}, close() {} }
    sidecar.page = { lastUrl: url ?? '', ping: async () => ({ ok: true }) }
    return sidecar.page
  }
  sidecar.shutdown = async () => {
    record.push(['shutdown'])
    sidecar.cdp = null
    sidecar.page = null
  }
  return sidecar
}

test('asking for the other kind of browser restarts it, once', async () => {
  const record = []
  const sidecar = fakeBrowser(record)
  await sidecar.ensure({ headless: true, url: 'https://a.test/' })
  await sidecar.ensure({ headless: true })
  await sidecar.ensure({})
  assert.deepEqual(record, [['launch', true, 'https://a.test/']], 'the same mode never restarts the browser')

  await sidecar.ensure({ headless: false })
  assert.deepEqual(record, [
    ['launch', true, 'https://a.test/'],
    ['shutdown'],
    ['launch', false, 'https://a.test/'],
  ], 'the other mode restarts it, and comes back on the same page')
})

test('a browser nobody has touched yet is free to act on', () => {
  const sidecar = new Sidecar({ profile: 'pretend' })
  assert.equal(sidecar.holding(), 0, 'no hand on the mirror means nothing to wait for')
  assert.equal(sidecar.person.seen, true)
  sidecar.holdMs = 5000
  sidecar.humanUse({ kind: 'click', x: 1, y: 2 })
  assert.ok(sidecar.holding() > 0, 'a hand on the page holds the agent off')
  sidecar.release()
  assert.equal(sidecar.holding(), 0)
  // A driver that lost the record mid-flight answers instead of throwing.
  delete sidecar.person
  assert.equal(sidecar.holding(), 0)
  sidecar.release()
  assert.equal(sidecar.holding(), 0)
})

test('a chat whose tab is gone is told where it was, so the pane can offer it back', async () => {
  const sidecar = Object.create(Sidecar.prototype)
  sidecar.pages = new Map()
  sidecar.rememberedTab = () => 'https://example.com/today'
  const lost = await sidecar.chatState('session-a')
  assert.equal(lost.alive, false, 'no tab means no picture')
  assert.equal(lost.remembered, 'https://example.com/today', 'the address survives the tab')
  const page = { url: 'https://example.com/now', title: 'now', frames: new Set() }
  sidecar.pageFor = () => page
  const there = await sidecar.chatState('session-a')
  assert.equal(there.alive, true)
  assert.equal(there.url, 'https://example.com/now')
  assert.equal(there.remembered, 'https://example.com/today', 'a live tab still remembers where it came from')
})

test('two calls that start together share one tab instead of opening a twin', async () => {
  const sidecar = Object.create(Sidecar.prototype)
  sidecar.pages = new Map()
  sidecar.opening = new Map()
  sidecar.page = null
  /** @type {string[]} */
  const went = []
  let made = 0
  sidecar.openTab = async () => {
    made += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return {
      id: made,
      url: 'about:blank',
      navigate: async (url) => {
        went.push(url)
        sidecar.pages.set('session-a', { id: made, url, navigate: async () => {} })
      },
    }
  }
  const [first, second] = await Promise.all([
    sidecar.tabFor('session-a'),
    sidecar.tabFor('session-a', 'https://example.com/next'),
  ])
  assert.equal(made, 1, 'one tab, not two')
  assert.equal(first.id, second.id)
  assert.deepEqual(went, ['https://example.com/next'], 'the later address is followed in the same tab')
  assert.equal(sidecar.opening.size, 0, 'the note is cleared once the tab exists')
})

test('asking for a blank page returns at once instead of waiting for a page to arrive', async () => {
  const page = Object.create(SidecarPage.prototype)
  const sent = []
  page.cdp = { send: async (method) => { sent.push(method); return {} } }
  page.url = 'about:blank'
  page.title = ''
  page.readTitle = async () => {}
  const at = Date.now()
  const where = await page.navigate('about:blank')
  const took = Date.now() - at
  assert.equal(where.url, 'about:blank')
  assert.equal(sent[0], 'Page.navigate')
  assert.ok(took < 2000, `blank navigation took ${took} ms`)
})

test('a plugin reload hands the browser on instead of closing it', async (t) => {
  if (!canArmWatcher()) return t.skip('a watcher only arms inside the application, and never on Windows')
  const sidecar = Object.create(Sidecar.prototype)
  const asked = []
  const closed = []
  sidecar.page = { cookies: async () => [] }
  sidecar.cdp = { send: async (method) => { asked.push(method); return {} }, close: () => closed.push('cdp') }
  sidecar.child = { pid: 999_999, kill: () => closed.push('child') }
  sidecar.profile = 'unit-cookie'
  sidecar.backup = undefined
  sidecar.pages = new Map()
  /* The note and the watcher go to a scratch directory: a unit test must not
     arm, or disarm, the guard that owns the real browser. */
  const dir = mkdtempSync(join(tmpdir(), 'dshib-watch-'))
  const before = process.env.DSH_INNER_BROWSER_STATE_DIR
  process.env.DSH_INNER_BROWSER_STATE_DIR = dir
  try {
    await sidecar.handoff()
  } finally {
    if (before === undefined) delete process.env.DSH_INNER_BROWSER_STATE_DIR
    else process.env.DSH_INNER_BROWSER_STATE_DIR = before
  }
  assert.deepEqual(asked, [], 'the browser is not asked to close')
  assert.deepEqual(closed, [], 'neither driver nor browser is stopped')
  const note = JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8'))
  assert.equal(note.chrome, 999_999, 'the guard knows which browser it owns')
  assert.ok(note.appPid > 1, 'it watches the application, not this instance')
  try {
    process.kill(Number(note.pid))
  } catch {
    /* it already left */
  }
})

test('a reload does not arm a second guard for one application run', async (t) => {
  if (!canArmWatcher()) return t.skip('a watcher only arms inside the application, and never on Windows')
  const dir = mkdtempSync(join(tmpdir(), 'dshib-watch-'))
  const before = process.env.DSH_INNER_BROWSER_STATE_DIR
  process.env.DSH_INNER_BROWSER_STATE_DIR = dir
  const spawnOnce = async () => {
    const sidecar = Object.create(Sidecar.prototype)
    sidecar.page = { cookies: async () => [] }
    sidecar.cdp = { send: async () => ({}), close: () => {} }
    sidecar.child = { pid: 999_998, kill: () => {} }
    sidecar.profile = 'unit-cookie'
    sidecar.backup = undefined
    sidecar.pages = new Map()
    await sidecar.handoff()
    return JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8'))
  }
  try {
    const first = await spawnOnce()
    const second = await spawnOnce()
    assert.equal(second.pid, first.pid, 'one guard per run, not one per reload')
  } finally {
    if (before === undefined) delete process.env.DSH_INNER_BROWSER_STATE_DIR
    else process.env.DSH_INNER_BROWSER_STATE_DIR = before
    try {
      const note = JSON.parse(readFileSync(join(dir, 'watcher.json'), 'utf8'))
      process.kill(Number(note.pid))
    } catch {
      /* nothing to stop */
    }
  }
})

test('a browser that died by itself leaves one readable line, and one that was asked to stop leaves none', async () => {
  const line = deathNote({ pid: 46590, code: null, signal: 'SIGKILL', profile: 'default' })
  assert.match(line, /browser pid 46590 profile default/)
  assert.match(line, /signal SIGKILL/)
  assert.match(line, /exit code none/)

  const dir = mkdtempSync(join(tmpdir(), 'dshib-death-'))
  /* A stop the plugin asked for is not news. */
  noteDeath({ pid: 1, code: 0, signal: null, profile: 'default', asked: true }, dir)
  assert.throws(() => readFileSync(join(dir, 'browser.log'), 'utf8'))

  /* This is the one nobody can see: it has to be written down. */
  noteDeath({ pid: 42, code: 9, signal: null, profile: 'default' }, dir)
  const text = readFileSync(join(dir, 'browser.log'), 'utf8')
  assert.match(text, /browser pid 42 profile default exit code 9/)
})

test('only the application is worth watching, never the node instance a reload replaces', () => {
  assert.equal(looksLikeApp('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'), true)
  /* The node instance a reload replaces: watching it closes the browser at the
     reload, which is what put an empty column in front of the person. */
  assert.equal(
    looksLikeApp('/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/index.js'),
    false,
  )
  assert.equal(looksLikeApp('/usr/local/bin/node scripts/bench.mjs'), false)
  assert.equal(looksLikeApp(''), false)
})
