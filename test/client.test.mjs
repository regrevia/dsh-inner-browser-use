/**
 * Client-half tests: what the page registers, and the one thing it does on its
 * own — opening this chat's tab when a tool asks for it.
 *
 * The page is not here, so the two globals it needs are: a module loader to
 * hand the plugin back, and an `EventSource` the test can push a frame into.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

/** @type {any} */
let definition

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  memo: (component) => component,
  Fragment: 'Fragment',
}

/** @type {{url: string, listeners: Map<string, (event: any) => void>, close: () => void}[]} */
const sources = []

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    this.listeners = new Map()
    sources.push(this)
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  close() {
    this.closed = true
  }

  /** @param {any} frame - the frame the Host would push down the watch stream. */
  send(frame) {
    this.listeners.get('message')?.({ data: JSON.stringify(frame) })
  }
}

/* A guest is mounted for a chat with no pane, so an element has to model the
   handful of calls that mounting makes before the missing desktop stops it. */
const style = {
  id: '',
  dataset: {},
  textContent: '',
  className: '',
  setAttribute() {},
  getAttribute: () => null,
  appendChild() {},
  addEventListener() {},
  remove() {},
}

globalThis.window = {
  location: { origin: 'http://dsh.invalid' },
  __ModuleLoader__: {
    load(module) {
      definition = module.factory((name) => {
        if (name === 'react') return react
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: () => ({ ...style, dataset: {} }),
  querySelector: () => null,
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
const ticks = []
globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length }
globalThis.clearInterval = () => {}
globalThis.EventSource = FakeEventSource
let replyEpoch = 'epoch-1'
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, epoch: replyEpoch }) })

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Script(`${clientSource}\nglobalThis.__testRevealAllowed = revealAllowed\nglobalThis.__testCookies = { cookiesOf, cookiesSave, cookiesRestore }`).runInThisContext()

test('the product browser tab is the only tab opened, so no look-alike is added', () => {
  /** @type {any[]} */
  const opened = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
    sidebarRightTabs: {
      register: (registered) => {
        opened.push(registered)
        return () => {}
      },
    },
    workspaces: { list: () => [] },
  }
  const ctx = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    locale: { register: () => {} },
    inject: (_names, callback) => callback(scope),
    layout: { openRightbar: () => {} },
    sidebarRight: { openTabIn: () => {} },
  }
  definition.apply(ctx)
  assert.deepEqual(opened, [])
})

function scene({ openTab, openTabIn } = {}) {
  /** @type {any[]} */
  const opened = []
  /** @type {string[]} */
  const bars = []
  /** @type {string[][]} */
  const injected = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    workspaces: { list: () => [] },
    layout: { openRightbar: (...args) => bars.push(args.join(',')) },
    sidebarRight: {
      ...(openTab === undefined ? {} : {
        openTab: (...args) => {
          if (openTab === 'throw') throw new Error('no strip')
          opened.push(['current', ...args])
        },
      }),
      ...(openTabIn === 'absent' ? {} : {
        openTabIn: (...args) => {
          if (openTabIn === 'throw') throw new Error('no strip')
          opened.push(['session', ...args])
        },
      }),
    },
  }
  const ctx = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    locale: { register: () => {} },
    inject: (names, callback) => {
      injected.push(names)
      return callback(scope)
    },
  }
  sources.length = 0
  definition.apply(ctx)
  return { opened, bars, injected, source: sources.at(-1) }
}

test('a page is shown only for the chat the shell says is on screen', async () => {
  const revealAllowed = globalThis.__testRevealAllowed
  const onScreen = new Set(['chat-shown'])
  const view = (current, routed) => ({ current, routed, onScreen })
  assert.equal(revealAllowed('', view('', '')), true)
  assert.equal(revealAllowed('chat-1', view('chat-1', '')), true)
  assert.equal(revealAllowed('chat-2', view('chat-1', 'chat-2')), true)
  assert.equal(revealAllowed('chat-shown', view('chat-1', 'chat-2')), true)
  assert.equal(revealAllowed('chat-9', view('chat-1', 'chat-2')), false)
  assert.equal(revealAllowed('chat-9', view('', '')), false)
  assert.equal(revealAllowed('chat-9', view('chat-1', '')), false)
})

test('the ask reaches the strip as an injected service', () => {
  const { injected, source } = scene()
  assert.deepEqual(injected[0], ['layout', 'sidebarRight'])
  assert.equal(source.url, '/dsh-inner-browser-use/watch')
})

test('a tool that needs a page opens the product browser tab for this chat', () => {
  const { opened, bars, source } = scene()
  source.send({ type: 'client-alive', phase: 'ready' })
  assert.deepEqual(opened, [])
  source.send({ type: 'wanted', session: 'chat-9' })
  assert.deepEqual(opened, [['session', 'chat-9', 'browser', {}]])
  /* The panel is the product's: opening a tab opens it, and forcing the panel
     here put it into a width mode the person had not asked for. */
  assert.deepEqual(bars, [])
  source.send({ type: 'wanted', session: '' })
  assert.equal(opened.length, 1)
})

test('the asking chat id is the only way to open, so no other chat is touched', () => {
  const { opened, source } = scene({ openTab: () => {} })
  source.send({ type: 'wanted', session: 'chat-4' })
  assert.deepEqual(opened, [['session', 'chat-4', 'browser', {}]])
})

test('a strip without the id path opens nothing rather than steering the current chat', () => {
  const { opened, source } = scene({ openTabIn: 'absent' })
  source.send({ type: 'wanted', session: 'chat-5' })
  assert.deepEqual(opened, [])
})

test('a heartbeat naming a new half reopens the ask stream once', async () => {
  const { opened } = scene()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const before = sources.length
  replyEpoch = 'epoch-1'
  for (const tick of ticks) tick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(sources.length, before)
  replyEpoch = 'epoch-2'
  for (const tick of ticks) tick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(sources.length, before + 1)
  assert.equal(sources.at(-1).url, '/dsh-inner-browser-use/watch')
  replyEpoch = 'epoch-2'
  for (const tick of ticks) tick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(sources.length, before + 1)
})

/** A guest whose page answers as this one does. */
function guest(cookies, origin) {
  return {
    executeJavaScript: async (code) => {
      if (code.includes('document.cookie')) return cookies
      if (code.includes('location.origin')) return origin
      return ''
    },
  }
}

test('the cookies this page can see are read back with the origin they belong to', async () => {
  const { cookiesOf } = /** @type {any} */ (globalThis).__testCookies
  const seen = await cookiesOf(guest('sid=alice; theme=dark', 'https://example.test'))
  assert.deepEqual(seen, [
    { name: 'sid', value: 'alice', url: 'https://example.test' },
    { name: 'theme', value: 'dark', url: 'https://example.test' },
  ])
  assert.deepEqual(await cookiesOf(guest('', 'about:blank')), [])
  assert.deepEqual(await cookiesOf(guest('sid=alice', 'null')), [])
})

test('a page keeps its own sign-in and leaves another site alone', async () => {
  const { cookiesSave } = /** @type {any} */ (globalThis).__testCookies
  /** @type {any[]} */
  const posted = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return { ok: true, json: async () => ({ kept: posted.at(-1).cookies.length }) }
    }
    return { ok: true, json: async () => ({ cookies: [{ name: 'other', value: 'x', url: 'https://elsewhere.test' }] }) }
  }
  const kept = await cookiesSave(guest('sid=alice', 'https://example.test'), 'session:chat-1', () => {})
  assert.equal(kept, 2)
  assert.deepEqual(posted.at(-1).cookies, [
    { name: 'other', value: 'x', url: 'https://elsewhere.test' },
    { name: 'sid', value: 'alice', url: 'https://example.test' },
  ])
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
})

test('a sign-in kept for this origin is written back one cookie at a time', async () => {
  const { cookiesRestore } = /** @type {any} */ (globalThis).__testCookies
  /** @type {string[]} */
  const written = []
  const el = {
    executeJavaScript: async (code) => {
      if (code.includes('document.cookie =')) written.push(code)
      if (code.includes('location.origin')) return 'https://example.test'
      return ''
    },
  }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ cookies: [
      { name: 'sid', value: 'alice', url: 'https://example.test' },
      { name: 'theme', value: 'dark', url: 'https://example.test' },
      { name: 'other', value: 'x', url: 'https://elsewhere.test' },
    ] }),
  })
  const restored = await cookiesRestore(el, 'session:chat-1', () => {})
  assert.equal(restored, 2)
  const script = written.join('')
  assert.match(script, /"sid=alice; path=\//)
  assert.match(script, /"theme=dark; path=\//)
  assert.doesNotMatch(script, /elsewhere/)
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
})

test('a page that saves a file on its own has somewhere to put it', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /'dl-watch'/)
  assert.match(source, /'dl-drain'/)
  assert.match(source, /__dshib_land/)
  assert.match(source, /\/land\?session=/)
})

test('a page is looked for in the chat its call belongs to', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /data-sidebar-right-session/)
  assert.match(source, /function nativeElement\(sessionId\)/)
  assert.match(source, /nativeReady\(40, options\.sessionId\)/)
})
