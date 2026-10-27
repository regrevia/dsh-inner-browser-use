/**
 * Host-half tests: the mirror wire, the tool surface, and the promise that the
 * built-in browser's routes are gone for good.
 *
 * The transport is the part that cannot be trusted by reading it, so every case
 * here speaks HTTP to the route the plugin registers. Nothing in this file
 * starts Chrome: the cases that would are the ones that prove a bad frame is
 * refused before the browser is touched.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

/** @type {Array<{path: string, handler: any}>} */
const routes = []
/** @type {Map<string, any>} */
const defs = new Map()
/** @type {any[]} */
const prompts = []
let server
let origin

const { Bridge, ROUTE, apply } = await import('../index.js')

/**
 * A plugin context with only what the plugin touches.
 * @returns {any} context.
 */
function context() {
  const disposable = () => {}
  return {
    effect(effect) {
      const stop = effect()
      return typeof stop === 'function' ? stop : disposable
    },
    inject(names, callback) {
      callback({
        effect: (effect) => effect(),
        tools: {
          register(definition) {
            defs.set(definition.name, definition)
            return disposable
          },
        },
      })
    },
    webServer: {
      register(route) {
        routes.push(route)
        return disposable
      },
    },
    get: (name) => (name === 'systemPrompt'
      ? {
        section(config) {
          prompts.push(config)
          return disposable
        },
      }
      : undefined),
    logger: { info() {} },
  }
}

/** @param {string} path - path under the plugin route. @param {RequestInit} [init] - request. */
const call = (path, init) => fetch(`${origin}${ROUTE}${path}`, init)

/** @param {string} session - chat the tab belongs to. @returns {Promise<any>} the tab's first frame. */
async function hello(session) {
  const controller = new AbortController()
  const response = await fetch(`${origin}${ROUTE}/downlink?session=${encodeURIComponent(session)}`, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (let waited = 0; waited < 3_000; waited += 10) {
    const { value } = await reader.read()
    buffer += decoder.decode(value, { stream: true })
    /* Every SSE block has to leave the buffer once it is read, or the retry
       hint would be parsed over and over and the real frame never reached. */
    for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      const line = block.split('\n').find((row) => row.startsWith('data: '))
      if (line === undefined) continue
      controller.abort()
      void reader.cancel().catch(() => {})
      return JSON.parse(line.slice(6))
    }
  }
  controller.abort()
  throw new Error('the tab heard nothing')
}

before(async () => {
  apply(context(), {})
  assert.equal(routes.length, 1)
  server = createServer((req, res) => {
    for (const route of routes) {
      if ((req.url ?? '').startsWith(route.path)) {
        void route.handler(req, res)
        return
      }
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

test('registers the sidecar tools and nothing else', () => {
  assert.deepEqual([...defs.keys()].sort(), [
    'sidecar_check',
    'sidecar_click',
    'sidecar_clipboard',
    'sidecar_console',
    'sidecar_cookie',
    'sidecar_dialog',
    'sidecar_do',
    'sidecar_downloads',
    'sidecar_drag',
    'sidecar_eval',
    'sidecar_extract',
    'sidecar_failed',
    'sidecar_hover',
    'sidecar_key',
    'sidecar_nav',
    'sidecar_network',
    'sidecar_open',
    'sidecar_pdf',
    'sidecar_scroll',
    'sidecar_select',
    'sidecar_shot',
    'sidecar_state',
    'sidecar_tabs',
    'sidecar_type',
    'sidecar_upload',
    'sidecar_view',
    'sidecar_wait',
  ])
  for (const [name, definition] of defs) {
    assert.ok(name.startsWith('sidecar_'), `${name} drives its own browser`)
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.schema.required, ['text'])
    assert.deepEqual(definition.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }])
    /* Reading where the sidecar stands is safe anywhere; driving it is not. */
    assert.equal(definition.isConcurrencySafe(), ['sidecar_state', 'sidecar_console', 'sidecar_failed', 'sidecar_downloads', 'sidecar_network', 'sidecar_extract'].includes(name))
  }
})

test('the model is told to use the sidecar and the right column', () => {
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].name, 'browser-in-this-chat')
  assert.match(prompts[0].text, /sidecar_view/)
  assert.match(prompts[0].text, /右栏/)
  assert.doesNotMatch(prompts[0].text, /browser_click/)
})

test('a chat with no tab receives nothing', () => {
  assert.equal(new Bridge().push('chat-1', { type: 'sidecar-wanted' }), false)
})

test('a second stream for one chat replaces the first', () => {
  const bridge = new Bridge()
  /** @param {string} tag - which stream. @returns {any} a response-shaped sink. */
  const sink = (tag) => ({ tag, ended: false, frames: [], end() { this.ended = true }, write(frame) { this.frames.push(frame) } })
  const first = sink('first')
  const second = sink('second')
  bridge.attach('chat-1', first)
  bridge.attach('chat-1', second)
  assert.equal(first.ended, true, 'the old stream is closed, not left half-open')
  assert.deepEqual(bridge.connected(), ['chat-1'])
  bridge.push('chat-1', { type: 'sidecar-wanted', session: 'chat-1' })
  assert.equal(second.frames.length, 1)
  bridge.detach('chat-1', first)
  assert.deepEqual(bridge.connected(), ['chat-1'], 'a stream already replaced cannot remove its successor')
  bridge.detach('chat-1', second)
  assert.deepEqual(bridge.connected(), [])
})

test('a tab hears its own chat named back', async () => {
  const frame = await hello('chat-9')
  assert.equal(frame.type, 'hello')
  assert.equal(frame.session, 'chat-9')
})

test('the built-in browser routes are gone', async () => {
  for (const path of ['/watch', '/cookies', '/state', '/grab', '/land', '/uplink', '/want', '/push', '/page-reload']) {
    const response = await call(path)
    assert.equal(response.status, 404, `${path} must not answer any more`)
    assert.equal((await response.json()).text, 'no such route')
  }
})

test('a malformed frame is refused before the browser is touched', async () => {
  for (const path of ['/sidecar/input', '/sidecar/nav']) {
    const response = await call(path, { method: 'POST', body: 'not json' })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).text, 'bad frame')
  }
})

test('a state read on a stopped sidecar says so without starting one', async () => {
  const state = await call('/sidecar/state').then((response) => response.json())
  assert.equal(state.alive, false)
  assert.equal(state.profile, 'default')
  assert.equal(state.url, '')
})

test('the mirror belongs to one chat until another one asks', () => {
  const bridge = new Bridge()
  assert.equal(bridge.owner, '', 'no chat owns it before anyone asks')
  bridge.claim('chat-a')
  assert.equal(bridge.owner, 'chat-a')
  bridge.claim('chat-b')
  assert.equal(bridge.owner, 'chat-b', 'a later ask takes the mirror, it is never shared')
  bridge.claim('')
  assert.equal(bridge.owner, 'chat-b', 'an ask with no chat takes nothing')
})

test('a state read reports which chat owns the mirror', async () => {
  const state = await call('/sidecar/state').then((response) => response.json())
  assert.equal(state.owner, '')
})

test('an ask that cannot name its chat is refused before a browser starts', async () => {
  const response = await call('/sidecar/open', { method: 'POST', body: JSON.stringify({ url: 'https://example.com' }) })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).text, 'which chat asked for it')
})

test('stopping a browser that never started is a no-op', async () => {
  const response = await call('/sidecar/stop', { method: 'POST' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})

test('clearing a field presses the select-all this machine really has', async () => {
  const { clearFocus } = await import('../tools.js')
  /** @type {any[]} */
  const keys = []
  const page = { key: async (type, key) => { keys.push({ type, ...key }) }, cdp: { send: async () => ({ result: { value: false } }) } }
  await clearFocus(page)
  assert.equal(keys[0].key, 'a', 'select-all comes first')
  assert.equal(keys[0].modifiers, process.platform === 'darwin' ? 4 : 2, 'Command on macOS, Control elsewhere')
  assert.deepEqual(keys.map((k) => k.key), ['a', 'a', 'Backspace', 'Backspace'], 'select-all, then one delete')
})

test('a page that swallowed select-all still loses its text', async () => {
  const { clearFocus } = await import('../tools.js')
  let asked = ''
  const page = { key: async () => {}, cdp: { send: async (_method, params) => { asked = params.expression; return { result: { value: true } } } } }
  await clearFocus(page)
  assert.match(asked, /field\.select\(\)/, 'the remaining text is selected in the page')
})

test('a person who acted first is reported to the agent once', async () => {
  const { personNote } = await import('../tools.js')
  const sidecar = { person: { at: Date.now() - 4000, kind: 'click', x: 412.4, y: 180.6, seen: false } }
  assert.match(personNote(sidecar), /the person also used the page: click at 412,181, 4 s ago/)
  assert.equal(personNote(sidecar), '', 'said once, not on every later call')
})

test('looking around in the mirror is not taking over', async () => {
  const { personNote } = await import('../tools.js')
  assert.equal(personNote({ person: { at: 0, kind: '', x: 0, y: 0, seen: true } }), '')
})

test('extraction with no selector says what it needs', async () => {
  const { extractRows } = await import('../tools.js')
  assert.match(await extractRows({}, {}), /Give a selector/)
  assert.match(await extractRows({}, { select: '  ' }), /Give a selector/)
})

test('the covering check asks the page what is on top', async () => {
  const { covering } = await import('../read.js')
  const said = covering(12)
  assert.match(said, /elementFromPoint/)
  assert.match(said, /find\(12\)/)
})
