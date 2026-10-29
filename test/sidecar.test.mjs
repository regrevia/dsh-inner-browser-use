import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { Sidecar, SidecarPage, VIEW, canArmWatcher, deathNote, looksLikeApp, noteDeath, ownsBrowser, rootDir } from '../sidecar.js'
import { findWords } from '../tools.js'

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
  /* A column too small to be a browser, or bigger than a screen, is ignored
     rather than applied as a sliver. */
  await page.setViewport(100, 880)
  await page.setViewport(3000, 900)
  assert.deepEqual(page.view, { width: 720, height: 880 })
  /* A narrow, tall column is the shape a right-hand column has, and the page is
     laid out at it so the picture fills the pane instead of sitting in bars. */
  assert.deepEqual(await page.setViewport(260, 1900), { width: 260, height: 1900 })
  /* The Flash window is the picture: it is resized rather than laid out with
     device metrics, because a plugin surface ignores them. */
  page.flashBridge = 9211
  const resized = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => { resized.push(String(url)); return { ok: true } }
  const flashSent = sent.length
  await page.setViewport(747, 1196)
  globalThis.fetch = realFetch
  page.flashBridge = null
  assert.deepEqual(resized, ['http://127.0.0.1:9211/resize?w=747&h=1196'])
  assert.equal(sent.length, flashSent)
  assert.deepEqual(page.view, { width: 747, height: 1196 })
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
  assert.deepEqual(sent.map((call) => call.method).slice(0, 2), ['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast'])
  const started = sent.find((call) => call.method === 'Page.startScreencast')
  assert.deepEqual({ w: started.params.maxWidth, h: started.params.maxHeight }, { w: 700, h: 860 })
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
  assert.match(source, /webContents\.sendInputEvent\(event\)/)
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
})
