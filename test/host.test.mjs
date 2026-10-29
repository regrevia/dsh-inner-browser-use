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
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** @type {Array<{path: string, handler: any}>} */
const routes = []
/** @type {Map<string, any>} */
const defs = new Map()
/** @type {any[]} */
const prompts = []
let server
let origin

/* A fresh state directory: the mirror's note must never leak between runs. */
process.env.DSH_INNER_BROWSER_STATE_DIR = join(tmpdir(), `dshib-host-${process.pid}-${Date.now()}`)
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

test('a second mount of the same tools is a warning, not a crash', () => {
  const taken = new Set(defs.keys())
  const strict = {
    ...context(),
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'systemPrompt' ? { section() { return () => {} } } : undefined),
    inject(names, callback) {
      callback({
        effect: (effect) => effect(),
        tools: {
          register(definition) {
            if (taken.has(definition.name)) throw new Error('tool already registered')
            taken.add(definition.name)
            return () => {}
          },
        },
      })
    },
  }
  assert.doesNotThrow(() => apply(strict), 'the surface goes up even when every name is taken')
})

test('registers the sidecar tools and nothing else', () => {
  assert.deepEqual([...defs.keys()].sort(), [
    'browser_ask',
    'browser_check',
    'browser_click',
    'browser_clipboard',
    'browser_console',
    'browser_cookie',
    'browser_dialog',
    'browser_do',
    'browser_downloads',
    'browser_drag',
    'browser_eval',
    'browser_extract',
    'browser_failed',
    'browser_find',
    'browser_grab',
    'browser_hover',
    'browser_key',
    'browser_mode',
    'browser_nav',
    'browser_network',
    'browser_open',
    'browser_pdf',
    'browser_prepare',
    'browser_read',
    'browser_resume',
    'browser_review',
    'browser_review_verdict',
    'browser_scroll',
    'browser_select',
    'browser_shot',
    'browser_state',
    'browser_tabs',
    'browser_type',
    'browser_upload',
    'browser_view',
    'browser_wait',
  ])
  for (const [name, definition] of defs) {
    assert.ok(name.startsWith('browser_'), `${name} drives its own browser`)
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.deepEqual(definition.output.schema.required, ['text'])
    assert.deepEqual(definition.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }])
    /* Reading where the sidecar stands is safe anywhere; driving it is not. */
    assert.equal(definition.isConcurrencySafe(), ['browser_state', 'browser_resume', 'browser_console', 'browser_failed', 'browser_downloads', 'browser_network', 'browser_extract', 'browser_mode'].includes(name))
  }
})

test('the model is told to use the sidecar and the right column', () => {
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].name, 'browser-in-this-chat')
  assert.match(prompts[0].text, /browser_view/)
  assert.match(prompts[0].text, /右栏/)
  /* One name for one thing: the prompt never calls it a sidecar. */
  assert.doesNotMatch(prompts[0].text, /sidecar/)
  /* A browser is an expensive way to read a page: the prompt names the cheap
     path first and says plainly when not to open one. */
  assert.match(prompts[0].text, /web_fetch/)
  assert.match(prompts[0].text, /envoy/)
  assert.match(prompts[0].text, /不要用它/)
  /* A link is not a request: opening a browser is the person's call. */
  assert.match(prompts[0].text, /明确说/)
  assert.match(prompts[0].text, /GitHub/)
})

test('a chat with no tab receives nothing', () => {
  assert.equal(new Bridge().push('chat-1', { type: 'sidecar-wanted' }), false)
})

test('a mirror asked for while the chat was away arrives when it comes back', () => {
  const bridge = new Bridge()
  /** @param {string} tag - which stream. @returns {any} a response-shaped sink. */
  const sink = (tag) => ({ tag, ended: false, frames: [], end() { this.ended = true }, write(frame) { this.frames.push(frame) } })
  assert.equal(bridge.want('chat-1'), false, 'nobody is listening yet, so nothing is delivered')
  const late = sink('late')
  bridge.attach('chat-1', late)
  assert.equal(late.frames.length, 1)
  assert.match(String(late.frames[0]), /sidecar-wanted/, 'the tab opens without being asked again')
  assert.match(String(late.frames[0]), /chat-1/)

  const stale = new Bridge()
  stale.want('chat-2', Date.now() - 130_000)
  const seat = sink('stale')
  stale.attach('chat-2', seat)
  assert.equal(seat.frames.length, 0, 'a two-minute-old ask is spent')

  const other = new Bridge()
  other.want('chat-3')
  const elsewhere = sink('elsewhere')
  other.attach('chat-4', elsewhere)
  assert.equal(elsewhere.frames.length, 0, 'another chat never receives this one\'s mirror')
})

test('a tab closed on purpose is not reopened on return', () => {
  const bridge = new Bridge()
  bridge.want('chat-1')
  assert.equal(bridge.forget('chat-1'), true)
  const seat = { frames: [], end() {}, write(frame) { this.frames.push(frame) } }
  bridge.attach('chat-1', seat)
  assert.equal(seat.frames.length, 0, 'the ask was withdrawn with the tab')
  assert.equal(bridge.forget('chat-2'), false, 'another chat has nothing to forget')
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

test('Chrome\'s own error page is never read as the site', async () => {
  const { unreachable, isErrorPage } = await import('../tools.js')
  const dead = { url: 'chrome-error://chromewebdata/', title: 'never-resolves-this.invalid', cdp: { send: async () => ({ result: { value: '' } }) } }
  assert.equal(isErrorPage(dead), true, 'the address alone is enough to know')
  const said = await unreachable(dead)
  assert.match(said, /the network could not reach that address/)
  assert.match(said, /never-resolves-this.invalid/, 'the address that failed is named')
  assert.match(said, /not the site/, 'a model must not quote it as content')
  assert.match(said, /browser_nav/, 'the sentence carries the way out')
  // A real page costs one comparison and says nothing.
  assert.equal(isErrorPage({ url: 'https://example.com/' }), false)
  assert.equal(await unreachable({ url: 'https://example.com/' }), '')
  // Edge writes its own scheme; a page that merely mentions one is not it.
  assert.equal(isErrorPage({ url: 'edge-error://edgewebdata/' }), true)
  assert.equal(isErrorPage({ url: 'https://example.com/chrome-error://x' }), false)
  assert.equal(isErrorPage({}), false)
})

test('a site\'s own check page is named as one, with the way past it', async () => {
  const { isCheckPage } = await import('../tools.js')
  // The words a site shows while it asks the browser to prove a person is there.
  assert.equal(isCheckPage({ url: 'https://chatgpt.com/', title: '请稍候…' }), true)
  assert.equal(isCheckPage({ url: 'https://x.test/', title: 'Just a moment...' }), true)
  assert.equal(isCheckPage({ url: 'https://x.test/', title: 'Checking your browser' }), true)
  assert.equal(isCheckPage({ url: 'https://x.test/', title: 'Verifying you are human' }), true)
  // The challenge token in the address counts even before the title arrives.
  assert.equal(isCheckPage({ url: 'https://chatgpt.com/?__cf_chl_rt_tk=abc', title: '' }), true)
  // A real page says nothing, and neither does nothing at all.
  assert.equal(isCheckPage({ url: 'https://example.com/', title: 'Example Domain' }), false)
  assert.equal(isCheckPage({ url: 'https://x.test/slow', title: 'Loading…' }), false)
  assert.equal(isCheckPage({}), false)
})

test('the error page reports its own failure code, not the site title', async () => {
  const { unreachable } = await import('../tools.js')
  let asked = ''
  const page = {
    url: 'chrome-error://chromewebdata/',
    title: 'example.invalid',
    cdp: { send: async (_method, params) => { asked = params.expression; return { result: { value: 'ERR_NAME_NOT_RESOLVED' } } } },
  }
  const said = await unreachable(page)
  assert.match(asked, /ERR_\[A-Z0-9_\]\+/, 'the page is asked for the code')
  assert.match(said, /ERR_NAME_NOT_RESOLVED/, 'a typo and a dead proxy are told apart')
})

test('a batch step says it cleared the way, in one clause', async () => {
  const { coverLead } = await import('../tools.js')
  const cover = { tag: 'div', text: 'We use cookies', dismiss: { x: 10, y: 20, name: 'Accept' } }
  const clear = { tag: 'div', text: 'One', dismiss: null }
  const seen = []
  const page = { cdp: { send: async () => ({ result: { value: JSON.stringify(cover) } }) }, mouse: async (kind) => { seen.push(kind) } }
  // Two probes are made: the banner at first, then nothing, because the click on
  // its way out took it away.
  let probe = 0
  page.cdp.send = async () => ({ result: { value: JSON.stringify(probe++ === 0 ? cover : clear) } })
  const lead = await coverLead(page, 3)
  assert.equal(lead, 'after Accept on a banner, ')
  assert.ok(seen.includes('mousePressed'), 'the way out is a real click')
  // A page with nothing on top costs one probe and says nothing.
  const plain = { cdp: { send: async () => ({ result: { value: '' } }) }, mouse: async () => { throw new Error('nothing to click') } }
  assert.equal(await coverLead(plain, 3), '')
  // The page refusing to say where the way out is never blocks the step.
  const stuck = { cdp: { send: async () => ({ result: { value: JSON.stringify({ tag: 'div', text: 'Pay now', dismiss: null }) } }) }, mouse: async () => { throw new Error('nothing to click') } }
  assert.equal(await coverLead(stuck, 3), '')
})

test('the covering check also finds the way out of the overlay', async () => {
  const { covering } = await import('../read.js')
  const said = covering(12)
  assert.match(said, /dismiss/)
  // The words that count as a way out are a closed list, so an overlay that
  // offers to delete or pay can never be accepted on the person's behalf.
  assert.match(said, /\^\(accept\|/)
  assert.match(said, /risky/)
})

test('an identity is the name and the kind, so a redraw does not lose the control', async () => {
  const { identityOf, sameThing } = await import('../read.js')
  const was = identityOf({ kind: 'button', name: 'Keep going', href: '' })
  assert.deepEqual(was, { kind: 'button', name: 'Keep going', href: '', inert: false })
  /* The same words on a new element is the same control. */
  assert.equal(sameThing(was, { kind: 'button', name: 'Keep going', href: '' }), true)
  /* A different control that happens to sit in the same place is not. */
  assert.equal(sameThing(was, { kind: 'button', name: 'Discard draft', href: '' }), false)
  /* Nor is a container that now holds the words of the button. */
  assert.equal(sameThing(was, { kind: 'section', name: 'Keep going', href: '' }), false)
})

test('a field never passes for the button beside it', async () => {
  const { identityOf, sameThing } = await import('../read.js')
  const field = identityOf({ kind: 'input', name: 'Search', href: '' })
  assert.equal(field.inert, true)
  assert.equal(sameThing(field, { kind: 'input', name: 'Search', href: '' }), true)
  assert.equal(sameThing(field, { kind: 'button', name: 'Search', href: '' }), false)
  /* A link keeps its destination: the same words pointing elsewhere is a
     different thing to click. */
  const link = identityOf({ kind: 'link', name: 'Docs', href: 'https://example.com/a' })
  assert.equal(sameThing(link, { kind: 'link', name: 'Docs', href: 'https://example.com/a' }), true)
  assert.equal(sameThing(link, { kind: 'link', name: 'Docs', href: 'https://example.com/b' }), false)
  /* Nothing to look for is not a licence to click whatever is nearest. */
  assert.equal(sameThing(identityOf({ kind: 'button', name: '', href: '' }), { kind: 'button', name: '', href: '' }), false)
})

test('a browser nobody is drawing says so, and a drawn one says nothing', async () => {
  const { viewerNote, NO_VIEWER } = await import('../tools.js')
  assert.equal(viewerNote(0), NO_VIEWER, 'no tab drawing the mirror is a thing to say')
  assert.match(NO_VIEWER, /refresh/, 'the line has to carry the action that fixes it')
  assert.equal(viewerNote(1), '', 'a tab is watching, so there is nothing to explain')
  assert.equal(viewerNote(3), '')
})

test('a field with its words in a div above it can still be found', async () => {
  const { labelSpot } = await import('../read.js?v=1')
  const expr = labelSpot('Work email')
  assert.equal(typeof expr, 'string')
  assert.match(expr, /scrollIntoView/)
  assert.match(expr, /input,textarea,select/)
  /* The words are data, never code: a quote in them must not break the probe. */
  assert.ok(labelSpot('say "hi"').includes('say \\"hi\\"'))
})

test('the typing tool can be told which field by its words', async () => {
  const { sidecarTools } = await import('../tools.js?v=1')
  const tools = sidecarTools({ state: () => ({}) }, { last: undefined })
  const type = tools.find((tool) => tool.name === 'browser_type')
  assert.ok(type !== undefined)
  assert.ok(type.parameters.properties.field !== undefined)
  assert.ok(type.parameters.properties.ref !== undefined)
  assert.deepEqual(type.parameters.required, ['text'])
})

test('a dropdown can be chosen by the words that name it', async () => {
  const { selectSpot } = await import('../read.js?v=1')
  const expr = selectSpot('Seats', 'Two')
  assert.equal(typeof expr, 'string')
  assert.match(expr, /bestOf\('select'/)
  assert.match(expr, /chose /)
  /* Both the name and the option are data, never code. */
  assert.ok(selectSpot("say \"hi\"", "it's").includes('say \\"hi\\"'))
  const { sidecarTools } = await import('../tools.js?v=1')
  const select = sidecarTools({ state: () => ({}) }, { last: undefined }).find((tool) => tool.name === 'browser_select')
  assert.ok(select.parameters.properties.field !== undefined)
  assert.deepEqual(select.parameters.required, ['value'])
})

test('words split across inline nodes still name the same control', () => {
  /* readPage reports "Signin" for <span>Sign</span><span>in</span>; the
     caller writes "Sign in". The comparison must ignore the difference. */
  const squeeze = (text) => String(text).toLowerCase().replace(/\s+/g, '')
  assert.equal(squeeze('Signin'), squeeze('Sign in'))
  assert.equal(squeeze('  Beta   sent '), squeeze('beta sent'))
  assert.notEqual(squeeze('Sign in'), squeeze('Sign up'))
})

test('the words can name a field that is hidden behind its box', async () => {
  const { labelSpot } = await import('../read.js?v=1')
  const expr = labelSpot('Birthday')
  assert.match(expr, /boxOf/)
  /* A picker that keeps its real input out of sight is still findable. */
  assert.match(expr, /hiddenOk/)
  assert.match(expr, /behind/)
})

test('a drawing surface can be pictured on its own', async () => {
  const { bounds } = await import('../read.js?v=1')
  const expr = bounds(7)
  assert.match(expr, /getBoundingClientRect/)
  assert.match(expr, /scrollIntoView/)
  assert.match(expr, /width: b\.width/)
})

test('the picture itself can be taken off the page', async () => {
  const { pictures } = await import('../read.js?v=1')
  const expr = pictures(4, 2)
  assert.match(expr, /readAsDataURL/)
  assert.match(expr, /credentials: 'include'/)
  assert.match(expr, /reg.find\(4\)/)
  /* A drawing surface has no file behind it: its pixels come from itself. */
  assert.match(expr, /toDataURL/)
  assert.match(expr, /slice\(0, 2\)/)
  /* A picture nobody can open still has to be described: sample it small. */
  assert.match(expr, /willReadFrequently/)
  assert.match(expr, /colors: feel\?\.colors/)
})

test('a read says when the answer is a picture', async () => {
  const { renderPage } = await import('../read.js?v=1')
  const said = renderPage({ url: 'https://example.test/pic', title: '', text: '', textChars: 0, controls: [], picture: { kind: 'img', width: 140, height: 90, name: 'Chart', colors: 40, flat: 0.1 } }, { mode: 'text' })
  assert.match(said, /picture 140x90 a picture with detail "Chart"/)
  assert.match(said, /browser_grab saves it as a file/)
  /* A page with words does not get the line: it is not the answer there. */
  const words = renderPage({ url: 'https://example.test', title: 'Home', text: 'some words', textChars: 10, controls: [], picture: null }, { mode: 'text' })
  assert.doesNotMatch(words, /picture /)
  const blank = renderPage({ url: 'https://example.test/pic', title: '', text: '', textChars: 0, controls: [], picture: { kind: 'img', width: 800, height: 600, name: '', colors: 1, flat: 1 } }, { mode: 'text' })
  assert.match(blank, /mostly one colour/)
})

test('typing asks the box for one paste, and the keys in order only where they are needed', async () => {
  const { typeInto } = await import('../tools.js?v=1')
  const log = []
  const box = { quickType: async (text) => { log.push(`paste:${text}`); return true }, humanType: async (text) => { log.push(`keys:${text}`) }, insertText: async () => undefined }
  await typeInto(box, 'hello', 'Note')
  assert.deepEqual(log, ['paste:hello'])
  /* A box that reacts as you type gets the keys, so its list really appears. */
  log.length = 0
  await typeInto(box, 'shoes', 'Site search')
  assert.deepEqual(log, ['keys:shoes'])
  /* When the paste does not take, the keys are the fallback. */
  log.length = 0
  box.quickType = async (text) => { log.push(`paste:${text}`); return false }
  await typeInto(box, 'hello', 'Note')
  assert.deepEqual(log, ['paste:hello', 'keys:hello'])
  assert.deepEqual(log.filter((line) => line.startsWith('keys')), ['keys:hello'])
})

test('a page that repeats a word down a list costs one line, not thirty', async () => {
  const { renderPage } = await import('../read.js?v=1')
  const controls = Array.from({ length: 30 }, (_, i) => ({ ref: i + 1, kind: 'button', name: 'Add to cart', value: '', view: true }))
  const read = { url: 'https://example.test/list', title: 'List', text: controls.map(() => 'Add to cart').join(' '), textChars: 360, controls }
  const said = renderPage(read, { mode: 'text' })
  assert.match(said, /1 \[btn\] Add to cart ×30/)
  assert.equal(said.split('\n').filter((line) => line.includes('Add to cart')).length, 1)
  /* Asking for links or forms is asking for every one of them. */
  const everyOne = renderPage(read, { mode: 'full' })
  assert.equal(everyOne.split('\n').filter((line) => /^\d+ \[btn\] Add to cart/.test(line)).length, 30)
})

test('words that are only the controls again are not printed twice', async () => {
  const { renderPage } = await import('../read.js?v=1')
  const controls = [{ ref: 1, kind: 'link', name: 'Product 0', value: '', view: true }, { ref: 2, kind: 'button', name: 'Add to cart', value: '', view: true }]
  const words = 'Product 0 Add to cart '.repeat(12)
  const listing = renderPage({ url: 'https://example.test/list', title: 'List', text: words, textChars: words.length, controls }, { mode: 'text' })
  assert.doesNotMatch(listing, /Product 0 Add to cart /)
  assert.match(listing, /the words here are the 2 controls above/)
  /* An article's prose is the answer: it stays. */
  const prose = 'The bridge opens in spring. '.repeat(20)
  const article = renderPage({ url: 'https://example.test/news', title: 'News', text: prose, textChars: prose.length, controls }, { mode: 'text' })
  assert.match(article, /The bridge opens in spring/)
})

test('a picture that never arrived is named', async () => {
  const { renderPage } = await import('../read.js?v=1')
  const said = renderPage({ url: 'https://example.test/pic', title: '', text: '', textChars: 0, controls: [], picture: { missing: [{ width: 320, height: 240, name: 'Chart' }] } }, { mode: 'text' })
  assert.match(said, /picture 320x240 "Chart" did not load/)
  const nameless = renderPage({ url: 'https://example.test/pic', title: '', text: '', textChars: 0, controls: [], picture: { missing: [{ width: 320, height: 240, name: '' }] } }, { mode: 'text' })
  assert.match(nameless, /picture 320x240 did not load/)
})

test('a second read of the same page is one line', async () => {
  const { sameRead } = await import('../tools.js?v=1')
  const one = { url: 'https://example.test', title: 'Home', text: 'alpha', controls: [{ ref: 1, kind: 'button', name: 'Go' }], focused: null }
  assert.equal(sameRead(one, { ...one, controls: [{ ref: 1, kind: 'button', name: 'Go' }] }), true)
  assert.equal(sameRead(one, { ...one, text: 'beta' }), false)
  assert.equal(sameRead(one, { ...one, url: 'https://example.test/next' }), false)
  assert.equal(sameRead(one, { ...one, controls: [{ ref: 2, kind: 'button', name: 'Go' }] }), false)
  assert.equal(sameRead(undefined, one), false)
})

test('there is a tool that asks a chat in the page and brings the answer back', async () => {
  const { sidecarTools } = await import('../tools.js?v=1')
  const ask = sidecarTools({ alive: false }, { refs: [], at: 0 }).find((tool) => tool.name === 'browser_ask')
  assert.ok(ask, 'browser_ask is registered')
  assert.match(ask.description, /read its answer back in the same call/)
  assert.deepEqual(Object.keys(ask.parameters.properties), ['text', 'ref', 'submit', 'timeout_ms'])
  assert.deepEqual(ask.parameters.required, ['text'])
})

test('a review round says what it asked, and keeps the list it got back', async () => {
  const { brief, points, recordRound, lastRound, lastRoundNote, lastPoints } = await import('../review.js?v=1')
  const asked = brief({ repo: 'https://github.com/o/r', commit: 'abc123def456', focus: 'token cost' })
  assert.match(asked, /https:\/\/github\.com\/o\/r/)
  assert.match(asked, /commit abc123def456/)
  assert.match(asked, /Focus on: token cost/)
  assert.match(asked, /Answer with a short list/)
  assert.doesNotMatch(asked, /The change under review/)

  const carried = brief({ repo: 'https://github.com/o/r', focus: 'x'.repeat(400), diff: '--- a/read.js\n+++ b/read.js\n+const cap = 60' })
  assert.match(carried, /The change under review, inline \(a diff\):/)
  assert.match(carried, /\+const cap = 60/)
  assert.match(brief({ diff: 'y'.repeat(6000) }), /\(trimmed\)/)

  const answer = 'Here is what I would change.\n- read.js: cut the picture line at 60 characters (cheap)\n2. tools.js: reuse the last read even when the mode changes\nnot a point'
  assert.deepEqual(points(answer), ['read.js: cut the picture line at 60 characters (cheap)', 'tools.js: reuse the last read even when the mode changes'])

  const dir = join(tmpdir(), `dsh-rounds-${process.pid}`)
  rmSync(dir, { recursive: true, force: true })
  const { file, round } = recordRound({ dir, commit: 'abc123def456', question: asked, answer, tookMs: 1250 })
  assert.equal(round.points.length, 2)
  assert.equal(round.tookMs, 1250)
  assert.match(readFileSync(file, 'utf8'), /abc123def456/)
  assert.equal(lastRound({ dir }).commit, 'abc123def456')
  assert.match(lastRoundNote({ dir, commit: 'abc123def456' }), /about this commit/)
  assert.match(lastRoundNote({ dir, commit: 'ffff999' }), /the code has moved since/)
  assert.equal(lastPoints({ dir }).length, 2)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(lastRound({ dir }), null)
})

test('the chat that owns the mirror keeps it across a reload', async () => {
  const { writeFileSync } = await import('node:fs')
  const dir = process.env.DSH_INNER_BROWSER_STATE_DIR
  const first = new Bridge({ persist: true })
  first.want('session-keep')
  const again = new Bridge({ persist: true })
  assert.equal(again.owner, 'session-keep', 'a reloaded host hands the mirror back to the same chat')
  /* A note left by anything that is not a chat must not take the mirror. */
  writeFileSync(join(dir, 'mirror.json'), JSON.stringify({ owner: 'chat-1', session: 'chat-1', at: 1 }))
  assert.equal(new Bridge({ persist: true }).owner, '', 'a stray note is ignored')
})

test('every acting route refuses a chat that does not hold the mirror', async () => {
  const claimed = await call('/sidecar/claim', { method: 'POST', body: JSON.stringify({ session: 'session-holder' }) })
  assert.equal(claimed.status, 200)
  for (const path of ['/sidecar/input', '/sidecar/nav']) {
    const refused = await call(path, {
      method: 'POST',
      body: JSON.stringify({ session: 'session-rival', kind: 'text', text: 'x', op: 'reload' }),
    })
    assert.equal(refused.status, 403, `${path} must answer the holder's chat only`)
    assert.equal((await refused.json()).text, 'this chat does not own the browser')
  }
  const picture = await call('/sidecar/frames?session=session-rival')
  assert.equal(picture.status, 403, 'a rival tab cannot stream the picture either')
  assert.equal((await picture.json()).owner, 'session-holder')
})

test('one chat never sees another chat in the call log', async () => {
  await call('/sidecar/state?session=chat-alpha').then((response) => response.json())
  const mine = await call('/sidecar/state?session=chat-beta').then((response) => response.json())
  const mineAgain = await call('/sidecar/state?session=chat-alpha').then((response) => response.json())
  const alpha = 'chat-alpha'.slice(-8)
  const beta = 'chat-beta'.slice(-8)
  assert.equal(alpha, 'at-alpha')
  assert.equal(mine.recent.some((entry) => entry.session === alpha), false, 'beta sees no alpha call')
  assert.equal(mine.recent.some((entry) => entry.session === beta), true, 'beta sees its own call')
  assert.equal(mineAgain.recent.some((entry) => entry.session === alpha), true, 'alpha sees its own call')
  assert.equal(mineAgain.recent.some((entry) => entry.session === beta), false, 'alpha sees no beta call')
})

test('a write that cannot name its chat is refused before it touches anything', async () => {
  for (const path of ['/sidecar/input', '/sidecar/nav', '/sidecar/forget']) {
    const refused = await call(path, { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'x', op: 'reload' }) })
    assert.equal(refused.status, 400, `${path} must ask which chat it is for`)
    assert.equal((await refused.json()).text, 'which chat asked for it')
  }
})

test('a chat that does not hold the mirror cannot close it or forget its ask', async () => {
  /* The holder from the earlier route test still owns the mirror. */
  const closed = await call('/sidecar/stop', { method: 'POST', body: JSON.stringify({ session: 'session-intruder' }) })
  assert.equal(closed.status, 403, 'closing the browser is the holder\'s call')
  const forgot = await call('/sidecar/forget', { method: 'POST', body: JSON.stringify({ session: 'session-intruder' }) })
  assert.equal(forgot.status, 403, 'withdrawing an ask is the holder\'s call too')
  const kept = await call('/sidecar/forget', { method: 'POST', body: JSON.stringify({ session: 'session-holder' }) })
  assert.equal(kept.status, 200)
  assert.equal((await kept.json()).ok, true)
})

test('only the owning chat picks a browser up on a state poll', async () => {
  const { shouldAdoptOnState } = await import('../index.js')
  assert.equal(shouldAdoptOnState({ alive: false }, 'session-a', 'session-a'), true)
  assert.equal(shouldAdoptOnState({ alive: false }, 'session-b', 'session-a'), false)
  assert.equal(shouldAdoptOnState({ alive: false }, 'session-a', ''), false)
  assert.equal(shouldAdoptOnState({ alive: true }, 'session-a', 'session-a'), false)
  assert.equal(shouldAdoptOnState({ alive: false }, '', 'session-a'), false)
})

test('a running browser that nobody is drawing asks its own chat to draw it again', async () => {
  const { wantsMirrorAgain } = await import('../index.js')
  const base = { alive: true, owner: 'session-a', wanted: 'session-a', listeners: 0 }
  assert.equal(wantsMirrorAgain(base), true, 'these are the facts of an empty column')
  /* A stream already open is a drawn picture: asking again would only churn. */
  assert.equal(wantsMirrorAgain({ ...base, listeners: 1 }), false)
  /* A stopped browser has nothing to show, and a chat that never asked has no
     column to repair. */
  assert.equal(wantsMirrorAgain({ ...base, alive: false }), false)
  assert.equal(wantsMirrorAgain({ ...base, wanted: '' }), false)
  assert.equal(wantsMirrorAgain({ ...base, wanted: 'session-b' }), false)
  assert.equal(wantsMirrorAgain({ ...base, owner: '' }), false)
  /* Owners and asks are session ids, never a truthy stand-in. */
  assert.equal(wantsMirrorAgain({ ...base, wanted: 'session-ab' }), false)
})

test('a chat that is already polling is not asked again, a quiet one is', async () => {
  const { nudgeDue } = await import('../index.js')
  /* The pane polls every 2.5 s: it is awake and knows the frames are missing. */
  assert.equal(nudgeDue({ askedAgo: 2_500, sinceLast: 60_000 }), false)
  /* No poll for a while: this pane may have lost the stream, one ask is due. */
  assert.equal(nudgeDue({ askedAgo: 20_000, sinceLast: 60_000 }), true)
  /* Asked a moment ago: give the client time to open the stream before asking. */
  assert.equal(nudgeDue({ askedAgo: 20_000, sinceLast: 2_000 }), false)
  /* A chat that never polled has no column to repair. */
  assert.equal(nudgeDue({ askedAgo: -1, sinceLast: 60_000 }), false)
  assert.equal(nudgeDue({}), false)
})

test('picking a surviving browser up names the chat, so that chat gets its own tab back', async () => {
  const { adoptOptions, needsTab } = await import('../index.js')
  assert.deepEqual(adoptOptions('session-1', 'https://example.com/a'), { session: 'session-1', url: 'https://example.com/a' })
  /* No remembered address still names the chat: the pane needs a tab, not a
     browser with nothing in it. */
  assert.deepEqual(adoptOptions('session-1', ''), { session: 'session-1' })
  assert.deepEqual(adoptOptions('session-1', undefined), { session: 'session-1' })
})

test('a running browser with no tab for this chat is a poll that reopens one', async () => {
  const { needsTab } = await import('../index.js')
  /* The browser is fine; this chat's tab is what went missing at a reload. */
  assert.equal(needsTab({ alive: false }, 'session-a', 'session-a'), true)
  assert.equal(needsTab({ alive: true }, 'session-a', 'session-a'), false)
  /* Another chat's column and an unnamed poll are not this chat's to repair. */
  assert.equal(needsTab({ alive: false }, 'session-a', 'session-b'), false)
  assert.equal(needsTab({ alive: false }, '', 'session-a'), false)
})

test('a mirror ask never leaks to a different chat, however similar the ids look', () => {
  /* The column is global and the ids are long: an alias guessed by "which chat
     polled last" once put the mirror in a stranger's sidebar. Asking is the only
     way to receive it, and the ask is compared as one exact string. */
  const bridge = new Bridge()
  /** @param {string} tag - which stream. @returns {any} a response-shaped sink. */
  const sink = (tag) => ({ tag, frames: [], end() {}, write(frame) { this.frames.push(frame) } })
  const mine = sink('mine')
  const stranger = sink('stranger')
  bridge.attach('session-aaaa-1111', mine)
  bridge.attach('session-aaaa-2222', stranger)
  assert.equal(bridge.want('session-aaaa-1111'), true)
  assert.equal(mine.frames.length, 1)
  assert.equal(stranger.frames.length, 0, 'a neighbour chat is not handed the picture')
  assert.equal(bridge.canon('session-aaaa-1111'), 'session-aaaa-1111', 'an id is itself')
  assert.equal(bridge.canon(''), '')
  assert.equal(bridge.canon(undefined), '')
  /* A second chat asking takes the mirror over: the first one's tab goes back to
     its note, and only the newcomer is drawn. */
  assert.equal(bridge.want('session-aaaa-2222'), true)
  assert.equal(bridge.owner, 'session-aaaa-2222')
  assert.equal(mine.frames.length, 1, 'the old owner is not sent the new owner\'s picture')
  assert.equal(stranger.frames.length, 1)
  /* Nothing is inferred from a seat alone: a chat that never asked is not owed
     a mirror because it is the only one listening. */
  const quiet = sink('quiet')
  bridge.attach('session-bbbb-3333', quiet)
  assert.equal(quiet.frames.length, 0)
})
