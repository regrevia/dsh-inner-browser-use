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
  querySelectorAll: (selector) => (selector === '[data-sidebar-right-session]'
    ? globalThis.__panels.map((panel) => ({
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        ...panel,
      }))
    : []),
}
globalThis.__panels = []
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true })
const ticks = []
globalThis.setInterval = (fn) => { ticks.push(fn); return ticks.length }
globalThis.clearInterval = () => {}
globalThis.EventSource = FakeEventSource
let replyEpoch = 'epoch-1'
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, epoch: replyEpoch }) })

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Script(`${clientSource}\nglobalThis.__testRevealAllowed = revealAllowed\nglobalThis.__testCookies = { cookiesOf, cookiesSave, cookiesRestore }\nglobalThis.__testPages = { rememberedPage, rememberPage }`).runInThisContext()

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
  globalThis.__panels = []
  globalThis.window.location = { origin: 'http://dsh.invalid' }
  /** @type {string[]} */
  const beats = []
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/uplink') && init?.body !== undefined) beats.push(String(init.body).slice(0, 160))
    return { ok: true, json: async () => ({ ok: true, epoch: replyEpoch }) }
  }
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
  return { opened, bars, beats, injected, source: sources.at(-1) }
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
  globalThis.__panels = [{ dataset: { sidebarRightSession: 'chat-9' } }]
  source.send({ type: 'wanted', session: 'chat-9' })
  /* The column holds no tab when the ask lands, so the ask is repeated until a
     page is there; every one of them is this chat's browser tab. */
  assert.ok(opened.length >= 1, 'the tab is asked for')
  assert.deepEqual(new Set(opened.map((one) => JSON.stringify(one))).size, 1)
  assert.deepEqual(opened[0], ['session', 'chat-9', 'browser', {}])
  /* The panel is the product's: opening a tab opens it, and forcing the panel
     here put it into a width mode the person had not asked for. */
  assert.deepEqual(bars, [])
  source.send({ type: 'wanted', session: '' })
  assert.ok(opened.length <= 3, 'a page that never shows is not asked for forever')
})

test('the asking chat id is the only way to open, so no other chat is touched', () => {
  const { opened, source } = scene({ openTab: () => {} })
  globalThis.__panels = [{ dataset: { sidebarRightSession: 'chat-4' } }]
  source.send({ type: 'wanted', session: 'chat-4' })
  assert.ok(opened.length >= 1)
  assert.deepEqual(opened.every((one) => one[1] === 'chat-4'), true)
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

test('a file the page cannot hand over is named, not dropped', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* Over the size the page will read, or past the sixth file in one go, the
     call says which file stayed behind, so the person can ask the page again. */
  assert.match(source, /blob\.size > 7 \* 1024 \* 1024\) return skip\(name, blob\.size, 'large'\)/)
  assert.match(source, /if \(W\.__dshib_land\.length >= 6\) return skip\(name, blob\.size, 'many'\)/)
  assert.match(source, /op === 'dl-skip'/)
  assert.match(source, /Not saved \(over 7 MB\)/)
  assert.match(source, /Not saved \(six files at a time\)/)
})

test('a page is looked for in the chat its call belongs to', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /data-sidebar-right-session/)
  assert.match(source, /function nativeElement\(sessionId\)/)
  assert.match(source, /nativeReady\(40, options\.sessionId\)/)
})

test('a tab that never appeared is not reported as open', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /opened = 'no-panel'/)
  assert.match(source, /panelOf\(sessionId\)\.length > 0/)
})

test('a page is only ever the one the product tab holds', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* The window lends a page to the product's own tab and to nothing else, so a
     chat without one asks its column for a tab holding the page it last had. */
  assert.match(source, /openNativeTab\(options\.sessionId, NATIVE_KIND, rememberedPage\(options\.sessionId\)\)/)
  /* Out of sight there is no page to make: the chat answers once it is shown. */
  assert.match(source, /options\.hidden === true && NATIVE_MODE === true\)[\s\S]{0,400}?options\.onPhase\('waiting'\)[\s\S]{0,80}?return/)
})

test('a chat whose column was never opened gets one before its tab', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /showColumn = \(\) => \{/)
  assert.match(source, /await oneAtATime\(async \(\) => \{\n(?:.*\n)*?\s+if \(panelOf\(sessionId\)\.length > 0\) return/)
})

test('a chat whose column was never opened gets one, docked, before its tab', async () => {
  const { opened, bars, beats, source } = scene()
  globalThis.__panels = []
  source.send({ type: 'wanted', session: 'chat-7' })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(bars, ['true,false'], beats.join('|'))
  /* The page waits for the column to appear before it opens the tab in it. */
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  assert.deepEqual(opened, [['session', 'chat-7', 'browser', {}]], beats.join('|'))
})

test('a column that is already up is not pressed, because the control toggles', async () => {
  const clicks = []
  const button = { click: () => clicks.push('click') }
  const was = globalThis.document.querySelector
  globalThis.document.querySelector = (selector) => (selector === '[data-sidebar-right-expand]' ? button : null)
  try {
    const { bars, source } = scene()
    globalThis.__panels = [{ dataset: {}, getBoundingClientRect: () => ({ width: 575, height: 900 }) }]
    source.send({ type: 'wanted', session: 'chat-2' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.deepEqual(clicks, [])
    assert.deepEqual(bars, [])
  } finally {
    globalThis.document.querySelector = was
    globalThis.__panels = []
  }
})

test('a call for a chat that is not on screen asks by its own id and takes no column', async () => {
  const was = globalThis.window.location
  try {
    const { opened, bars, source } = scene()
    globalThis.window.location = { origin: 'http://dsh.invalid', href: 'http://dsh.invalid/session-abcd1234ef56' }
    globalThis.__panels = [{ dataset: { sidebarRightSession: 'session-abcd1234ef56' }, getBoundingClientRect: () => ({ width: 575, height: 900 }) }]
    source.send({ type: 'wanted', session: 'session-away9999' })
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.deepEqual(bars, [])
    /* The ask carries the chat's own id, so the tab it makes lands in that
       chat's column: the column in front of the person is left alone. */
    const mine = opened.filter((one) => one[1] === 'session-away9999')
    assert.ok(mine.length >= 1, 'the away chat is asked for by id')
    for (const one of opened) assert.notEqual(one[1], 'session-abcd1234ef56')
  } finally {
    globalThis.window.location = was
    globalThis.__panels = []
  }
})

test('two asks for one chat open only that chat\'s tab', async () => {
  const was = globalThis.document.querySelector
  const button = {
    click: () => {
      const panel = { dataset: { sidebarRightSession: 'chat-8' }, getBoundingClientRect: () => ({ width: 575, height: 900 }) }
      globalThis.__panels.push(panel)
    },
  }
  globalThis.document.querySelector = (selector) => (selector === '[data-sidebar-right-expand]' ? button : null)
  try {
    const { opened, source } = scene()
    globalThis.__panels = []
    source.send({ type: 'wanted', session: 'chat-8' })
    source.send({ type: 'wanted', session: 'chat-8' })
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    /* One chat, one kind, one address: the product opens what is already there
       instead of a second browser beside it. */
    assert.ok(opened.length >= 1)
    assert.deepEqual(new Set(opened.map((one) => JSON.stringify(one))).size, 1)
    assert.deepEqual(opened[0], ['session', 'chat-8', 'browser', {}])
    assert.ok(opened.length <= 3)
  } finally {
    globalThis.document.querySelector = was
    globalThis.__panels = []
  }
})

test('a page a chat was told to open is read back after a remount', () => {
  const store = new Map()
  const was = Object.getOwnPropertyDescriptor(globalThis.window, 'localStorage')
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  })
  try {
    const { rememberPage: keep, rememberedPage: read } = globalThis.__testPages
    assert.equal(read('chat-new'), '')
    keep('chat-new', 'https://example.org/one')
    assert.equal(read('chat-new'), 'https://example.org/one')
    keep('chat-new', 'https://example.org/two')
    assert.equal(read('chat-new'), 'https://example.org/two')
    assert.equal(store.get('dshib:url:chat-new'), 'https://example.org/two')
    assert.equal(read('chat-other'), '')
  } finally {
    if (was === undefined) delete globalThis.window.localStorage
    else Object.defineProperty(globalThis.window, 'localStorage', was)
  }
})

test('an update that closed the tab brings it back for the chat on screen', async () => {
  const chat = 'session-abcd1234ef56'
  const store = new Map([['dshib:url:' + chat, 'https://example.org/keep']])
  const wasStorage = Object.getOwnPropertyDescriptor(globalThis.window, 'localStorage')
  const wasLocation = globalThis.window.location
  Object.defineProperty(globalThis.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  })
  const loaded = []
  const opened = []
  const webview = {
    getURL: () => 'about:blank',
    loadURL: (to) => loaded.push(to),
    addEventListener: () => {},
    getBoundingClientRect: () => ({ width: 575, height: 900 }),
  }
  const panel = (guest) => ({
    dataset: { sidebarRightSession: chat },
    getBoundingClientRect: () => ({ width: 575, height: 900 }),
    querySelector: (selector) => (guest === true && String(selector).includes('webview') ? webview : null),
    querySelectorAll: (selector) => (guest === true && selector === 'webview' ? [webview] : []),
  })
  try {
    globalThis.window.location = { origin: 'http://dsh.invalid', href: 'http://dsh.invalid/' + chat }
    const { beats, opened } = scene()
    globalThis.__panels.push(panel(false))
    setTimeout(() => globalThis.__panels.push(panel(true)), 1_000)
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    assert.equal(beats.filter((frame) => frame.includes('restore-tab')).length > 0, true)
    assert.deepEqual(loaded, ['https://example.org/keep'])
  } finally {
    if (wasStorage === undefined) delete globalThis.window.localStorage
    else Object.defineProperty(globalThis.window, 'localStorage', wasStorage)
    globalThis.window.location = wasLocation
    globalThis.__panels = []
  }
})

/* The guest code that runs inside the page is a string; a copy of it is lifted
   out by braces so its send-button lookup is tested as it ships. */
function guestFunction(name) {
  const start = clientSource.indexOf('const ' + name + ' =')
  assert.notEqual(start, -1, name + ' is in the guest code')
  const open = clientSource.indexOf('{', start)
  let depth = 0
  for (let at = open; at < clientSource.length; at += 1) {
    if (clientSource[at] === '{') depth += 1
    if (clientSource[at] === '}') {
      depth -= 1
      if (depth === 0) return clientSource.slice(start, at + 1)
    }
  }
  throw new Error('no end for ' + name)
}

function node(marks, children = []) {
  const all = (from) => from.flatMap((child) => [child, ...all(child.children)])
  const el = {
    parentElement: null,
    children,
    disabled: undefined,
    className: '',
    textContent: '',
    getAttribute: (given) => (given in marks ? marks[given] : null),
    querySelectorAll: (selector) => (selector === 'button,[role="button"]' ? all(children) : []),
  }
  for (const child of children) child.parentElement = el
  return el
}

test('the send button wins over an unmarked one, near or far', () => {
  const D = { body: {}, querySelectorAll: () => [] }
  const visible = () => true
  const sendControl = new Function('D', 'visible', guestFunction('sendControl') + '\nreturn sendControl')(D, visible)
  const plain = node({})
  const form = node({}, [plain, node({ 'aria-label': '发送' })])
  /* The lookup climbs four ancestors, so a real composer has a few above it. */
  let above = form
  for (let up = 0; up < 5; up += 1) above = node({}, [above])
  assert.equal(sendControl(plain).getAttribute('aria-label'), '发送')
  assert.equal(plain.parentElement, form)
  /* Outside the four ancestors a marked button is still found, because a bar
     above the composer is where the send control usually lives. */
  const loose = node({})
  const far = node({ title: 'Send message' })
  D.querySelectorAll = () => [far]
  assert.equal(sendControl(loose), far)
  /* Nothing marked means no press: the caller falls back to Enter. */
  D.querySelectorAll = () => [node({})]
  assert.equal(sendControl(loose), null)
  /* A disabled control is not a press either. */
  const off = node({ 'aria-label': 'Send' })
  off.disabled = true
  D.querySelectorAll = () => [off]
  assert.equal(sendControl(loose), null)
})

test('a file a page builds in memory is kept as it is built', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* Asking for the address again would build a different file, so the bytes
     are held from the moment the page makes them. */
  assert.match(source, /URL\.createObjectURL = \(object\) =>/)
  assert.match(source, /__dshib_blobs\.set\(url, object\)/)
  assert.match(source, /startsWith\('blob:'\)/)
  /* A plain link to an archive or a document is a transfer too. */
  assert.match(source, /zip\|rar\|7z\|tar\|gz\|xlsx\?\|docx\?/)
  /* What was queued is awaited before the chat is handed the list. */
  assert.match(source, /const file = await one/)
})

test('a call in flight is not reloaded out from under', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* The catch-up reload waits while a tool call owns the page. */
  const at = source.indexOf('if (acting.size > 0) return')
  assert.ok(at > 0)
  assert.ok(at < source.indexOf("if (tries >= 6 && Number.isFinite(last)"))
})

test('a window that could not get the file waits instead of trying forever', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* Past a few tries the page stops for ten minutes, and after a bounded count
     it stops for good. A fix published after that wait still reaches the page. */
  assert.match(source, /tries >= 6 && Number\.isFinite\(last\) && Date\.now\(\) - last < 600_000/)
  assert.match(source, /tries >= 12\) return/)
  assert.match(source, /sessionStorage\.setItem\('dshib\.last', String\(Date\.now\(\)\)\)/)
})

test('a window nobody is looking at still comes back on the published build', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /setInterval\(watchBuild, 6_000\)/)
  assert.doesNotMatch(source, /if \(!document\.hidden\) watchBuild\(\)/)
  assert.match(source, /'visibilitychange'/)
})

test('a catch-up reload leaves the app its own route name', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* 'interface' is the app's own selector — a page that writes it is asking
     the shell to switch interfaces. The reload only needs a new address. */
  assert.doesNotMatch(source, /searchParams\.set\('interface'/)
  assert.match(source, /searchParams\.delete\('interface'\)/)
  assert.match(source, /searchParams\.set\('dshib', build\)/)
})

test('a catch-up reload is decided by the build, not by a version string', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  /* A page that reloads once per build change settles after one try; a page
     that reloads whenever a version string differs never settles, because the
     app keeps serving its own copy until it is restarted. */
  assert.match(source, /const behind = held !== build && marked !== build/)
  assert.doesNotMatch(source, /version !== REV\) \|\|/)
  /* A page the app has just built is taken as current instead of reloaded. */
  assert.match(source, /if \(held === '' && marked === ''\)/)
})

test('a tab showing a checkpoint gets its page back, and nothing else is pressed', async () => {
  /** @type {string[]} */
  const pressed = []
  /** A button in the column, by the words it shows. */
  const button = (word) => ({ textContent: word, click: () => pressed.push(word) })
  const { opened, source } = scene()
  try {
    globalThis.__panels = [{
      dataset: { sidebarRightSession: 'chat-6' },
      getBoundingClientRect: () => ({ width: 575, height: 900 }),
      querySelector: () => null,
      querySelectorAll: (selector) => (String(selector).includes('button')
        ? [button('地址栏'), button('恢复页面')]
        : []),
    }]
    source.send({ type: 'wanted', session: 'chat-6', url: 'https://example.test/x' })
    await new Promise((resolve) => setTimeout(resolve, 700))
    /* The page is brought back, and the ask still names this chat's tab. */
    assert.deepEqual(pressed, ['恢复页面'])
    for (const one of opened) assert.equal(one[1], 'chat-6')
  } finally {
    globalThis.__panels = []
  }
})
