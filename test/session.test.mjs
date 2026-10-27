import test from 'node:test'
import assert from 'node:assert/strict'
import { Sidecar } from '../sidecar.js'

/** A page stand-in with just the parts the routing touches. */
function fakePage(url) {
  return {
    url,
    port: 0,
    cdp: { closed: false },
    frames: new Set(),
    pointerSinks: new Set(),
    async navigate(next) {
      this.url = next
    },
    async ping() {
      return { ok: true }
    },
  }
}

test('an unnamed caller drives the first tab', () => {
  const sidecar = new Sidecar()
  const page = fakePage('about:blank')
  sidecar.page = page
  assert.equal(sidecar.pageFor(''), page)
  assert.equal(sidecar.pageFor(undefined), page)
})

test('a named chat is given its own tab, once', () => {
  const sidecar = new Sidecar()
  sidecar.page = fakePage('about:blank')
  assert.equal(sidecar.pageFor('chat-a'), null)
  const mine = fakePage('https://example.com/a')
  sidecar.pages.set('chat-a', mine)
  assert.equal(sidecar.pageFor('chat-a'), mine)
  assert.equal(sidecar.pageFor('chat-b'), null)
  assert.equal(sidecar.page, sidecar.pageFor(''))
})

test('a tab whose connection closed is forgotten', () => {
  const sidecar = new Sidecar()
  sidecar.page = fakePage('about:blank')
  const mine = fakePage('https://example.com/a')
  mine.cdp.closed = true
  sidecar.pages.set('chat-a', mine)
  assert.equal(sidecar.pageFor('chat-a'), null)
  assert.equal(sidecar.pages.has('chat-a'), false)
})

test('asking with a chat navigates that chat\'s tab, not the first one', async () => {
  const sidecar = new Sidecar()
  const first = fakePage('https://example.com/first')
  sidecar.page = first
  sidecar.cdp = { closed: false }
  const mine = fakePage('https://example.com/a')
  sidecar.pages.set('chat-a', mine)
  const page = await sidecar.ensure({ session: 'chat-a', url: 'https://example.com/moved' })
  assert.equal(page, mine)
  assert.equal(mine.url, 'https://example.com/moved')
  assert.equal(first.url, 'https://example.com/first')
})

test('two chats keep two addresses', async () => {
  const sidecar = new Sidecar()
  const first = fakePage('https://example.com/first')
  sidecar.page = first
  sidecar.cdp = { closed: false }
  const a = fakePage('https://example.com/a')
  const b = fakePage('https://example.com/b')
  sidecar.pages.set('chat-a', a)
  sidecar.pages.set('chat-b', b)
  await sidecar.ensure({ session: 'chat-a', url: 'https://example.com/a2' })
  assert.equal(a.url, 'https://example.com/a2')
  assert.equal(b.url, 'https://example.com/b')
  assert.equal(first.url, 'https://example.com/first')
})
