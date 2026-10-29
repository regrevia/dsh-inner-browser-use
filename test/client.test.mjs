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
/** What the host says about the browser behind the column; a test may change it. */
let stateReply = { owner: '', alive: false, chat: { alive: false } }

globalThis.fetch = async (url, init) => {
  const address = String(url)
/* A POST with no body is still a request worth recording: the close path sends
   one, and `JSON.parse(undefined)` would throw before the test could look. */
  posts.push({ url: address, body: init?.body === undefined ? null : JSON.parse(init.body) })
  if (address.includes('/sidecar/state')) return { ok: true, json: async () => stateReply }
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
function scene({ openTab, openTabIn, mounted = '', state = null } = {}) {
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
  stateReply = state === null ? { owner: '', alive: false, chat: { alive: false } } : state
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

test('a tab closed from the strip tells the host, so the keepalive leaves it closed', () => {
  const { tabs } = scene()
  assert.equal(typeof tabs[0].onClose, 'function')
  tabs[0].onClose({ id: 'dsh-inner-browser-use:sidecar' }, { sessionId: 'chat-shown' })
  assert.equal(posts.some((post) => post.url.includes('/sidecar/forget?session=chat-shown')), true)
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

test('the mirror comes back by itself in the chat that still owns the browser', async () => {
  const owned = { owner: 'chat-shown', alive: true, chat: { alive: true } }
  const back = scene({ mounted: 'chat-shown', state: owned })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(back.opened, [['session', 'chat-shown', 'inner-browser-sidecar', {}]])

  /* A browser another chat owns is not this column's to reopen. */
  const theirs = scene({ mounted: 'chat-shown', state: { ...owned, owner: 'chat-elsewhere' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(theirs.opened, [])

  /* An empty column asks nobody and opens nothing. */
  const unknown = scene({ state: owned })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(unknown.opened, [])
})

test('nothing opens the mirror on a frame that asks for nothing', () => {
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

  const plain = (key, keyCode, extra = {}) => ({ key, code: key, keyCode, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...extra }) // ui-copy-ignore

  stage.props.onKeyDown(plain('Backspace', 8))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'Backspace', code: 'Backspace', keyCode: 8, modifiers: 0, session: 'chat-shown' })

  stage.props.onKeyDown(plain('Enter', 13))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'Enter', code: 'Enter', keyCode: 13, modifiers: 0, session: 'chat-shown' })

  /* A capital keeps its shift, so the page gets `A` and not `a`. */
  stage.props.onKeyDown(plain('A', 65, { shiftKey: true }))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'A', code: 'A', keyCode: 65, modifiers: 8, text: 'A', session: 'chat-shown' })

  /* A shortcut stays a shortcut, and carries no text of its own. */
  stage.props.onKeyDown(plain('v', 86, { metaKey: true }))
  assert.deepEqual(posts.at(-1).body, { kind: 'key', key: 'v', code: 'v', keyCode: 86, modifiers: 4, session: 'chat-shown' })

  /* A key the IME is still composing is its own, not the page's. */
  const held = plain('a', 65)
  held.isComposing = true
  const sent = posts.length
  stage.props.onKeyDown(held)
  assert.equal(posts.length, sent)

  /* The composed word travels once, and the field empties. */
  field.props.onCompositionEnd({ data: '你好' })
  assert.deepEqual(posts.at(-1).body, { kind: 'text', text: '你好', session: 'chat-shown' })
})

test('hover carries the page cursor, and only a cursor the pane knows is applied', () => {
  assert.match(clientSource, /const CURSORS = \[[^\]]*'text'[^\]]*'zoom-out'\]/)
  assert.match(clientSource, /el\.style\.cursor = CURSORS\.includes\(name\) === true \? name : 'default'/)
  assert.match(clientSource, /kind: 'hover'/)
})

test('a pane with no picture still offers to reopen its last page, and asks as its chat', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* The state poll names the chat: an anonymous poll cannot pick up a browser
     that outlived a reload. */
  assert.ok(source.includes('/sidecar/state?session='))
  /* The reopen button is drawn whenever there is no picture, not only while a
     stream is live: a dead browser is exactly the case it exists for. */
  assert.ok(source.includes("frame === null && back !== ''"))
  assert.ok(source.includes("frame === null && back !== '' && phase === 'live'") === false)
  /* And the remembered address comes from the poll too, not only from a stream
     hello that never arrives when the browser is gone. */
  assert.ok(source.includes('info?.chat?.remembered'))
})

test('a viewport the browser refused is asked for again', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* One request that arrives while the page is starting is refused, and the
     pane used to keep a letterboxed picture for as long as it stayed open. */
  assert.ok(source.includes('tries >= 5'))
  assert.ok(source.includes('timer = setTimeout(send, 400)'))
  /* And it is not repeated once the page already has the pane's shape. */
  assert.ok(source.includes('Math.abs(Number(view?.w ?? 0) - size.w) < 1'))
  assert.ok(source.includes('[mine, size.w, size.h, view?.w, view?.h]'))
})

test('the arrow goes away as soon as a hand lands on the pane, not after a round trip', () => {
  /* A Windows checkout may hand the file back with CRLF line endings. */
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  /* The pane's own input is the earliest evidence a person is driving: it hides
     the arrow before the browser reports a hold, and it looks again after. */
  assert.match(source, /const touched = \(\) => \{\n\s+setHand\(true\)/)
  for (const hook of ['onPointerDown', 'onPointerMove', 'onWheel', 'onKeyDown']) {
    const body = source.slice(source.indexOf(`const ${hook} = (event) => {`))
    assert.ok(body.slice(0, 120).includes('touched()'), `${hook} hides the arrow`)
  }
  assert.match(source, /const pointer = person === true \|\| hand === true \? null : ptr/)
  /* A timer left running after the tab is gone is a callback with no page. */
  assert.ok(source.includes('clearTimeout(handTimer.current)'))
})
