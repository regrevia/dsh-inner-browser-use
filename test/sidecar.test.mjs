import assert from 'node:assert/strict'
import test from 'node:test'

import { SidecarPage, VIEW } from '../sidecar.js'

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
