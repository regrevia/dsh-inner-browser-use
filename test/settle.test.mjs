import { test } from 'node:test'
import assert from 'node:assert/strict'
import { oncePerPage, withoutSeenAddress, pageMark } from '../tools.js?v=1'

import { settle } from '../tools.js'

/** A page that answers every Runtime.evaluate with the same readyState. */
function fakePage({ ready, href, navStarted }) {
  return {
    url: href,
    dialog: null,
    navStarted,
    navStopped: navStarted,
    cdp: {
      send: async () => ({ result: { value: { ready, href } } }),
    },
  }
}

test('a click that started no load does not wait for one', async () => {
  const now = Date.now()
  const page = fakePage({ ready: 'complete', href: 'https://example.com/a', navStarted: now - 5_000 })
  const at = Date.now()
  const landed = await settle(page, 5_000, now - 3_000)
  assert.equal(landed, 'https://example.com/a')
  /* One evaluate and no poll: the whole call should be far below the 25 ms the
     steady-state path spends per poll. */
  assert.ok(Date.now() - at < 22, `took ${Date.now() - at} ms`)
})

test('a load that started after the click is waited for', async () => {
  const page = fakePage({ ready: 'loading', href: 'https://example.com/b', navStarted: Date.now() })
  /* The navigation finishes only on the second look: a fast skip would have
     returned the loading address before the page was there. */
  let looks = 0
  page.cdp.send = async () => {
    looks += 1
    return { result: { value: { ready: looks > 1 ? 'complete' : 'loading', href: 'https://example.com/b' } } }
  }
  const at = Date.now()
  const landed = await settle(page, 5_000, Date.now() - 20)
  assert.equal(landed, 'https://example.com/b')
  assert.ok(looks >= 2, `read the page ${looks} time(s)`)
  assert.ok(Date.now() - at >= 20, `took ${Date.now() - at} ms`)
})

test('without a since time the old steady path still runs', async () => {
  const page = fakePage({ ready: 'complete', href: 'https://example.com/c', navStarted: 0 })
  const at = Date.now()
  await settle(page, 5_000, 0)
  assert.ok(Date.now() - at < 5_000)
})

test('a load the browser already said finished is not asked about again', async () => {
  let looks = 0
  const page = {
    url: 'https://example.com/d',
    dialog: null,
    navStarted: 2_500,
    loadFired: 2_900,
    cdp: { send: async () => { looks += 1; return { result: { value: { ready: 'complete', href: 'https://example.com/d' } } } } },
  }
  const at = Date.now()
  assert.equal(await settle(page, 5_000, 2_000), 'https://example.com/d')
  assert.equal(looks, 0, `asked the page ${looks} time(s)`)
  assert.ok(Date.now() - at < 10, `took ${Date.now() - at} ms`)
})

test('a page whose main thread never answers does not stall a finished load', async () => {
  /* A real page's own scripts can hold the renderer: Runtime.evaluate then
     answers seconds late. The load event already arrived, so the wait must not
     depend on that answer. */
  const page = {
    url: 'https://example.com/e',
    dialog: null,
    navStarted: 2_500,
    loadFired: 2_600,
    cdp: { send: () => new Promise(() => {}) },
  }
  const at = Date.now()
  assert.equal(await settle(page, 5_000, 0), 'https://example.com/e')
  assert.ok(Date.now() - at < 10, `took ${Date.now() - at} ms`)
})

test('a click into a page whose requests hang stops the load instead of waiting it out', async () => {
  const sent = []
  const page = {
    url: 'https://example.com/h',
    dialog: null,
    navStarted: Date.now(),
    loadFired: 0,
    cdp: { send: async (method) => { sent.push(method); return { result: { value: { ready: 'loading', href: 'https://example.com/h' } } } } },
  }
  const at = Date.now()
  const landed = await settle(page, 5_000, Date.now() - 10)
  const took = Date.now() - at
  assert.equal(landed, 'https://example.com/h')
  assert.ok(sent.includes('Page.stopLoading'), `sent ${sent.join(',')}`)
  assert.ok(took < 1_500, `took ${took} ms`)
})

test('the address is said once per page, then only what changed', () => {
  const page = {}
  assert.equal(oncePerPage(page, 'https://a.example/x · Title'), 'https://a.example/x · Title')
  assert.equal(oncePerPage(page, 'https://a.example/x · Title'), 'Title')
  assert.equal(oncePerPage(page, 'https://a.example/x · Title'), 'Title')
  assert.equal(oncePerPage(page, 'https://a.example/y · Other'), 'https://a.example/y · Other')
  assert.equal(oncePerPage(page, 'https://a.example/y · Other'), 'Other')
  /* A page with no title still has to answer with something. */
  assert.equal(oncePerPage(page, 'https://a.example/z'), 'https://a.example/z')
  assert.equal(oncePerPage(page, 'https://a.example/z'), 'https://a.example/z')
})

test('a read that repeats the address starts with the page instead', () => {
  const page = {}
  /* Nothing said yet: the address is what says which page this is. */
  assert.equal(withoutSeenAddress(page, 'https://a.example/x', 'https://a.example/x\n# Title\n1 [input]'), 'https://a.example/x\n# Title\n1 [input]')
  /* Said by the read just before: one line less, every time after that. */
  assert.equal(oncePerPage(page, 'https://a.example/x · Title'), 'https://a.example/x · Title')
  assert.equal(withoutSeenAddress(page, 'https://a.example/x', 'https://a.example/x\n# Title\n1 [input]'), '# Title\n1 [input]')
  /* A page that moved gets its new address in full. */
  assert.equal(withoutSeenAddress(page, 'https://a.example/y', 'https://a.example/y\n# Other'), 'https://a.example/y\n# Other')
})

test('a click can tell the page did nothing', async () => {
  /* A Flash page answers from its frame counter: two equal marks mean no frame came. */
  assert.equal(await pageMark({ flashBridge: 1234, seq: 3, lastFrameAt: 90 }), 'flash:3:90')
  assert.notEqual(await pageMark({ flashBridge: 1234, seq: 3, lastFrameAt: 90 }), await pageMark({ flashBridge: 1234, seq: 4, lastFrameAt: 120 }))
  /* A page that will not answer says nothing rather than a wrong answer. */
  assert.equal(await pageMark({ flashBridge: null, cdp: { send: async () => { throw new Error('gone') } } }), '')
})
