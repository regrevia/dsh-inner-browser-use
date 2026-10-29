import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SidecarPage } from '../sidecar.js'

/** A page object with only what troubleOf reads: no browser, no socket. */
const fake = (rows) => Object.assign(Object.create(SidecarPage.prototype), { console: [], network: [], failed: [], troubleSeen: 0, troubleSeq: 0, ...rows })

test('a page with nothing wrong says nothing', () => {
  const page = fake({ console: [{ type: 'log', text: 'ready', seq: 1 }], troubleSeq: 1 })
  assert.equal(page.troubleOf(), '')
})

test('a failed request names the path and the status', () => {
  const page = fake({
    network: [{ method: 'GET', url: 'https://shop.test/api/cart?x=1', status: 500, seq: 2 }],
    troubleSeq: 2,
  })
  const said = page.troubleOf()
  assert.match(said, /1 request failed \(GET \/api\/cart\?x=1 → 500\)/)
  assert.match(said, /browser_network/)
})

test('a script error shows one line, not a stack', () => {
  const page = fake({ console: [{ type: 'error', text: 'TypeError: cart is undefined\n    at app.js:2:3', seq: 3 }], troubleSeq: 3 })
  const said = page.troubleOf()
  assert.match(said, /1 JS error \(TypeError: cart is undefined\)/)
  assert.equal(said.includes('at app.js'), false)
})

test('each trouble is reported once', () => {
  const page = fake({ network: [{ method: 'POST', url: 'https://a.test/x', status: 404, seq: 1 }], troubleSeq: 1 })
  assert.notEqual(page.troubleOf(), '')
  assert.equal(page.troubleOf(), '')
})

test('aborted requests are not trouble', () => {
  const page = fake({ failed: [{ error: 'net::ERR_ABORTED', type: 'Fetch', seq: 4 }], troubleSeq: 4 })
  assert.equal(page.troubleOf(), '')
})

test('a dropped connection is named', () => {
  const page = fake({ failed: [{ error: 'net::ERR_CONNECTION_REFUSED', type: 'Fetch', seq: 5 }], troubleSeq: 5 })
  assert.match(page.troubleOf(), /did not load \(net::ERR_CONNECTION_REFUSED\)/)
})

test('everything at once stays one line', () => {
  const page = fake({
    console: [{ type: 'error', text: 'boom', seq: 1 }],
    network: [{ method: 'GET', url: '/a', status: 500, seq: 2 }],
    failed: [{ error: 'net::ERR_FAILED', type: 'Script', seq: 3 }],
    troubleSeq: 3,
  })
  const said = page.troubleOf()
  assert.equal(said.split('\n').length, 1)
  assert.ok(said.length < 300)
  assert.match(said, /failed.*did not load.*JS error/)
})
