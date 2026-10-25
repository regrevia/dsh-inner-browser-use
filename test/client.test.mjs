/**
 * Client-half tests: what the page registers, and the one thing it does on its
 * own — opening this chat's tab when a tool asks for it.
 *
 * The page is not here, so the two globals it needs are: a module loader to
 * hand the plugin back, and an `EventSource` the test can push a frame into.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

const style = { id: '', dataset: {}, textContent: '', remove() {} }

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
  createElement: () => ({ ...style, dataset: {} }),
  querySelector: () => null,
}
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
const ticks = []
globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length }
globalThis.clearInterval = () => {}
globalThis.EventSource = FakeEventSource
globalThis.fetch = async () => ({ ok: true })

await import('../client.js')

test('the tab type is additive: own id, own kind, no guide card', () => {
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
  assert.equal(opened.length, 1)
  const tab = opened[0]
  assert.equal(tab.id, 'dsh-inner-browser-use')
  assert.equal(tab.kind, 'inner-browser-use')
  assert.equal(tab.guide, undefined)
  assert.equal(typeof tab.title, 'function')
  assert.equal(tab.title(), '内置浏览器')
  assert.equal(tab.multiple, true)
})

test('a tool that needs a tab opens this chat tab in the right sidebar', () => {
  /** @type {any[]} */
  const opened = []
  /** @type {string[]} */
  const bars = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    workspaces: { list: () => [] },
  }
  const ctx = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    locale: { register: () => {} },
    inject: (_names, callback) => callback(scope),
    layout: { openRightbar: (...args) => bars.push(args.join(',')) },
    sidebarRight: { openTabIn: (...args) => opened.push(['session', ...args]) },
  }
  sources.length = 0
  definition.apply(ctx)
  const source = sources.at(-1)
  assert.equal(source.url, '/dsh-inner-browser-use/watch')
  source.send({ type: 'client-alive', phase: 'ready' })
  assert.deepEqual(opened, [])
  source.send({ type: 'wanted', session: 'chat-9' })
  assert.deepEqual(opened, [['session', 'chat-9', 'inner-browser-use', {}]])
  assert.deepEqual(bars, ['true,false'])
  source.send({ type: 'wanted', session: '' })
  assert.equal(opened.length, 1)
})

test('the current chat is the first way to open, and its id is the fallback', () => {
  /** @type {any[]} */
  const opened = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
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
    sidebarRight: {
      openTab: (...args) => opened.push(['current', ...args]),
      openTabIn: (...args) => opened.push(['session', ...args]),
    },
  }
  sources.length = 0
  definition.apply(ctx)
  const source = sources.at(-1)
  source.send({ type: 'wanted', session: 'chat-4' })
  assert.deepEqual(opened, [['current', 'inner-browser-use', {}]])
})

test('a strip that refuses the current chat falls back to the chat id', () => {
  /** @type {any[]} */
  const opened = []
  const scope = {
    effect: (effect) => {
      effect()
      return () => {}
    },
    slots: { inject: () => {}, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
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
    sidebarRight: {
      openTab: () => {
        throw new Error('no chat')
      },
      openTabIn: (...args) => opened.push(['session', ...args]),
    },
  }
  sources.length = 0
  definition.apply(ctx)
  const source = sources.at(-1)
  source.send({ type: 'wanted', session: 'chat-5' })
  assert.deepEqual(opened, [['session', 'chat-5', 'inner-browser-use', {}]])
})
