/**
 * Client-half tests: what the page registers, the one thing it does on its own
 * (opening this chat's mirror when a tool asks), and what a hand on the picture
 * sends to the browser behind it.
 *
 * The page is not here, so the globals it needs are: a module loader to hand the
 * plugin back, an `EventSource` the test can push a frame into, and a `fetch`
 * that records what the pane posts.
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

  /** @param {any} frame - the frame the tool half would push down a stream. */
  send(frame) {
    this.listeners.get('message')?.({ data: JSON.stringify(frame) })
  }
}

/* An element has to model the handful of calls the pane makes while it mounts. */
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
globalThis.EventSource = FakeEventSource

/** @type {{url: string, body: any}[]} */
const posts = []
globalThis.fetch = async (url, init) => {
  posts.push({ url: String(url), body: init === undefined ? null : JSON.parse(init.body) })
  return { ok: true, json: async () => ({ ok: true, cursor: 'text' }) }
}

const ticks = []
globalThis.setInterval = (fn) => {
  ticks.push(fn)
  return ticks.length
}
globalThis.clearInterval = () => {}

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Script(clientSource).runInThisContext()

/**
 * @param {{openTab?: string, openTabIn?: string, mounted?: string | (() => string)}} options
 *   `mounted` may be a function so a test can move the on-screen chat.
 */
function scene({ openTab, openTabIn, mounted = '' } = {}) {
  const onScreen = () => (typeof mounted === 'function' ? mounted() : mounted)
  /** @type {any[]} */
  const opened = []
  /** @type {any[]} */
  const tabs = []
  /** @type {string[][]} */
  const injected = []
  /** @type {any[]} */
  const components = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: (config, Component) => {
        if (Component !== undefined) components.push(Component)
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (registered) => {
        tabs.push(registered)
        return () => {}
      },
    },
    sidebarRight: {
      mounted: { getSnapshot: () => onScreen() },
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
  posts.length = 0
  ticks.length = 0
  definition.apply(ctx)
  return { opened, injected, tabs, components, source: sources.at(-1), sources }
}

test('the mirror tab is the only tab added, a tab type kept mounted, and never a page of its own', () => {
  const { tabs } = scene()
  assert.deepEqual(tabs.map((tab) => tab.kind), ['inner-browser-sidecar'])
  const [sidecar] = tabs
  assert.equal(sidecar.id, 'dsh-inner-browser-use:sidecar')
  assert.equal(sidecar.keepMounted, true)
  assert.equal(sidecar.single, true)
  assert.equal(sidecar.priority, 'extension')
  assert.equal(sidecar.title(), '后台浏览器')
})

test('the mirror opens only in the chat a tool asked for, and only while it is on screen', () => {
  const shown = scene({ mounted: 'chat-shown' })
  shown.source.send({ type: 'sidecar-wanted', session: 'chat-shown' })
  assert.deepEqual(shown.opened, [['session', 'chat-shown', 'inner-browser-sidecar', {}]])

  /* A chat that is not the one on screen never takes the column. */
  const other = scene({ mounted: 'chat-elsewhere' })
  other.source.send({ type: 'sidecar-wanted', session: 'chat-shown' })
  assert.deepEqual(other.opened, [])

  /* An unmounted column is unknown, not free, and it opens no stream at all. */
  const unknown = scene()
  assert.deepEqual(unknown.sources, [])
  assert.deepEqual(unknown.opened, [])

  /* A frame that names no chat names nobody's column. */
  const empty = scene({ mounted: 'chat-shown' })
  empty.source.send({ type: 'sidecar-wanted', session: '' })
  assert.deepEqual(empty.opened, [])
})

test('the ask stream follows the chat on screen, so a switch closes the old one', () => {
  let onScreen = 'chat-a'
  const moved = scene({ mounted: () => onScreen })
  assert.equal(moved.source.url, '/dsh-inner-browser-use/downlink?session=chat-a')
  const first = moved.source

  onScreen = 'chat-b'
  for (const tick of ticks) tick()
  assert.equal(first.closed, true)
  assert.equal(moved.sources.at(-1).url, '/dsh-inner-browser-use/downlink?session=chat-b')

  /* A frame for the chat that left is ignored. */
  first.send({ type: 'sidecar-wanted', session: 'chat-a' })
  assert.deepEqual(moved.opened, [])
  moved.sources.at(-1).send({ type: 'sidecar-wanted', session: 'chat-b' })
  assert.deepEqual(moved.opened, [['session', 'chat-b', 'inner-browser-sidecar', {}]])
})

test('nothing opens the mirror by itself, not even when a sidecar is running', () => {
  const quiet = scene({ mounted: 'chat-shown' })
  assert.deepEqual(quiet.opened, [])
  /* Only the frame a tool asks for opens anything. */
  quiet.source.send({ type: 'hello', session: 'chat-shown' })
  quiet.source.send({ type: 'pointer', pointer: { x: 1, y: 2 } })
  assert.deepEqual(quiet.opened, [])
})

test('the ask reaches the strip as an injected service', () => {
  const { injected, source } = scene({ mounted: 'chat-shown' })
  assert.deepEqual(injected[0], ['sidebarRightTabs', 'sidebarRight'])
  assert.equal(source.url, '/dsh-inner-browser-use/downlink?session=chat-shown')
})

test('a key reaches the browser as itself, and a composed word as text', () => {
  const screen = scene({ mounted: 'chat-shown' })
  const body = screen.components[0]({ sessionId: 'chat-shown' })
  const stage = body.children[1]
  const field = stage.children.find((child) => child.type === 'textarea')

  const plain = (key, keyCode) => ({ key, code: key, keyCode, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault() {} }) // ui-copy-ignore

  stage.props.onKeyDown(plain('Backspace', 8))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'Backspace', code: 'Backspace', keyCode: 8 })

  stage.props.onKeyDown(plain('Enter', 13))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'Enter', code: 'Enter', keyCode: 13 })

  /* A key the IME is still composing is its own, not the page's. */
  const held = plain('a', 65)
  held.isComposing = true
  const sent = posts.length
  stage.props.onKeyDown(held)
  assert.equal(posts.length, sent)

  /* The composed word travels once, and the field empties. */
  field.props.onCompositionEnd({ data: '你好' })
  assert.deepEqual(posts.at(-1).body, { kind: 'text', text: '你好' })
})

test('hover carries the page cursor, and only a cursor the pane knows is applied', () => {
  assert.match(clientSource, /const CURSORS = \[[^\]]*'text'[^\]]*'zoom-out'\]/)
  assert.match(clientSource, /el\.style\.cursor = CURSORS\.includes\(name\) === true \? name : 'default'/)
  assert.match(clientSource, /kind: 'hover'/)
})
