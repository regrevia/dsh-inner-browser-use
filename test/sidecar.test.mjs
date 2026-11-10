import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Sidecar, SidecarPage, VIEW, canArmWatcher, WATCHER_SCRIPT, appFromTable, deathNote, jpegSize, looksLikeApp, nextQuality, noteDeath, ownsBrowser, mayClaim, pidsWithMark, rootDir } from '../sidecar.js'
import { findWords, nearestByWords } from '../tools.js'

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

test('a browser nobody draws is nobody watching, even before Chrome starts', () => {
  /* The rest timer asks this question on the close path, where a browser that
     never started is the normal case: answering has to be safe there rather
     than a throw that leaves the close unanswered. */
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-watch-${process.pid}`) })
  assert.equal(sidecar.watched(), 0)
  /* Nothing is on a clock until something asks for one. */
  assert.equal(sidecar.idle, null)
})

test('a browser nobody watches is put away when its rest is over', async () => {
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-rest-${process.pid}`) })
  /* A clock only runs on a browser that exists: a stopped browser has nothing
     to put away, and the beat says so by switching itself off. */
  sidecar.cdp = { closed: false }
  sidecar.page = { frames: new Set() }
  let shut = 0
  sidecar.shutdown = async () => {
    shut += 1
  }
  sidecar.touch(30)
  assert.ok(sidecar.idle !== null, 'the rest is on a clock')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(shut, 1, 'the browser goes away once')
  assert.equal(sidecar.idle, null, 'and the clock is off')
})

test('a browser someone watches keeps its clock running instead of closing', async () => {
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-rest-watch-${process.pid}`) })
  sidecar.cdp = { closed: false }
  sidecar.page = { frames: new Set(['viewer']) }
  let shut = 0
  sidecar.shutdown = async () => {
    shut += 1
  }
  sidecar.touch(30)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(shut, 0, 'a watched browser is not closed')
  assert.ok(sidecar.idle !== null, 'the clock starts again')
  clearTimeout(sidecar.idle)
  sidecar.idle = null
})

test('the agent arrow moves at once, without waiting for a picture', () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')
  /** @type {any[]} */
  const seen = []
  page.pointerSinks.add((message) => seen.push(message))

  page.movePointer({ x: 10.4, y: 20.6 })

  assert.deepEqual(seen, [
    { type: 'pointer', w: VIEW.width, h: VIEW.height, pointer: { x: 10, y: 21 }, hold: 0 },
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
    { type: 'mouseMoved', x: 300, y: 200, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, pointerType: 'mouse' },
  ])
  assert.equal(cdp.sent[1][0], 'Runtime.evaluate', 'the page is asked what cursor it wants there')
  assert.equal(typeof cursor, 'string', 'a page that cannot answer still yields a usable cursor')
})

test('a drag carries the held button on every move between press and release', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mousePressed', { x: 10, y: 20 })
  await page.hover({ x: 30, y: 40 })
  await page.mouse('mouseMoved', { x: 50, y: 60 })
  await page.mouse('mouseReleased', { x: 70, y: 80 })

  const events = cdp.sent.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params)
  const moves = events.filter((event) => event.type === 'mouseMoved')
  assert.equal(moves.length, 2)
  assert.equal(moves[0].buttons, 1, 'a hover while the button is down belongs to the drag')
  assert.equal(moves[0].button, 'left', 'the move names the button that is down')
  assert.equal(moves[1].buttons, 1)
  assert.equal(moves[1].button, 'left', 'naming only the count leaves a selection empty')
  assert.equal(events.find((event) => event.type === 'mousePressed').buttons, 1)
  assert.equal(events.find((event) => event.type === 'mouseReleased').buttons, 0)
  assert.equal(page.buttons, 0, 'the release leaves nothing held')
})

test('a drag move names the button that is down, so a page can select text', async () => {
  /* Chrome only runs a selection from a move that names the button it is
     dragging with: with `button: 'none'` and `buttons: 1` the press and the
     release arrive but nothing between them is a drag, so dragging across a
     sentence selected nothing at all in a real browser. */
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mousePressed', { x: 10, y: 20, button: 'left' })
  await page.mouse('mouseMoved', { x: 60, y: 20 })
  await page.mouse('mouseMoved', { x: 120, y: 20 })
  await page.mouse('mouseReleased', { x: 120, y: 20, button: 'left' })

  const moves = cdp.sent
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params]) => params)
    .filter((event) => event.type === 'mouseMoved')
  assert.deepEqual(moves.map((event) => [event.button, event.buttons]), [['left', 1], ['left', 1]])
})

test('the button named on a drag move follows the button that was pressed', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mousePressed', { x: 10, y: 20, button: 'right' })
  await page.mouse('mouseMoved', { x: 40, y: 20 })
  await page.mouse('mouseReleased', { x: 40, y: 20, button: 'right' })
  await page.mouse('mouseMoved', { x: 50, y: 20 })

  const moves = cdp.sent
    .filter(([method]) => method === 'Input.dispatchMouseEvent')
    .map(([, params]) => params)
    .filter((event) => event.type === 'mouseMoved')
  assert.deepEqual(moves.map((event) => [event.button, event.buttons]), [['right', 2], ['none', 0]], 'a move after the release names nothing')
})

test('a wheel turned mid-drag keeps the button the hand still holds', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mousePressed', { x: 10, y: 20 })
  await page.wheel({ x: 12, y: 24, dx: 0, dy: 120 })
  await page.mouse('mouseReleased', { x: 10, y: 20 })

  const events = cdp.sent.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params)
  const wheel = events.find((event) => event.type === 'mouseWheel')
  assert.equal(wheel.buttons, 1, 'a wheel that says no button is down ends a drag the hand never ended')
  assert.equal(wheel.button, 'none', 'the button that turned is not the one that was held')
  assert.deepEqual({ x: wheel.x, y: wheel.y, dy: wheel.deltaY }, { x: 12, y: 24, dy: 120 })
  assert.equal(page.buttons, 0, 'the release after the wheel still leaves nothing held')
})

test('a move no press preceded holds no button, so a page never sees a phantom drag', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mouseMoved', { x: 5, y: 6 })
  const moved = cdp.sent.find(([method]) => method === 'Input.dispatchMouseEvent')[1]
  assert.equal(moved.type, 'mouseMoved')
  assert.equal(moved.buttons, 0, 'this used to arrive with the button held before any press')
  assert.equal(page.buttons, 0)
})

test('the right button arrives as the right button, with the bit the browser uses for it', async () => {
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')

  await page.mouse('mousePressed', { x: 4, y: 5, button: 'right' })
  await page.mouse('mouseReleased', { x: 4, y: 5, button: 'right' })

  const events = cdp.sent.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params)
  assert.equal(events[0].button, 'right')
  assert.equal(events[0].buttons, 2, 'right is bit 2, so a page opens its menu instead of selecting')
  assert.equal(events[1].button, 'right')
  assert.equal(events[1].buttons, 0)
  assert.equal(page.buttons, 0, 'the menu button leaves nothing held either')
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

test('a click on a frozen page wakes it before it is sent', async () => {
  /* A frozen renderer drops input: the picture keeps coming from a bridge
     page while the click lands nowhere. Every input path has to revive first. */
  const cdp = fakeCdp()
  const page = new SidecarPage(cdp, 'default')
  page.frozen = true
  page.client = cdp

  await page.mouse('mousePressed', { x: 4, y: 6 })
  await page.mouse('mouseReleased', { x: 4, y: 6 })

  const thawed = cdp.sent.filter(([method]) => method === 'Page.setWebLifecycleState')
  assert.ok(thawed.length >= 1, 'the page is asked to run again')
  assert.equal(thawed[0][1].state, 'active')
  assert.equal(page.frozen, false, 'the page knows it is awake')
  assert.ok(
    cdp.sent.some(([method, params]) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed'),
    'the click still reaches the page',
  )
})

test('the sound switch reaches the bridge and reports what it did', async () => {
  const page = Object.create(SidecarPage.prototype)
  page.flashBridge = 9411
  /** @type {any} */
  let asked = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    asked = { url: String(url), body: JSON.parse(String(options?.body ?? '{}')) }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    assert.equal(await page.sound(true), true)
    assert.deepEqual(asked, { url: 'http://127.0.0.1:9411/sound', body: { on: true } })
    /* The pane's switch draws the state the bridge accepted, so the page keeps
       it: a switch that reports "on" while the window stayed muted lies. */
    assert.equal(page.soundOn, true)
    assert.equal(await page.sound(false), true)
    assert.deepEqual(asked.body, { on: false })
    assert.equal(page.soundOn, false)
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ ok: false }) })
    assert.equal(await page.sound(true), false)
    assert.equal(page.soundOn, false)
    page.flashBridge = null
    assert.equal(await page.sound(true), false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the state a pane polls says whether the person holds the page', async () => {
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-held-state-${process.pid}`) })
  assert.equal((await sidecar.state()).held, false)
  sidecar.takeOver()
  assert.equal((await sidecar.state()).held, true)
  sidecar.release()
  assert.equal((await sidecar.state()).held, false)
})

test('the state a pane polls says whether the page can make noise', async () => {
  /* The pane shows its sound switch only for a Flash page, so the state it
     polls already carries both halves of that answer. */
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-sound-state-${process.pid}`) })
  assert.equal((await sidecar.state()).sound, false)
  assert.equal((await sidecar.state()).flash, false)
  sidecar.soundOn = true
  assert.equal((await sidecar.state()).sound, true)
})

test('input into a parked game wakes it first, and only a real yes counts', async () => {
  /* A frozen renderer drops input while the Flash window keeps painting, so the
     page looks alive and eats the click: every way in has to wake it first. The
     bridge answers 200 with `{ok}`; a 200 alone only says the bridge is up. */
  const sent = []
  const page = new SidecarPage({ on: () => {}, send: async (method, params) => { sent.push({ method, params }); return {} } }, 'default')
  page.flashBridge = 9311
  /* Awake already: a revived page would otherwise start the mirror loop and
     hold this test's event loop open for good. */
  page.casting = true
  page.frozen = true
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), body: JSON.parse(String(options?.body ?? '{}')) })
    return { ok: true, json: async () => ({ ok: true }) }
  }
  await page.hover({ x: 12, y: 34 })
  assert.deepEqual(sent[0], { method: 'Page.setWebLifecycleState', params: { state: 'active' } })
  assert.equal(page.frozen, false)
  assert.equal(asked.at(-1).body.type, 'mouseMove')
  /* The same for a keystroke, whether it arrives through key() or straight at
     the window the way humanType does. */
  page.frozen = true
  sent.length = 0
  await page.key('keyDown', { key: 'a', text: 'a', keyCode: 65 })
  assert.deepEqual(sent[0], { method: 'Page.setWebLifecycleState', params: { state: 'active' } })
  page.frozen = true
  sent.length = 0
  assert.equal(await page.flashKey('keyDown', { key: 'b', text: 'b' }), true)
  assert.deepEqual(sent[0], { method: 'Page.setWebLifecycleState', params: { state: 'active' } })
  /* A wheel is the same road as a press: one POST carrying both deltas, no
     debugging protocol behind it when the window took the event. */
  asked.length = 0
  sent.length = 0
  await page.wheel({ x: 40, y: 50, dx: 0, dy: -120 })
  assert.deepEqual(asked.map((one) => one.body.type), ['mouseWheel'])
  assert.deepEqual({ dx: asked[0].body.deltaX, dy: asked[0].body.deltaY }, { dx: 0, dy: -120 })
  assert.equal(sent.length, 0)
  /* A bridge that says no is not a bridge that took it: the caller falls back
     instead of believing its own HTTP status. */
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false }) })
  page.lastFlashPoint = null
  assert.equal(await page.flashInput('mouseMove', { x: 1, y: 2 }), false)
  assert.equal(page.lastFlashPoint, null)
  globalThis.fetch = async () => ({ ok: false, json: async () => { throw new Error('no body') } })
  assert.equal(await page.flashInput('mouseMove', { x: 1, y: 2 }), false)
  globalThis.fetch = realFetch
  page.casting = false
  page.stopped = true
  page.flashBridge = null
})

test('a sweep finds the helpers of this bridge and no other', () => {
  const dump = [
    '  14769 /path/Electron.app/Contents/MacOS/Electron --app-path=/p DSH_FLASH_BRIDGE_PORT=9439 DSH_FLASH_UDD=/a',
    '  14772 /path/Electron.app/Contents/Frameworks/helper DSH_FLASH_BRIDGE_PORT=9439 DSH_FLASH_UDD=/a',
    /* Another session's bridge, one port away: a prefix match would eat it. */
    '  15100 /path/Electron.app/Contents/MacOS/Electron DSH_FLASH_BRIDGE_PORT=94391 DSH_FLASH_UDD=/b',
    /* Last entry in the environment: no space behind it. */
    '  16100 /path/Electron.app/Contents/Frameworks/helper DSH_FLASH_UDD=/a DSH_FLASH_BRIDGE_PORT=9439',
    '  17000 /usr/bin/ps -E -Ao pid=,command=',
    '',
  ].join('\n')
  assert.deepEqual(pidsWithMark(dump, 'DSH_FLASH_BRIDGE_PORT=9439'), [14769, 14772, 16100])
  assert.deepEqual(pidsWithMark(dump, 'DSH_FLASH_BRIDGE_PORT=94391'), [15100])
  assert.deepEqual(pidsWithMark(dump, ''), [])
  assert.deepEqual(pidsWithMark(null, 'DSH_FLASH_BRIDGE_PORT=1'), [])
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

test('a page the person took from the column stays theirs until they hand it back', () => {
  /* A stray click costs the agent a few seconds. A takeover is a decision: the
     pane says who has the page, and the agent waits until it is handed back
     instead of retrying into the hold. */
  const sidecar = new Sidecar({ profile: 'pretend' })
  sidecar.holdMs = 5000
  assert.equal(sidecar.taken, false)
  sidecar.takeOver()
  assert.equal(sidecar.taken, true)
  assert.ok(sidecar.holding() > 0, 'a takeover holds the agent off')
  /* No countdown: the same person is still there a minute later. */
  sidecar.person.at = Date.now() - 60_000
  assert.ok(sidecar.holding() > 0, 'the hold does not time out on its own')
  sidecar.release()
  assert.equal(sidecar.taken, false)
  assert.equal(sidecar.holding(), 0, 'handing it back frees the agent at once')
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

test('a failure the network took its time to give is not asked again', async () => {
  /* A browser still starting up answers a navigation with its own error page
     within a second; one that took seconds to fail is the network saying no,
     and reloading it costs another ten seconds of the same wait. */
  const slow = Object.create(SidecarPage.prototype)
  const slowSent = []
  slow.cdp = { send: async (method) => { slowSent.push(method); return {} } }
  /* The address stays blank while the network tries: the error page only
     arrives after seconds, which is the whole point. */
  slow.ticks = 0
  slow.readTitle = async () => { slow.ticks += 1; slow.url = slow.ticks > 26 ? 'chrome-error://chromewebdata/' : '' }
  const at = Date.now()
  const said = await slow.navigate('https://never-resolves-this.invalid/')
  assert.equal(said.bad, 'the page did not load', 'a page that never loaded says so')
  assert.ok(!slowSent.includes('Page.reload'), 'the network was already asked once')
  assert.ok(Date.now() - at < 4000, 'a failure that took seconds is not waited on again')

  const fresh = Object.create(SidecarPage.prototype)
  const freshSent = []
  fresh.cdp = { send: async (method) => { freshSent.push(method); return {} } }
  fresh.readTitle = async () => { fresh.url = freshSent.includes('Page.reload') ? 'https://example.com/' : 'chrome-error://chromewebdata/' }
  fresh.navAt = Date.now()
  const again = await fresh.navigate('https://example.com/')
  assert.ok(freshSent.includes('Page.reload'), 'a browser still starting up gets one more try')
  assert.equal(again.bad, undefined, 'the retry is what a slow start needs')
  assert.equal(again.url, 'https://example.com/')
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

test('a screencast frame carries the person hold and cannot throw out of the CDP callback', async () => {
  /* The person record lives on the sidecar, not on the page: a page that calls
     a method it does not have used to take the whole host down from an event
     callback. The page takes the answer as a callable, and anything the
     callback throws stays inside it. */
  const handlers = []
  const sent = []
  const cdp = {
    on: (handler) => handlers.push(handler),
    send: async (method) => {
      sent.push(method)
      return {}
    },
  }
  let hold = 0
  const page = new SidecarPage(cdp, 'unit-hold', 0, () => hold)
  await page.start()
  assert.equal(handlers.length, 2, 'the frame fan-out and the navigation note')
  /** @type {any[]} */
  const seen = []
  page.frames.add((message) => seen.push(message))
  const frame = { method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 1 } }
  handlers[0](frame)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].hold, 0)
  hold = 2400
  /* Frames are paced to the pane's eye, not the page's frame rate. */
  page.sentAt = Date.now() - 100
  handlers[0]({ method: 'Page.screencastFrame', params: { data: 'abcd', sessionId: 2 } })
  assert.equal(seen[1].hold, 2400)
  page.sentAt = Date.now() - 100
  /* The same picture twice is acked once and shown once: a page at rest used to
     spend a full JPEG per frame saying nothing had changed. A second later the
     same bytes still go out, so the pane can tell a quiet page from a dead
     stream. */
  handlers[0]({ method: 'Page.screencastFrame', params: { data: 'abcd', sessionId: 3 } })
  assert.equal(seen.length, 2)
  assert.equal(page.quiet, 1)
  page.lastShotAt = Date.now() - 2000
  handlers[0]({ method: 'Page.screencastFrame', params: { data: 'abcd', sessionId: 4 } })
  assert.equal(seen.length, 3, 'the heartbeat keeps the stream looking alive')
  /* A hold that throws is a fault of that frame, not of the application. */
  const broken = new SidecarPage(cdp, 'unit-hold-broken', 0, () => {
    throw new Error('no person record')
  })
  const brokenHandlers = []
  broken.cdp = { on: (handler) => brokenHandlers.push(handler), send: async () => ({}) }
  await broken.start()
  assert.doesNotThrow(() => brokenHandlers[0](frame))
  assert.match(String(broken.fault), /no person record/)
  /* The arrow leaves the moment the person's hand lands, not when the page
     next repaints: a still page can stay still for a second and a half. */
  const arms = []
  page.pointerSinks.add((message) => arms.push(message))
  page.pointer = { x: 40, y: 60 }
  hold = 6000
  page.announceHold()
  assert.equal(arms.length, 1)
  assert.equal(arms[0].type, 'pointer')
  assert.equal(arms[0].hold, 6000)
  assert.deepEqual(arms[0].pointer, { x: 40, y: 60 })
  const angry = new SidecarPage(cdp, 'unit-hold-angry', 0, () => 1)
  angry.pointerSinks.add(() => {
    throw new Error('closed viewer')
  })
  assert.doesNotThrow(() => angry.announceHold())
  /* A page that does open a tab is followed as soon as discovery announces it,
     not when the fallback window runs out; a page that opens nothing still
     ends when the window does. */
  const wokenAt = Date.now()
  const waiting = page.waitPopup(500)
  page.wakePopup()
  await waiting
  const woken = Date.now() - wokenAt
  assert.ok(woken < 200, `a popup wake took ${String(woken)} ms`)
  const windowAt = Date.now()
  await page.waitPopup(30)
  const windowMs = Date.now() - windowAt
  assert.ok(windowMs >= 25 && windowMs < 200, `the window was ${String(windowMs)} ms`)
  assert.doesNotThrow(() => page.wakePopup(), 'waking nobody waiting is not a fault')
  /* A new tab is announced before it knows its address. A click that closes it
     for having no address loses the page it meant to open, so the wait takes
     the address the moment the tab says it. */
  const said = page.waitUrl('tab-a', 500)
  page.urlDoor({ id: 'tab-b', url: 'http://127.0.0.1/other' })
  page.urlDoor({ id: 'tab-a', url: 'http://127.0.0.1/child' })
  assert.equal(await said, 'http://127.0.0.1/child')
  /* A click answers before a page's own timer opens its tab: following it then
     costs no latency. Arming twice keeps one timer, and a new call clears it. */
  page.armFollow(50)
  page.armFollow(50)
  assert.ok(page.followUntil > Date.now(), 'an announced tab is followed after the click answered')
  page.disarmFollow()
  assert.equal(page.followUntil, 0, 'a new call is not under the last click')
  assert.doesNotThrow(() => page.disarmFollow(), 'clearing twice is not a fault')
  const ceilingAt = Date.now()
  assert.equal(await page.waitUrl('tab-c', 30), '')
  assert.ok(Date.now() - ceilingAt >= 25, 'a tab that never says where it goes ends the wait')
  rmSync(join(homedir(), '.dsh', 'inner-browser-use', 'chrome', 'unit-hold'), { recursive: true, force: true })
  rmSync(join(homedir(), '.dsh', 'inner-browser-use', 'chrome', 'unit-hold-broken'), { recursive: true, force: true })
})

/** A frame asks the page its size in a later turn; these tests read after it answers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

test('a page that grows under a running cast is mirrored at its own size, once', async () => {
  /* Frames are capped at the size the cast was started with, so a page that
     grew comes back downsampled and the pane rescales a soft picture. The cast
     follows the new size, but a window being dragged reports a size every few
     frames: one restart is enough, and it happens once the window settles. */
  const handlers = []
  const sent = []
  const cdp = { on: (handler) => handlers.push(handler), send: async (method, params) => { sent.push({ method, params }); return { data: 'still' } } }
  const page = new SidecarPage(cdp, 'unit-grow', 0, () => 0)
  await page.start()
  page.casting = true
  page.castQuality = 62
  /* Freeze the quality ramp: this test counts restarts caused by the size. */
  page.adaptAt = Date.now()
  page.sentAt = 0
  const cast = (data, width, height) => {
    page.sentAt = 0
    handlers[0]({ method: 'Page.screencastFrame', params: { data, sessionId: 31, metadata: { deviceWidth: width, deviceHeight: height } } })
  }
  cast('grow-a', 1920, 1080)
  await settle()
  assert.deepEqual({ ...page.view }, { width: 1920, height: 1080 }, 'the size is adopted as soon as the page answers')
  assert.equal(sent.filter((row) => row.method === 'Page.startScreencast').length, 0, 'the restart waits for the window to settle')
  cast('grow-b', 1600, 900)
  cast('grow-c', 1600, 900)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const started = sent.filter((row) => row.method === 'Page.startScreencast')
  assert.equal(started.length, 1, 'one restart for the whole drag')
  assert.equal(started[0].params.maxWidth, 1600)
  assert.equal(started[0].params.maxHeight, 900)
  /* A cast being stopped takes its pending restart with it. */
  page.casting = true
  cast('grow-d', 1800, 1000)
  await page.stopCast()
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(sent.filter((row) => row.method === 'Page.startScreencast').length, 1, 'no restart after the cast stopped')
})

test('a frame that arrives at another size teaches the page its size', async () => {
  /* A window keeps its own size, and a display scale can change it at any
     time. The frame itself carries the size the page laid out at, so the one
     number the picture, the click mapping and the frame header all use is the
     size the browser reports, not the size anyone asked for. */
  const own = []
  const sized = new SidecarPage({ on: (handler) => own.push(handler), send: async () => ({}) }, 'unit-size', 0, () => 0)
  await sized.start()
  const sizedSeen = []
  sized.frames.add((message) => sizedSeen.push(message))
  assert.deepEqual({ ...sized.view }, { width: 1440, height: 900 })
  sized.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'sized-one', sessionId: 21, metadata: { deviceWidth: 1000, deviceHeight: 700 } },
  })
  await settle()
  assert.deepEqual({ ...sized.view }, { width: 1000, height: 700 }, 'the frame wins over the request')
  sized.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'sized-one-b', sessionId: 25, metadata: { deviceWidth: 1000, deviceHeight: 700 } },
  })
  assert.equal(sizedSeen.at(-1).w, 1000, 'the next frame header is the size the page reports')
  assert.equal(sizedSeen.at(-1).h, 700)
  /* A size no screen has is noise from a frame, not a layout. */
  sized.sentAt = 0
  sized.lastShotAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'sized-two', sessionId: 22, metadata: { deviceWidth: 12, deviceHeight: 9 } },
  })
  await settle()
  assert.deepEqual({ ...sized.view }, { width: 1000, height: 700 }, 'a bad size changes nothing')
  /* A 4K display at 100% zoom lays a page out wider than any mirror picture:
     the picture is capped in pixels, the page is not. */
  sized.sentAt = 0
  sized.lastShotAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'sized-three', sessionId: 23, metadata: { deviceWidth: 3000, deviceHeight: 1600 } },
  })
  await settle()
  assert.deepEqual({ ...sized.view }, { width: 3000, height: 1600 }, 'a wide page is still a page')
  /* Beyond any window a browser can lay out, a number is noise. */
  sized.sentAt = 0
  sized.lastShotAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'sized-four', sessionId: 24, metadata: { deviceWidth: 9000, deviceHeight: 1600 } },
  })
  await settle()
  assert.deepEqual({ ...sized.view }, { width: 3000, height: 1600 }, 'a size no window has is not a page')
})

test('a scaled display is measured in the page pixels its input is counted in', async () => {
  /* Windows at 150%: the screencast reports its frame in device pixels, so a
     3000x1800 frame is a page laid out at 2000x1200. Believing the frame makes
     the mirror the wrong shape and puts every click half again as far from the
     corner as the hand went; the page's own layout is the size to trust. */
  const own = []
  let layout = { cssLayoutViewport: { clientWidth: 2000, clientHeight: 1200 } }
  const scaled = new SidecarPage({
    on: (handler) => own.push(handler),
    send: async (method) => (method === 'Page.getLayoutMetrics' ? layout : {}),
  }, 'unit-scaled', 0, () => 0)
  await scaled.start()
  const frames = []
  scaled.frames.add((message) => frames.push(message))
  scaled.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'scaled-one', sessionId: 41, metadata: { deviceWidth: 3000, deviceHeight: 1800 } },
  })
  await settle()
  assert.deepEqual({ ...scaled.view }, { width: 2000, height: 1200 }, 'the layout wins over the device frame size')
  /* The frame that taught the size was already on its way out with the old
     header; the next one, and every one after it, carries the page pixels the
     input is mapped onto. */
  scaled.sentAt = 0
  scaled.lastShotAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'scaled-one-b', sessionId: 43, metadata: { deviceWidth: 3000, deviceHeight: 1800 } },
  })
  assert.equal(frames.at(-1).w, 2000, 'the picture header is in page pixels too')
  assert.equal(frames.at(-1).h, 1200)
  /* A page that cannot say how it is laid out still gets followed, or a window
     resize on a browser that refuses the call would stop moving the mirror. */
  layout = {}
  scaled.sentAt = 0
  scaled.lastShotAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'scaled-two', sessionId: 42, metadata: { deviceWidth: 1600, deviceHeight: 1000 } },
  })
  await settle()
  assert.deepEqual({ ...scaled.view }, { width: 1600, height: 1000 }, 'no answer means the frame is all there is')
})

test('a frame that only repeats the cast cap does not shrink the page', async () => {
  /* A cast told to fit 2000x1200 scales a 3000x1800 device picture down and
     reports 2000x1200 as the frame's size. Riding on that number shrank the
     page to two thirds of itself and put every click beside the thing the hand
     was on; a frame that only says the cap is not news about the page. */
  const calls = []
  const page = new SidecarPage({
    on: (handler) => own.push(handler),
    send: async (method, params) => {
      calls.push({ method, params })
      return {}
    },
  }, 'unit-cap', 0, () => 0)
  const own = []
  await page.start()
  calls.length = 0
  page.view = { width: 2000, height: 1200 }
  page.dpr = 1.5
  const frames = []
  page.frames.add((message) => frames.push(message))
  page.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'cap-echo', sessionId: 61, metadata: { deviceWidth: 2000, deviceHeight: 1200 } },
  })
  await settle()
  assert.deepEqual({ ...page.view }, { width: 2000, height: 1200 }, 'the page keeps the size it is laid out at')
  assert.equal(calls.some((call) => call.method === 'Runtime.evaluate'), false, 'the echo is not worth asking the page')
  assert.equal(frames.at(-1).w, 2000, 'and the picture keeps its own size')
  /* The cast is capped in device pixels, or a scaled display gets a picture
     shrunk to fit a cap that was already measured in page pixels. */
  calls.length = 0
  await page.cast()
  const cap = calls.find((call) => call.method === 'Page.startScreencast')
  assert.equal(cap.params.maxWidth, 3000, 'the cap leaves room for the display scale')
  assert.equal(cap.params.maxHeight, 1800)
})

test('a frame that says the page changed shape waits for the measurement', async () => {
  /* A resize frame is drawn at the old shape while its header is about to be
     replaced. Shown at once, the picture and the hand disagree for exactly the
     moment the person is dragging the window; holding it back for one
     measurement costs a frame, not the pointer. */
  const own = []
  const sent = []
  const cdp = {
    on: (handler) => own.push(handler),
    send: async (method) => {
      sent.push(method)
      if (method === 'Runtime.evaluate') return { result: { value: [2400, 1400, 1] } }
      if (method === 'Page.captureScreenshot') return { data: 'after' }
      return {}
    },
  }
  const page = new SidecarPage(cdp, 'unit-resize', 0, () => 0)
  await page.start()
  page.view = { width: 2000, height: 1200 }
  page.dpr = 1
  const frames = []
  page.frames.add((message) => frames.push(message))
  page.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'old-shape', sessionId: 71, metadata: { deviceWidth: 3000, deviceHeight: 1800 } },
  })
  assert.equal(frames.length, 0, 'the frame drawn at the old shape is not shown')
  await settle()
  assert.deepEqual({ ...page.view }, { width: 2400, height: 1400 }, 'the page is measured before it is shown')
  assert.equal(frames.length, 1, 'one fresh picture goes out after the measurement')
  assert.equal(frames[0].w, 2400, 'and it carries the measured shape')
  assert.equal(frames[0].jpeg, 'after', 'taken after the page changed shape, not before')
})

test('the display scale is measured with the page, not guessed from a frame', async () => {
  /* Windows at 150%: a 3000x1800 frame is a page laid out at 2000x1200, so
     the scale has to come from the page along with its size. */
  const own = []
  const page = new SidecarPage({
    on: (handler) => own.push(handler),
    send: async (method) => (method === 'Runtime.evaluate' ? { result: { value: [2000, 1200, 1.5] } } : {}),
  }, 'unit-dpr', 0, () => 0)
  await page.start()
  page.sentAt = 0
  own[0]({
    method: 'Page.screencastFrame',
    params: { data: 'dpr-one', sessionId: 51, metadata: { deviceWidth: 3000, deviceHeight: 1800 } },
  })
  await settle()
  assert.deepEqual({ ...page.view }, { width: 2000, height: 1200 }, 'the page lays out at 2000x1200')
  assert.equal(page.dpr, 1.5, 'and the scale between the frame and the page is remembered')
})

test('a control from the last read is found without reading the page again', async () => {
  const looks = []
  const page = {
    cdp: {
      send: async (method, params) => {
        looks.push(method)
        return { result: { value: JSON.stringify({ x: 12, y: 34, name: 'Sign in', ref: 7 }) } }
      },
    },
  }
  const hit = await findWords(page, 'sign in', [{ ref: 7, name: 'Sign in', view: true, kind: 'button' }])
  assert.equal(hit.ref, 7)
  assert.equal(hit.x, 12)
  assert.deepEqual(looks, ['Runtime.evaluate'], 'one position check, no page read')
})

test('a dozen numbers left over from a read cost one page round trip', async () => {
  const looks = []
  const page = {
    cdp: {
      send: async (method, params) => {
        looks.push(params.expression ?? method)
        return { result: { value: JSON.stringify({ gone: false, ref: 12, x: 40, y: 50, name: 'Add to cart' }) } }
      },
    },
  }
  const known = Array.from({ length: 12 }, (_, i) => ({ ref: 10 + i, name: 'Add to cart', view: true, kind: 'button' }))
  const hit = await findWords(page, 'add to cart', known)
  assert.equal(hit.ref, 12)
  assert.equal(looks.length, 1, `the page was asked ${String(looks.length)} times`)
  assert.ok(looks[0].includes('10,11,12'), 'the one call carries every number worth trying')
})

test('a paraphrase on a redrawn button is accepted only when it stands alone', () => {
  const cart = [{ ref: 3, name: 'Place order' }, { ref: 4, name: 'Save for later' }]
  const near = nearestByWords(cart, 'submit order')
  assert.equal(near?.ref, 3, 'one shared significant word with nothing competing')
  assert.equal(nearestByWords(cart, 'delete account'), null, 'nothing in common is no answer')
  assert.equal(nearestByWords([{ ref: 1, name: 'Sign in' }, { ref: 2, name: 'Sign in with Google' }], 'sign in google')?.ref, 2, 'the label that covers more of the words wins')
  assert.equal(nearestByWords([{ ref: 1, name: 'Save draft' }, { ref: 2, name: 'Save draft now' }], 'save draft'), null, 'two answers is no answer')
  assert.equal(nearestByWords([{ ref: 1, name: 'Pay now' }], 'pay')?.ref, 1, 'a short label still matches')
  assert.equal(nearestByWords([], 'pay now'), null)
})

test('a moving Flash page is polled faster than a still one', async () => {
  const page = Object.create(SidecarPage.prototype)
  page.casting = true
  page.latest = null
  page.lastFrameAt = Date.now()
  let polls = 0
  page.picture = async () => {
    polls += 1
    return { jpeg: 'x' }
  }
  page.publish = () => {}
  const run = page.pollBridge()
  await new Promise((settle) => setTimeout(settle, 220))
  page.casting = false
  await run
  /* Idle beats are 66 ms: 220 ms of still page is three looks, never five. */
  assert.ok(polls >= 3 && polls <= 7, `polled ${polls} times, wanted the busy cadence`)
  const still = Object.create(SidecarPage.prototype)
  still.casting = true
  still.latest = { jpeg: 'x' }
  still.lastFrameAt = 0
  let idlePolls = 0
  still.picture = async () => {
    idlePolls += 1
    return { jpeg: 'x' }
  }
  still.publish = () => {}
  const slow = still.pollBridge()
  await new Promise((settle) => setTimeout(settle, 220))
  still.casting = false
  await slow
  assert.ok(idlePolls < polls, `still page polled ${idlePolls}, moving ${polls}`)
})

test('a key does not pay for a liveness ping on every press', async () => {
  const sidecar = new Sidecar({ profile: 'unit-ensure' })
  /* This test is about the answer, not about a browser: a real launch here
     would start Chrome and keep the file's process alive after the last test. */
  sidecar.cdp = { closed: false, send: async () => {}, close() {} }
  sidecar.launch = async () => {
    throw new Error('no browser in this test')
  }
  const page = new SidecarPage(sidecar.cdp, 'unit-ensure')
  let pings = 0
  page.ping = async () => {
    pings += 1
    return { ok: true, closed: false }
  }
  page.url = 'https://a.test/'
  sidecar.page = page
  sidecar.pages.set('chat-1', page)
  await sidecar.ensure({ session: 'chat-1' })
  await sidecar.ensure({ session: 'chat-1' })
  assert.equal(pings, 1, 'the second call trusts the answer it just got')
  page.answeredAt = 0
  await sidecar.ensure({ session: 'chat-1' })
  assert.equal(pings, 2, 'a stale answer is checked again')
})

test('a child that ignores SIGTERM is killed, so no stray app is left', async () => {
  const sidecar = new Sidecar({ profile: 'unit-kill' })
  const kills = []
  sidecar.child = {
    pid: 4242,
    kill: (signal) => { kills.push(signal) },
    once: () => {},
  }
  await sidecar.shutdown()
  /* Windows has no signals: the launcher's tree goes away through taskkill, so
     the child's own kill() never fires there. */
  assert.deepEqual(kills, process.platform === 'win32' ? [] : ['SIGTERM', 'SIGKILL'])
  assert.equal(sidecar.child, null)
  rmSync(join(homedir(), '.dsh', 'inner-browser-use', 'chrome', 'unit-kill'), { recursive: true, force: true })
})

test('the mirror draws one image pixel per CSS pixel whatever the pane scales at', async () => {
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      return {}
    },
  }, 'default')
  /* A scaled mirror is bought with a pointer that lands somewhere else: measured
     on this machine's Chrome with the pane at 1000x800, a page laid out at
     1000x800 with deviceScaleFactor 2 saw a point sent as CSS (400,320) arrive
     as (200,160) — divided by the scale — on six consecutive moves, and at 1.25x
     and 1.5x the same division happens to every point. The page is therefore
     laid out at the pane's CSS size and drawn at one device pixel per CSS pixel,
     which is the assumption every dispatched point already makes. */
  for (const scale of [2, 3, 1.5, 1.25, 0]) {
    const width = 880 + Math.round(scale * 10)
    sent.length = 0
    await page.setViewport(width, 700, scale)
    assert.equal(sent[0].params.deviceScaleFactor, 1)
    assert.equal(sent[0].params.width, width)
    assert.equal(page.dpr, 1)
  }
  sent.length = 0
  await page.setViewport(1000, 800)
  assert.equal(sent[0].params.deviceScaleFactor, 1)
  assert.equal(page.dpr, 1)
  /* A page left drawing at a scale by an older build is put back even when the
     column has not changed size: otherwise the mirror stays at a scale the
     pointer no longer matches. */
  page.appliedScale = 2
  sent.length = 0
  await page.setViewport(1000, 800)
  assert.deepEqual(sent[0].params, { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false })
})

test('a point the pane sends is the point this browser reads, whatever it scales at', async () => {
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      return {}
    },
  }, 'default')
  /* The pane sends CSS pixels and the page lays out in CSS pixels, so the point
     goes through unchanged: no platform multiplies it on the way in, because no
     device-metrics override makes a point mean device pixels. */
  await page.setViewport(900, 700, 2)
  assert.equal(page.handScale(), 1)
  sent.length = 0
  await page.mouse('mouseMoved', { x: 100, y: 200 })
  const moved = sent.find((one) => one.method === 'Input.dispatchMouseEvent')
  assert.deepEqual({ x: moved.params.x, y: moved.params.y }, { x: 100, y: 200 })
  sent.length = 0
  await page.wheel({ x: 100, y: 200, dy: 40 })
  const turned = sent.find((one) => one.method === 'Input.dispatchMouseEvent')
  assert.deepEqual({ x: turned.params.x, y: turned.params.y }, { x: 100, y: 200 })
})

test('the page lays out at the size of its column, so the mirror fills the frame', async () => {
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      return {}
    },
  }, 'default')
  assert.deepEqual(page.view, { width: VIEW.width, height: VIEW.height })
  /* A resize lands as one device-metrics change, and the pointer message that
     follows carries the new frame size. */
  const view = await page.setViewport(720, 880)
  assert.deepEqual(view, { width: 720, height: 880 })
  assert.equal(sent[0].method, 'Emulation.setDeviceMetricsOverride')
  assert.deepEqual(sent[0].params, { width: 720, height: 880, deviceScaleFactor: 1, mobile: false })
  /** @type {any[]} */
  const seen = []
  page.pointerSinks.add((message) => seen.push(message))
  page.movePointer({ x: 700, y: 860 })
  assert.deepEqual({ w: seen[0].w, h: seen[0].h }, { w: 720, h: 880 })
  /* Asking for what the page already has is not a round trip. */
  const before = sent.length
  await page.setViewport(720, 880)
  assert.equal(sent.length, before)
  /* A column too small to be a browser is ignored rather than applied as a
     sliver, and one wider than the widest page a browser lays out is clamped:
     dropping it would leave the pane showing the shape of the size before it,
     at the wrong ratio and with every click off by the difference. */
  await page.setViewport(100, 880)
  assert.deepEqual(page.view, { width: 720, height: 880 })
  assert.deepEqual(await page.setViewport(3000, 900), { width: 3000, height: 900 })
  assert.deepEqual(await page.setViewport(5000, 800), { width: 4096, height: 800 })
  /* A narrow, tall column is the shape a right-hand column has, and the page is
     laid out at it so the picture fills the pane instead of sitting in bars. */
  assert.deepEqual(await page.setViewport(260, 1900), { width: 260, height: 1900 })
  /* The picture is the game, not the window: the Flash runtime is asked to
     frame the box the game occupies and the answer is what the frame becomes,
     so a fixed-size game is not stretched into a column it does not fill. */
  page.flashBridge = 9211
  const resized = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    resized.push(String(url))
    return { ok: true, json: async () => ({ bounds: { x: -3000, y: -3000, width: 747, height: 436 }, content: { width: 747, height: 436 } }) }
  }
  const flashSent = sent.length
  await page.setViewport(747, 1196)
  assert.deepEqual(resized, ['http://127.0.0.1:9211/resize?w=747&h=1196'])
  assert.equal(sent.length, flashSent)
  assert.deepEqual(page.view, { width: 747, height: 436 })
  /* A runtime that cannot answer leaves the pane's own shape in place rather
     than shrinking the picture to nothing. */
  globalThis.fetch = async () => ({ ok: false })
  assert.deepEqual(await page.setViewport(760, 1200), { width: 760, height: 1200 })
  globalThis.fetch = realFetch
  page.flashBridge = null
  /* The window is the page: a click is already in page pixels. */
  const clicks = []
  page.cdp.send = async (method, params) => {
    sent.push({ method, params })
    clicks.push({ method, params })
    return {}
  }
  await page.mouse('mousePressed', { x: 747, y: 1196 })
  assert.deepEqual({ x: clicks[0].params.x, y: clicks[0].params.y }, { x: 747, y: 1196 })
  /* A live cast restarts at the new size instead of keeping the old one. */
  page.casting = true
  page.still = async () => {}
  sent.length = 0
  await page.setViewport(700, 860)
  assert.deepEqual(sent.map((call) => call.method).filter((method) => method !== 'Page.getLayoutMetrics' && method !== 'Runtime.evaluate').slice(0, 2), ['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast'])
  const started = sent.find((call) => call.method === 'Page.startScreencast')
  assert.deepEqual({ w: started.params.maxWidth, h: started.params.maxHeight }, { w: 700, h: 860 })
})

test('a size the browser did not take is replaced by the size it reports', async () => {
  /* The pane asks for the column's shape, and the browser answers with where
     the page really landed. A real window on a scaled display can keep its own
     size: believing the request then draws the mirror at one shape and sends
     the pointer at another, which is a click that misses its mark. */
  const asked = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method) => {
      asked.push(method)
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1250, clientHeight: 875 } }
      return {}
    },
  }, 'default')
  const view = await page.setViewport(1000, 700)
  assert.deepEqual(view, { width: 1250, height: 875 }, 'the report wins over the request')
  assert.ok(asked.includes('Page.getLayoutMetrics'), 'the page was asked, not assumed')

  /* A report that cannot be a browser, and a page that cannot answer at all,
     both leave the size in hand alone instead of throwing on a resize. */
  page.cdp = { send: async () => ({ cssLayoutViewport: { clientWidth: 12, clientHeight: 9 } }) }
  await page.laidOut()
  assert.deepEqual(page.view, { width: 1250, height: 875 })
  page.cdp = { send: async () => { throw new Error('the page is gone') } }
  await page.laidOut()
  assert.deepEqual(page.view, { width: 1250, height: 875 })
  page.cdp = null
  await page.laidOut()
  assert.deepEqual(page.view, { width: 1250, height: 875 })
})

test('a page with a scrollbar is measured with its scrollbar', async () => {
  /* The layout viewport leaves the scrollbar out, so a long page would be
     believed 15 CSS pixels narrower than the pane: every frame came back
     narrow, the pane letterboxed it, and the scrollbar itself never reached
     the mirror. The window's own width is the pane's width. */
  const page = new SidecarPage({
    on: () => {},
    send: async (method) => {
      if (method === 'Runtime.evaluate') return { result: { value: [885, 900] } }
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 870, clientHeight: 900 } }
      return {}
    },
  }, 'default')
  const view = await page.setViewport(885, 900)
  assert.deepEqual(view, { width: 885, height: 900 }, 'the scrollbar is part of the pane')

  /* A page that cannot answer still falls back to the layout viewport rather
     than refusing to place the pointer. */
  page.cdp = { send: async (method) => (method === 'Runtime.evaluate' ? Promise.reject(new Error('gone')) : { cssLayoutViewport: { clientWidth: 870, clientHeight: 900 } }) }
  await page.laidOut()
  assert.deepEqual(page.view, { width: 870, height: 900 })
})

test('a polled mirror sends a still picture once, not once per poll', async () => {
  /* Chrome's screencast already skips unchanged compositor frames; the Flash
     branch polls instead, so it published the same JPEG 15 times a second. */
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  /** @type {string[]} */
  const seen = []
  page.frames.add((frame) => seen.push(frame.jpeg))
  page.publish('picture-a')
  page.publish('picture-a')
  page.publish('picture-a')
  assert.deepEqual(seen, ['picture-a'], 'the pane already shows it')
  assert.equal(page.quiet, 2)
  page.sentAt = Date.now() - 100
  page.publish('picture-b')
  assert.deepEqual(seen, ['picture-a', 'picture-b'], 'a real change still goes out')
  /* One heartbeat a second keeps a quiet page from looking like a dead stream. */
  page.lastShotAt = Date.now() - 1500
  page.sentAt = Date.now() - 100
  page.publish('picture-b')
  assert.equal(seen.length, 3)
})


test('a page at 60 fps costs the pane about 30 frames a second', () => {
  /* A person watches the pane at screen refresh: forwarding every compositor
     frame doubles the downlink for a difference no eye can see. */
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  /** @type {any[]} */
  const seen = []
  page.frames.add((frame) => seen.push(frame))
  const send = (data) => page.cdp.on
  page.publish('frame-1')
  page.publish('frame-2')
  page.publish('frame-3')
  assert.equal(seen.length, 1, 'the next frame inside the gap waits')
  page.sentAt = Date.now() - 30
  page.publish('frame-4')
  assert.equal(seen.length, 2, 'past the gap the pane gets the new picture')
  assert.equal(page.latest, 'frame-4', 'the browser still keeps the newest picture for a still')
  void send
})

test('moving the mouse keeps the pane at full frame rate', () => {
  /* Pacing exists to spare an idle pane; a person dragging or aiming gets every
     frame, because that is when 30 fps reads as lag. */
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  const seen = []
  page.frames.add((frame) => seen.push(frame))
  page.lastPointerAt = Date.now()
  page.publish('aim-1')
  page.publish('aim-2')
  page.publish('aim-3')
  assert.equal(seen.length, 3)
})

test('a long message arrives in one event, and a box that refuses it falls back', async () => {
  /** @param {boolean} takes - whether the box keeps what insertText put there. */
  const boxed = (takes) => {
    let text = ''
    const typed = []
    return {
      typed,
      cdp: {
        on: () => {},
        send: async (method, params) => {
          if (method === 'Runtime.evaluate') return { result: { value: text } }
          return {}
        },
      },
      input: async (method, params) => {
        typed.push({ method, params })
        if (takes === true) text = String(params?.text ?? '')
      },
    }
  }
  const takes = boxed(true)
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  page.cdp = takes.cdp
  page.input = takes.input
  assert.equal(await page.quickType('a long paragraph'), true, 'a plain box keeps it')
  assert.equal(takes.typed.length, 1, 'one event, not one per character')

  const refuses = boxed(false)
  const stubborn = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  stubborn.cdp = refuses.cdp
  stubborn.input = refuses.input
  assert.equal(await stubborn.quickType('a long paragraph'), false, 'the caller types the slow way instead')
})

test('a browser is only closed by the process that started it', () => {
  /* A script that connects to a browser somebody else started — a second app on
     the same profile, a probe that forgot to quit — must not take the window
     with it when it lets go. */
  assert.equal(ownsBrowser({ pid: 4242, owner: 4242 }), true, 'the process that started it may close it')
  assert.equal(ownsBrowser({ pid: 9001, owner: 4242 }), false, 'another process may not')
  assert.equal(ownsBrowser({ pid: 4242, owner: 0 }), false, 'a profile with no marker belongs to nobody')
  assert.equal(ownsBrowser({ pid: 0, owner: 0 }), false, 'a missing pid is not an owner')
  assert.equal(ownsBrowser({}), false, 'nothing said, nothing owned')
  assert.equal(ownsBrowser(null), false, 'no record, not owned')

  /* A browser whose starter died is nobody's: it must be closed by the next
     run, or the mirror that comes after it drives a page from a past session. */
  assert.equal(mayClaim({ pid: 4242, owner: 4242 }, true), true, 'the starter may close its own browser')
  assert.equal(mayClaim({ pid: 9001, owner: 4242 }, false), true, 'a starter that has gone leaves the browser free to take')
  assert.equal(mayClaim({ pid: 9001, owner: 4242 }, true), false, 'a browser a live process started is not ours to close')
  assert.equal(mayClaim({ pid: 9001, owner: 0 }, false), true, 'a profile with no marker has nobody to protect it')
  assert.equal(mayClaim({ pid: 0, owner: 4242 }, false), false, 'a missing pid cannot claim anything')
  assert.equal(mayClaim(null, false), false, 'nothing said, nothing claimed')

  /* Windows has no `ps`, so the ancestry is walked over a table read in one
     call. A node instance is what a reload replaces and a shell is what
     launched one: the watcher may only key on the application above both. */
  const table = new Map([
    [500, { parent: 400, command: 'node.exe plugin.js' }],
    [400, { parent: 0, command: 'C:\\Program Files\\DSH\\DSH.exe' }],
  ])
  assert.equal(appFromTable(500, table), 400, 'the walk names the application above the node instance')
  table.set(400, { parent: 300, command: 'C:\\Windows\\System32\\cmd.exe /c start' })
  table.set(300, { parent: 200, command: 'C:\\Program Files\\DSH\\DSH.exe' })
  assert.equal(appFromTable(500, table), 300, 'the highest application in the chain is the one watched')
  table.set(300, { parent: 200, command: 'node.exe --expose-internals reentry.js' })
  assert.equal(appFromTable(500, table), 0, 'a chain with no application arms nothing')
  table.set(300, { parent: 200, command: 'powershell.exe -NoProfile' })
  assert.equal(appFromTable(500, table), 0, 'a shell is not an application either')
  assert.equal(appFromTable(0, table), 0, 'no pid, no walk')
  assert.equal(appFromTable(500, null), 0, 'no table, no walk')

  /* The Windows rule is exercised here on a mac, so it has to be spelled out:
     a node the harness spawns is not the application, an exe above it is. */
  assert.equal(looksLikeApp('C:\\Program Files\\DSH\\DSH.exe', 'win32'), true, 'an app exe is the app')
  assert.equal(looksLikeApp('\"C:\\Program Files\\DSH\\DSH.exe\" --type=renderer', 'win32'), true, 'a quoted app exe is the app')
  assert.equal(looksLikeApp('C:\\Program Files\\nodejs\\node.exe plugin.js', 'win32'), false, 'a node instance is not the app')
  assert.equal(looksLikeApp('C:\\Windows\\System32\\cmd.exe', 'win32'), false, 'a shell is not the app')
  assert.equal(looksLikeApp('node.exe --expose-internals x.js', 'win32'), false, 'a reload instance is never the app')
  assert.equal(looksLikeApp('', 'win32'), false, 'nothing named, nothing watched')
  assert.equal(looksLikeApp('C:\\Program Files\\DSH\\DSH.exe', 'darwin'), false, 'a Windows path is not a mac app')
})

test('a probe told to keep its files elsewhere does not find the person\'s browser', () => {
  /* The profile directories follow the state directory. Pointing them at the
     person's own would let a script connect to the browser they are using. */
  const mine = mkdtempSync(join(tmpdir(), 'rootdir-'))
  const before = process.env.DSH_INNER_BROWSER_STATE_DIR
  process.env.DSH_INNER_BROWSER_STATE_DIR = mine
  try {
    assert.equal(rootDir(), join(mine, 'chrome'), 'its own profiles, next to its own files')
  } finally {
    if (before === undefined) delete process.env.DSH_INNER_BROWSER_STATE_DIR
    else process.env.DSH_INNER_BROWSER_STATE_DIR = before
    rmSync(mine, { recursive: true, force: true })
  }
})

test('the Flash window is rendered offscreen, so a game never appears on the desktop', () => {
  const source = readFileSync(new URL('../runtime/flash-app/main.js', import.meta.url), 'utf8')
  assert.match(source, /offscreen:\s*true/)
  assert.match(source, /useSharedTexture:\s*false/)
  assert.ok(!source.includes('showInactive()'), 'the window must never be shown')
  assert.match(source, /webContents\.on\('paint'/)
  assert.match(source, /if \(painted > 0\)/, 'the screenshot pump must stand down once paint runs')
})

test('the Flash app cannot put its own menu in the menu bar either', () => {
  const source = readFileSync(new URL('../runtime/flash-app/main.js', import.meta.url), 'utf8')
  assert.match(source, /Menu\.setApplicationMenu\(null\)/)
  assert.match(source, /setActivationPolicy\('accessory'\)/)
})

test('Flash input goes into the window directly, not through the debugging protocol', () => {
  const source = readFileSync(new URL('../runtime/flash-app/main.js', import.meta.url), 'utf8')
  const side = readFileSync(new URL('../sidecar.js', import.meta.url), 'utf8')
  assert.match(source, /request\.url\.startsWith\('\/input'\)/)
  assert.match(source, /webContents\.sendInputEvent\(plan\.event\)/)
  assert.match(side, /async flashInput/)
  assert.match(side, /sendInputEvent|\/input`/)
  for (const path of ['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel']) {
    assert.ok(side.includes(path) || path === 'mouseDown' || path === 'mouseUp' || path === 'mouseMove', path)
  }
})

test('A Flash page settles at the next picture and answers from the bridge', () => {
  const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  const settleAt = source.indexOf('export async function settle')
  assert.ok(settleAt > 0)
  const settleBody = source.slice(settleAt, settleAt + 3000)
  assert.match(settleBody, /flashBridge !== null/)
  /* The flash branch has to run before the popup lookup: a plugin page has no
     tabs to adopt and the lookup costs a round trip per call. */
  assert.ok(settleBody.indexOf('flashBridge !== null') < settleBody.indexOf('adoptOpened'))
  assert.match(source, /flashBridge\}\/info/)
  assert.match(source, /\/info`, \{ signal: AbortSignal\.timeout\(600\) \}/)
})

test('one browser does not keep a renderer per chat', async () => {
  const sidecar = new Sidecar({ logger: null })
  const made = (at, watched) => ({
    targetId: `t${String(at)}`,
    port: 1,
    touched: at,
    frames: new Set(watched ? [() => {}] : []),
    stopCast: async () => {},
  })
  /* A watched tab is the person's page: never reaped. */
  sidecar.pages.set('watching', made(1, true))
  for (let at = 2; at < 9; at += 1) sidecar.pages.set(`chat-${String(at)}`, made(at, false))
  const close = fetch
  let closed = 0
  globalThis.fetch = async (url) => {
    if (String(url).includes('/json/close/')) closed += 1
    return { ok: true, json: async () => ({}) }
  }
  try {
    await sidecar.trimTabs()
  } finally {
    globalThis.fetch = close
  }
  assert.equal(sidecar.pages.size, 5)
  /* A tab closed for the cap is as gone as one closed for idleness: the chat's
     column is told, so it offers the address back instead of a dead picture. */
  assert.equal(sidecar.expired.has('chat-2'), true, 'the trimmed chat is told its tab went away')
  assert.equal(sidecar.expired.has('chat-8'), false)
  assert.ok(sidecar.pages.has('watching'), 'the page on screen stays')
  assert.ok(sidecar.pages.has('chat-8'), 'the newest chat stays')
  assert.ok(!sidecar.pages.has('chat-2'), 'the oldest unwatched tab goes')
  assert.ok(closed >= 1)
})

test('tabs an earlier load left behind are closed, aimed pages stay', async () => {
  const sidecar = new Sidecar({ logger: null })
  sidecar.page = { targetId: 'own', port: 1 }
  const close = globalThis.fetch
  const shut = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/json/list')) {
      return {
        ok: true,
        json: async () => [
          { type: 'page', id: 'own', url: 'https://keep.example/' },
          { type: 'page', id: 'old-1', url: 'about:blank' },
          { type: 'page', id: 'old-2', url: 'http://127.0.0.1:9/x' },
          { type: 'page', id: 'old-3', url: 'https://keep.example/' },
        ],
      }
    }
    shut.push(String(url))
    return { ok: true, json: async () => ({}) }
  }
  try {
    await sidecar.pruneStrays()
  } finally {
    globalThis.fetch = close
  }
  assert.equal(sidecar.pruned, true)
  /* Nothing is remembered in this test, so every tab but the live page goes:
     an address on disk is what makes a reaped tab cheap to bring back. */
  assert.deepEqual(shut.map((one) => one.split('/json/close/')[1]).sort(), ['old-1', 'old-2', 'old-3'])
})


test('a tab nobody has watched for ten minutes is closed, the live page is not', async () => {
  const sidecar = new Sidecar({ logger: null })
  sidecar.reapedAt = 0
  const long = 11 * 60_000
  const mk = (target, at, frames) => ({ targetId: target, port: 1, touched: Date.now() - at, frames, stopCast: async () => {} })
  const live = mk('live', long, new Set())
  sidecar.page = live
  sidecar.pages.set('chat-live', live)
  sidecar.pages.set('chat-old', mk('old-1', long, new Set()))
  sidecar.pages.set('chat-new', mk('new-1', 5_000, new Set()))
  sidecar.pages.set('chat-watched', mk('watched-1', long, new Set(['sink'])))
  const close = globalThis.fetch
  const shut = []
  globalThis.fetch = async (url) => { shut.push(String(url)); return { ok: true, json: async () => ({}) } }
  try {
    await sidecar.reapIdleTabs()
  } finally {
    globalThis.fetch = close
  }
  assert.equal(sidecar.pages.has('chat-old'), false)
  assert.equal(sidecar.pages.has('chat-live'), true)
  assert.equal(sidecar.pages.has('chat-new'), true)
  assert.equal(sidecar.pages.has('chat-watched'), true)
  assert.deepEqual(shut.map((one) => one.split('/json/close/')[1]).sort(), ['old-1'])
  /* The chat's column learns the tab is gone, so coming back to the front does
     not re-expand a pane for the page that was just reclaimed. */
  assert.equal(sidecar.expired.has('chat-old'), true)
  const said = await sidecar.chatState('chat-old')
  assert.deepEqual([said.alive, said.expired], [false, true])
})

test('one address is one line in the tab list, and the chat\'s page represents it', async () => {
  const sidecar = new Sidecar({ logger: null })
  sidecar.claims.set('chat-a', new Set(['chat-a']))
  sidecar.page = {
    tabs: async () => [
      { targetId: 'base', title: 'one', url: 'https://one.example/x', current: true },
      { targetId: 'chat-a', title: 'one', url: 'https://one.example/x#frag', current: false },
      { targetId: 'chat-b', title: 'two', url: 'https://two.example/', current: false },
    ],
  }
  const rows = await sidecar.tabs()
  /* Two identical lines are the same page twice: the page a chat holds is the
     one that represents that address, and the bare twin is not listed. The
     rows keep browser order, so a row index still means the same row. */
  assert.deepEqual(rows.map((row) => row.targetId), ['chat-a', 'chat-b'])
})

test('two addresses stay two lines', async () => {
  const sidecar = new Sidecar({ logger: null })
  sidecar.page = {
    tabs: async () => [
      { targetId: 'one', title: 'one', url: 'https://one.example/x', current: true },
      { targetId: 'two', title: 'two', url: 'https://two.example/', current: false },
    ],
  }
  assert.deepEqual((await sidecar.tabs()).map((row) => row.targetId), ['one', 'two'])
})

test('a page already at the address is reused instead of opened twice', () => {
  const held = { targetId: 'other', url: 'https://one.example/x#top', cdp: { closed: false } }
  const sidecar = new Sidecar({ logger: null })
  sidecar.page = { targetId: 'base', url: 'https://one.example/x/', cdp: { closed: false } }
  assert.equal(sidecar.tabShowing('https://one.example/x', 'mine').targetId, 'base', 'the same place in another spelling is the same page')
  sidecar.page = null
  sidecar.pages.set('other', held)
  sidecar.claims.set('other', new Set(['other']))
  assert.equal(sidecar.tabShowing('https://one.example/x', 'mine'), null, 'a page another chat drives is not offered')
  assert.equal(sidecar.tabShowing('https://one.example/x', 'other').targetId, 'other', 'its own chat reuses it')
  assert.equal(sidecar.tabShowing('about:blank', 'mine'), null)
})

test('a chat that opens a page again clears the reclaim marker', async () => {
  const sidecar = new Sidecar({ logger: null })
  sidecar.pages.set('chat-a', { targetId: 'chat-a', port: 1, url: 'https://one.example/', cdp: { closed: false }, frames: new Set(), navigate: async () => {}, stopCast: async () => {} })
  sidecar.expired.set('chat-a', Date.now())
  assert.equal((await sidecar.chatState('chat-a')).expired, true)
  await sidecar.tabFor('chat-a', 'https://one.example/')
  assert.equal(sidecar.expired.has('chat-a'), false)
})


test('a heavy frame lowers the cast quality, a light one raises it, a normal one changes nothing', () => {
  assert.equal(nextQuality(72, 200_000), 64)
  assert.equal(nextQuality(72, 40_000), 76)
  assert.equal(nextQuality(72, 80_000), 72)
  assert.equal(nextQuality(48, 200_000), 44)
  assert.equal(nextQuality(74, 30_000), 76)
  assert.equal(nextQuality(72, 0), 72)
  assert.equal(nextQuality(72, Number.NaN), 72)
})

test('two shutdowns at once put the browser away once', async () => {
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-put-away-${process.pid}`) })
  let puts = 0
  sidecar.putAway = async () => {
    puts += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const first = sidecar.shutdown()
  const second = sidecar.shutdown()
  await Promise.all([first, second])
  assert.equal(puts, 1, 'the browser is closed once, not twice')
  assert.equal(sidecar.closing, null, 'and the door is open again for the next rest')
})

test('a launch waits for the browser that is still going out', async () => {
  const sidecar = new Sidecar({ dir: join(tmpdir(), `dshib-launch-wait-${process.pid}`) })
  let gone = false
  sidecar.closing = new Promise((resolve) => setTimeout(() => { gone = true; resolve() }, 40))
  /* No Chrome is started here: a port is pretended so the browser is never
     spawned, and the socket asks whether the old one was already gone. */
  sidecar.runningPort = async () => 1
  sidecar.pageSocket = async () => { throw new Error(`socket asked for after the old browser was gone: ${String(gone)}`) }
  await assert.rejects(() => sidecar.launch('about:blank'), /socket asked for after the old browser was gone: true/)
})

test('an input the page never took says so instead of looking delivered', async () => {
  /* The socket can die while the pane still shows a picture. Swallowing that
     made a click vanish with a 200 behind it, which reads as a mirror that
     stopped answering. */
  const refusing = {
    sent: [],
    send: async () => {
      throw new Error('socket closed')
    },
    on: () => {},
    close: () => {},
  }
  const page = new SidecarPage(refusing, 'default')
  const took = await page.input('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2 })
  assert.equal(took, false, 'a refused event is reported as not taken')
  assert.equal(page.inputFails, 1, 'and counted, so the next action knows to look again')
  assert.equal(page.inputFault, 'Input.dispatchMouseEvent')

  const cdp = fakeCdp()
  page.cdp = cdp
  const again = await page.input('Input.insertText', { text: 'x' })
  assert.equal(again, true, 'a page that answers is a page that took it')
  assert.equal(page.inputFails, 0, 'health is cleared by the next good event')
  assert.equal(page.inputFault, '')
})

test('a page the browser took away tells every viewer, and a closed pane costs nothing', () => {
  const page = new SidecarPage(fakeCdp(), 'default')
  const seen = []
  page.frames.add((/** @type {any} */ message) => seen.push(message))
  page.frames.add(() => {
    throw new Error('this pane is already gone')
  })
  const after = []
  page.frames.add((/** @type {any} */ message) => after.push(message))

  page.markGone()

  assert.deepEqual(seen, [{ type: 'gone' }], 'the pane hears it at once, not on the next frame')
  assert.deepEqual(after, [{ type: 'gone' }], 'a closed pane does not stop the others')
})

test('every picture names its tab and every reclaim names the viewer', () => {
  const source = readFileSync(new URL('../sidecar.js', import.meta.url), 'utf8')
  assert.equal(
    source.split('target: this.targetId').length - 1,
    2,
    'both places that build a frame carry the tab it came from',
  )
  assert.equal(source.split('row.page.markGone()').length - 1, 1, 'trimming a tab tells its pane')
  assert.equal(source.split('page.markGone()').length - 1, 2, 'reaping an idle tab tells its pane too')
})

test('a right or middle drag names its own button on every move', async () => {
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      return {}
    },
  }, 'drag-button')
  const last = () => sent.filter((one) => one.method === 'Input.dispatchMouseEvent').at(-1)
  /* A right press that the moves call left would drag a text selection across
     the page instead of the thing under the hand. */
  await page.mouse('mousePressed', { x: 100, y: 100, button: 'right', clickCount: 1 })
  assert.equal(last().params.button, 'right', 'the press names the right button')
  assert.equal(last().params.buttons, 2, 'and holds it')
  await page.hover({ x: 140, y: 160, pressed: true, button: 'right' })
  assert.equal(last().params.buttons, 2, 'a move in the drag holds the right button')
  assert.equal(last().params.button, 'right', 'and names it')
  await page.hover({ x: 150, y: 170 })
  assert.equal(last().params.buttons, 2, 'a move that forgets the flag still carries the held button')
  await page.mouse('mouseReleased', { x: 150, y: 170, button: 'right', clickCount: 1 })
  assert.equal(last().params.buttons, 0, 'letting go drops it')
  /* The middle button autoscrolls: the page only starts it while the button is down. */
  await page.mouse('mousePressed', { x: 100, y: 100, button: 'middle', clickCount: 1 })
  assert.equal(last().params.buttons, 4, 'the middle press holds its own bit')
  await page.hover({ x: 100, y: 140 })
  assert.equal(last().params.buttons, 4, 'the drag keeps the middle button down')
  assert.equal(last().params.button, 'middle', 'and names it')
  await page.mouse('mouseReleased', { x: 100, y: 140, button: 'middle', clickCount: 1 })
  assert.equal(last().params.buttons, 0, 'the middle button is let go')
})

test('the keys the hand holds ride with the click, the wheel and the hover', async () => {
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      return {}
    },
  }, 'default')
  const last = () => sent.filter((one) => one.method === 'Input.dispatchMouseEvent').at(-1)
  /* Shift is the range, ctrl a second pick, cmd a new tab: the page reads them
     off the mouse event, so the bits have to reach the protocol. */
  await page.mouse('mousePressed', { x: 100, y: 120, modifiers: 8, clickCount: 1 })
  assert.equal(last().params.modifiers, 8, 'shift reaches the press')
  await page.mouse('mouseReleased', { x: 100, y: 120, modifiers: 8, clickCount: 1 })
  assert.equal(last().params.modifiers, 8, 'and the release')
  await page.hover({ x: 100, y: 120, modifiers: 2, pressed: true })
  assert.equal(last().params.modifiers, 2, 'a drag with ctrl held says so on every move')
  await page.wheel({ x: 100, y: 120, dy: 40, modifiers: 8 })
  assert.equal(last().params.modifiers, 8, 'shift turns a vertical wheel sideways')
  /* A plain click carries no keys, and the field is always there: a page that
     reads modifiers off the event never gets undefined. */
  await page.mouse('mousePressed', { x: 100, y: 120, clickCount: 1 })
  assert.equal(last().params.modifiers, 0, 'no key held is zero, not missing')
})

test('a column drawn at two device pixels per CSS pixel gets a captured picture', async () => {
  /* A scaled display once had the page itself drawn at its scale, which moved
     every click: a point the pane sent came back in device pixels. The detail
     is wanted, the moved layout is not, so the picture is captured at the
     column's size through a clip and the page is never told. */
  const own = []
  const calls = []
  const cdp = {
    on: (handler) => own.push(handler),
    send: async (method, params) => {
      calls.push({ method, params })
      return method === 'Page.captureScreenshot' ? { data: 'crisp-frame' } : {}
    },
  }
  const page = new SidecarPage(cdp, 'unit-crisp', 0, () => 0)
  await page.start()
  calls.length = 0
  page.view = { width: 1100, height: 800 }
  page.castScale = 2
  const frames = []
  page.frames.add((message) => frames.push(message))
  page.sentAt = 0
  page.lastFrameAt = 0
  await page.cast()
  await new Promise((resolve) => setTimeout(resolve, 90))
  await page.stopCast()
  const captures = calls.filter((call) => call.method === 'Page.captureScreenshot')
  assert.ok(captures.length >= 1, 'the picture is captured, not cast')
  assert.deepEqual(captures[0].params.clip, { x: 0, y: 0, width: 1100, height: 800, scale: 2 }, 'the clip is the viewport at the column scale')
  assert.equal(calls.some((call) => call.method === 'Page.startScreencast'), false, 'no cast is started for a scaled column')
  assert.equal(page.handScale(), 1, 'a click still counts in CSS pixels')
  assert.ok(frames.length >= 1, 'the pane is sent the picture')
  assert.equal(frames.at(-1).w, 1100, 'the header stays in CSS pixels')
  assert.equal(frames.at(-1).h, 800)
  /* A stopped picture stops being captured, not just being sent. */
  const settled = calls.length
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(calls.filter((call) => call.method === 'Page.captureScreenshot').length, captures.length, 'the loop ends with the cast')
  assert.equal(calls.length, settled, 'nothing keeps asking after the cast stopped')
})

test('a scrolled page is captured where the window is looking', async () => {
  /* A capture clip is measured from the top of the document, not from the
     window: a page that has been scrolled still answers with the top of
     itself, so a wheel turn used to fill the mirror with the page above the
     one the person is reading. The picture is the visible viewport, and the
     header names the same box so a click lands where it was pointed. */
  const calls = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      calls.push({ method, params })
      if (method === 'Page.captureScreenshot') return { data: 'scrolled-frame' }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { offsetX: 0, offsetY: 0, pageX: 60, pageY: 1240, clientWidth: 1000, clientHeight: 700, scale: 1, zoom: 1 } }
      }
      return {}
    },
  }, 'unit-scrolled', 0, () => 0)
  await page.start()
  calls.length = 0
  page.view = { width: 1015, height: 715 }
  page.castScale = 2
  page.sentAt = 0
  page.lastFrameAt = 0
  const frames = []
  page.frames.add((message) => frames.push(message))
  await page.cast()
  await new Promise((resolve) => setTimeout(resolve, 90))
  await page.stopCast()
  const capture = calls.find((call) => call.method === 'Page.captureScreenshot')
  assert.ok(capture !== undefined, 'the picture is captured')
  assert.deepEqual(capture.params.clip, { x: 60, y: 1240, width: 1000, height: 700, scale: 2 }, 'the clip is the visible page, in document pixels')
  assert.equal(frames.at(-1).w, 1000, 'the header is the visible width, not the window width')
  assert.equal(frames.at(-1).h, 700, 'and the visible height')
  assert.equal(page.handScale(), 1, 'a click is still a CSS pixel')
})

test('a capture that cannot measure the page falls back to the window', async () => {
  /* The metrics call is not a reason to stop drawing: without it the picture
     is the window, which is what it was before, and the pane still gets one. */
  const calls = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method, params) => {
      calls.push({ method, params })
      if (method === 'Page.captureScreenshot') return { data: 'blind-frame' }
      if (method === 'Page.getLayoutMetrics') throw new Error('no metrics')
      return {}
    },
  }, 'unit-blind', 0, () => 0)
  await page.start()
  calls.length = 0
  page.view = { width: 820, height: 620 }
  page.castScale = 2
  page.sentAt = 0
  page.lastFrameAt = 0
  const frames = []
  page.frames.add((message) => frames.push(message))
  await page.cast()
  await new Promise((resolve) => setTimeout(resolve, 90))
  await page.stopCast()
  const capture = calls.find((call) => call.method === 'Page.captureScreenshot')
  assert.ok(capture !== undefined, 'the picture is still captured')
  assert.deepEqual(capture.params.clip, { x: 0, y: 0, width: 820, height: 620, scale: 2 }, 'the clip falls back to the window')
  assert.equal(frames.at(-1).w, 820, 'and the header to the window size')
  assert.equal(frames.at(-1).h, 620)
})

test('an unscaled column still uses the display cast', async () => {
  const own = []
  const calls = []
  const page = new SidecarPage({
    on: (handler) => own.push(handler),
    send: async (method, params) => {
      calls.push({ method, params })
      return {}
    },
  }, 'unit-plain', 0, () => 0)
  await page.start()
  calls.length = 0
  page.view = { width: 900, height: 700 }
  page.castScale = 1
  page.sentAt = 0
  page.lastFrameAt = 0
  await page.cast()
  assert.equal(calls.filter((call) => call.method === 'Page.startScreencast').length, 1, 'one cast is what a plain column needs')
  assert.equal(calls.some((call) => call.method === 'Page.captureScreenshot' && call.params?.clip !== undefined), false, 'a capture per frame is not worth it at one pixel')
  await page.stopCast()
})

test('a tall scaled column captures within a pixel budget', async () => {
  const own = []
  const calls = []
  const page = new SidecarPage({
    on: (handler) => own.push(handler),
    send: async (method, params) => {
      calls.push({ method, params })
      return method === 'Page.captureScreenshot' ? { data: 'tall-frame' } : {}
    },
  }, 'unit-tall', 0, () => 0)
  await page.start()
  calls.length = 0
  /* A column taller than any screen: two device pixels per CSS pixel would be
     a 4800-pixel-high picture, so the scale gives way, not the column. */
  page.view = { width: 800, height: 2400 }
  page.castScale = 2
  page.sentAt = 0
  page.lastFrameAt = 0
  const frames = []
  page.frames.add((message) => frames.push(message))
  await page.cast()
  await new Promise((resolve) => setTimeout(resolve, 90))
  await page.stopCast()
  const capture = calls.find((call) => call.method === 'Page.captureScreenshot' && call.params?.clip !== undefined)
  assert.ok(capture !== undefined, 'the picture is captured')
  const { width, height, scale } = capture.params.clip
  assert.ok(scale > 1 && scale < 2, `the scale is lowered for a tall column, got ${scale}`)
  assert.ok(width * height * scale * scale <= 4_200_000 + 1, 'the picture stays inside the pixel budget')
  assert.equal(page.handScale(), 1, 'a click is still a CSS pixel')
  assert.equal(frames.at(-1).w, 800, 'the header stays the column size')
  assert.equal(frames.at(-1).h, 2400)
})


/** A JPEG header of a known size: enough of a picture for the size to be read. */
function fakeJpeg(width, height, tail = '') {
  const head = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    3, 1, 0x22, 0x00, 2, 0x11, 0x01, 3, 0x11, 0x01,
  ])
  return Buffer.concat([head, Buffer.from(tail)]).toString('base64')
}

test('a picture of the size before a resize is read from its own header', () => {
  const size = jpegSize(fakeJpeg(785, 883))
  assert.deepEqual(size, { width: 785, height: 883 })
  assert.equal(jpegSize('picture-a'), null, 'a still that is not a JPEG has no size to trust')
})

test('the frame a restarted cast owes from before the resize is not shown', () => {
  /* A cast restarted right after the column changes size hands over one frame
     of the old size. Drawn against the new size it sits letterboxed and every
     click in it lands off by the difference, so the pane keeps the picture it
     has and shows the next frame - always the page's own size. */
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  page.view = { width: 800, height: 900 }
  page.castScale = 1
  page.dpr = 1
  /** @type {string[]} */
  const seen = []
  page.frames.add((frame) => seen.push(frame.jpeg))
  page.publish(fakeJpeg(785, 883, 'before'))
  assert.deepEqual(seen, [], 'the size before the resize is dropped')
  page.publish(fakeJpeg(800, 900, 'after'))
  assert.equal(seen.length, 1, "the page's own size goes out")
  assert.deepEqual(page.view, { width: 800, height: 900 })
})

test('a scaled capture is measured against its own scale, not the column', () => {
  const page = new SidecarPage({ on: () => {}, send: async () => ({}) }, 'default')
  page.view = { width: 800, height: 900 }
  page.castScale = 2
  page.dpr = 1
  /** @type {string[]} */
  const seen = []
  page.frames.add((frame) => seen.push(frame.jpeg))
  page.publish(fakeJpeg(1600, 1800, 'crisp'))
  assert.equal(seen.length, 1, 'a sharp capture at twice the column is the right shape')
})

test('a cast refused as already active stops the leftover and starts again', async () => {
  /* A stop that failed leaves Chrome's own cast running while the bookkeeping
     here says it stopped. The next start is then refused, and believing that
     refusal leaves the pane quiet with a cast still encoding frames. */
  /** @type {{method: string, params: any}[]} */
  const sent = []
  let starts = 0
  const cdp = {
    on: () => {},
    send: async (method, params) => {
      sent.push({ method, params })
      if (method === 'Page.startScreencast') {
        starts += 1
        if (starts === 1) throw new Error('Page.startScreencast: Screencast is already active')
      }
      return {}
    },
  }
  const page = new SidecarPage(cdp, 'unit-cast-refused')
  page.view = { width: 800, height: 900 }
  page.dpr = 1
  let stills = 0
  page.still = async () => { stills += 1 }
  await page.cast()
  assert.equal(page.casting, true, 'the mirror is casting after the retry')
  assert.deepEqual(
    sent.map((one) => one.method).filter((one) => one !== 'Page.screencastFrameAck'),
    ['Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast'],
    'the leftover cast is stopped before the start is asked for again',
  )
  assert.equal(stills, 1, 'a live pane still gets its first picture')
  page.casting = false
})

test('a stop given no casting flag still stops the cast Chrome is running', async () => {
  /** @type {string[]} */
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method) => { sent.push(method); return {} },
  }, 'unit-stop-leak')
  page.casting = false
  await page.stopCast()
  assert.deepEqual(sent, ['Page.stopScreencast'], 'the stop goes out even when the flag says idle')
})

test('a cast that accepted the start and sent nothing gives way to the capture path', async () => {
  /** @type {string[]} */
  const sent = []
  const page = new SidecarPage({
    on: () => {},
    send: async (method) => { sent.push(method); return {} },
  }, 'unit-live-dead')
  page.view = { width: 800, height: 900 }
  page.castScale = 1
  page.dpr = 1
  let loops = 0
  page.castCrisp = async () => { loops += 1 }
  /* The start was accepted a while ago and no frame ever arrived: the same
     silence an idle page shows, which is why only a frame after the start
     counts as proof the screencast is alive. */
  page.casting = true
  page.lastFrameAt = Date.now() - 5000
  page.frames.add(() => {})
  assert.equal(await page.liveDead(), true, 'silence after a start is a dead cast')
  assert.equal(page.casting, false)
  assert.equal(page.castLive, false, 'this page keeps using the capture path')
  assert.equal(loops, 1, 'the capture path takes over')
  assert.ok(sent.includes('Page.stopScreencast'), 'the dead cast is stopped')
  assert.equal(page.castScale, 1)
})

test('a cast that is delivering frames is left alone', async () => {
  const sent = []
  const page = new SidecarPage({ on: () => {}, send: async (method) => { sent.push(method); return {} } }, 'unit-live-ok')
  page.castScale = 1
  page.casting = true
  page.lastFrameAt = Date.now()
  let loops = 0
  page.castCrisp = async () => { loops += 1 }
  assert.equal(await page.liveDead(), false, 'a frame that just arrived is proof of life')
  assert.equal(sent.length, 0)
  assert.equal(loops, 0)
  assert.equal(page.casting, true)
  page.casting = false
})


test('the watcher closes the browser once the application is gone', async () => {
  /* Two stand-ins: the application, and the browser it started. The watcher is
     the code that ships, asked to look every 120 ms so the check stays quick. */
  const { spawn } = await import('node:child_process')
  const launch = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const app = launch()
  const chrome = launch()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const guard = spawn(process.execPath, ['-e', WATCHER_SCRIPT, String(app.pid), String(chrome.pid), '120'], { stdio: 'ignore' })
  const gone = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), 2500)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  try {
    app.kill('SIGKILL')
    assert.equal(await gone(chrome), true, 'the browser is closed after the application goes')
  } finally {
    for (const child of [app, chrome, guard]) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
})
