/**
 * Host-half tests: the bridge wire and the tool surface, over a real socket.
 *
 * The transport is the part that cannot be trusted by reading it, so every case
 * here speaks HTTP to the route the plugin registers. There is no fake of the
 * Client: an SSE reader plays the tab, which is exactly what the tab does.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const proofDir = await mkdtemp(join(tmpdir(), 'dsh-ib-test-'))
process.env.DSH_INNER_BROWSER_PROOF = join(proofDir, 'proof.jsonl')

const { Bridge, ROUTE, apply, clientState } = await import('../index.js')

/** @type {Array<{path: string, handler: any}>} */
const routes = []
/** @type {Map<string, any>} */
const defs = new Map()
let server
let origin

/** A chat's folder, as the Host knows it. */
const HOST_FOLDER = '/Users/somebody/project'

/** What the Host answers when a chat's tab never named its folder. */
const services = {
  sessions: { get: (id) => (id === '' ? undefined : { id }) },
  workingDirectory: { get: () => HOST_FOLDER },
}

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
    get: (name) => services[name],
    logger: { info() {} },
  }
}

/** @param {string} path - path under the plugin route. @param {RequestInit} [init] - request. */
const call = (path, init) => fetch(`${origin}${ROUTE}${path}`, init)

/**
 * Open a downlink and read frames until `until` says stop.
 * @param {string} session - chat the tab belongs to.
 * @returns {Promise<{frames: any[], stop: () => void}>} frames seen so far.
 */
async function tab(session, workspace = '') {
  const controller = new AbortController()
  const query = workspace === '' ? '' : `&workspace=${encodeURIComponent(workspace)}`
  const response = await fetch(`${origin}${ROUTE}/downlink?session=${encodeURIComponent(session)}${query}`, {
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const frames = []
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const line = block.split('\n').find((row) => row.startsWith('data: '))
        if (line === undefined) continue
        frames.push(JSON.parse(line.slice(6)))
      }
    }
    } catch {
      /* the tab closed */
    }
  })()
  /** @returns {Promise<any>} next frame the Host pushes, or a failure when the tab is closed. */
  const next = async () => {
    for (let waited = 0; waited < 5_000; waited += 10) {
      const frame = frames.findIndex((frame) => frame.type !== 'hello')
      if (frame !== -1) return frames.splice(frame, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('no frame arrived')
  }
  const stop = () => {
    controller.abort()
    void reader.cancel().catch(() => {})
  }
  return { frames, next, stop, pump }
}

before(async () => {
  apply(context(), { proofLog: process.env.DSH_INNER_BROWSER_PROOF, openWaitMs: 0 })
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
  await rm(proofDir, { recursive: true, force: true })
})

test('registers the page tools and nothing else', () => {
  assert.deepEqual([...defs.keys()].sort(), [
    'browser_click',
    'browser_copy',
    'browser_download',
    'browser_navigate',
    'browser_screenshot',
    'browser_script',
    'browser_selection',
    'browser_type',
    'browser_upload',
    'browser_view',
  ])
  for (const definition of defs.values()) {
    assert.equal(definition.isConcurrencySafe(), false)
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
  }
  assert.equal(defs.get('browser_navigate').timeoutMs, 65_000)
})

test('reports an empty bridge before any tab opens', async () => {
  const state = await call('/state').then((response) => response.json())
  assert.deepEqual(state.connected, [])
  assert.equal(state.pending, 0)
})

test('a tool without a tab says how to open one', async () => {
  await assert.rejects(
    defs.get('browser_view').execute({}, { agent: { id: 'chat-1' } }),
    /No 内置浏览器 tab answered/,
  )
})

test('push without a tab is refused, not buffered', async () => {
  const response = await call('/push?session=chat-1', {
    method: 'POST',
    body: JSON.stringify({ type: 'call', id: 'x' }),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { delivered: false })
})

test('one tool call round-trips through the tab and back', async () => {
  const seat = await tab('chat-1')
  const pending = defs.get('browser_view').execute({}, { agent: { id: 'chat-1' } })
  const call_ = await seat.next()
  assert.equal(call_.type, 'call')
  assert.equal(call_.tool, 'view')
  const reply = await call('/uplink?session=chat-1', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: call_.id, ok: true, value: { text: 'Example Domain' } }),
  })
  assert.equal(reply.status, 200)
  assert.deepEqual(await pending, { text: 'Example Domain' })
  seat.stop()
})

test('a refusal from the page reaches the model as an error', async () => {
  const seat = await tab('chat-2')
  const pending = defs.get('browser_click').execute({ ref: 9 }, { agent: { id: 'chat-2' } })
  const settled = assert.rejects(pending, /no control 9 on this page/)
  const frame = await seat.next()
  await call('/uplink?session=chat-2', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: false, error: 'no control 9 on this page' }),
  })
  await settled
  seat.stop()
})

test('a silent tab fails the call instead of hanging it', async () => {
  const seat = await tab('chat-3')
  const definition = defs.get('browser_view')
  const pending = definition.execute({}, { agent: { id: 'chat-3' } })
  const settled = assert.rejects(pending, /did not finish view in time/)
  await seat.next()
  await settled
  seat.stop()
})

test('the last open tab serves a chat with no tab of its own', async () => {
  const seat = await tab('chat-4')
  const pending = defs.get('browser_view').execute({}, { agent: { id: 'another-chat' } })
  const frame = await seat.next()
  assert.equal(frame.tool, 'view')
  await call('/uplink?session=chat-4', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: { text: 'served' } }),
  })
  assert.deepEqual(await pending, { text: 'served' })
  seat.stop()
})

test('the state route says where each chat writes', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ib-state-'))
  const seat = await tab('chat-11', `cwd:${project}`)
  const state = await call('/state').then((response) => response.json())
  assert.deepEqual(state.connected, ['chat-11'])
  assert.equal(state.folders['chat-11'], project)
  seat.stop()
  await rm(project, { recursive: true, force: true })
})

test('a chat with no folder in its tab still reports the folder the Host knows', async () => {
  const seat = await tab('chat-12')
  const state = await call('/state').then((response) => response.json())
  assert.equal(state.folders['chat-12'], HOST_FOLDER)
  seat.stop()
})

test('a client heartbeat is visible in the state route', async () => {
  await call('/uplink', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-alive', phase: 'registered', tabType: true }),
  })
  const state = await call('/state').then((response) => response.json())
  assert.equal(state.client.phase, 'registered')
  assert.equal(state.client.tabType, true)
  assert.equal(state.client.fresh, true)
})

test('an unknown path is a 404, not a hang', async () => {
  const response = await call('/nope')
  assert.equal(response.status, 404)
})

test('a file the page offers lands in the chat folder', async () => {
  const seat = await tab('chat-6')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ib-cwd-'))
  const pending = defs.get('browser_download').execute(
    { url: 'https://example.com/files/report.txt' },
    { agent: { id: 'chat-6', cwd } },
  )
  const frame = await seat.next()
  assert.equal(frame.tool, 'download')
  const ticket = String(frame.args.ticket)
  const first = await call(`/grab?ticket=${ticket}&name=report.txt&offset=0&final=0`, { method: 'POST', body: 'hello ' })
  assert.equal(first.status, 200)
  const second = await call(`/grab?ticket=${ticket}&name=report.txt&offset=6&final=1`, { method: 'POST', body: 'world' })
  const landed = await second.json()
  assert.equal(landed.path, join(cwd, '.dsh-inner-browser-use', 'downloads', 'report.txt'))
  assert.equal(landed.bytes, 11)
  await call('/uplink?session=chat-6', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: { path: landed.path, bytes: landed.bytes } }),
  })
  const answered = await pending
  assert.equal(answered.text, `Saved ${landed.path} (11 bytes)\n\nhello world`)
  assert.equal(await readFile(landed.path, 'utf8'), 'hello world')
  seat.stop()
})

test('a file lands in the folder the chat works in, not the profile', async () => {
  const project = await mkdtemp(join(tmpdir(), 'dsh-ib-project-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-ib-elsewhere-'))
  const seat = await tab('chat-9', `cwd:${project}`)
  const pending = defs.get('browser_download').execute(
    { url: 'https://example.com/files/n.txt' },
    { agent: { id: 'chat-9', cwd: elsewhere } },
  )
  const frame = await seat.next()
  const ticket = String(frame.args.ticket)
  const done = await call(`/grab?ticket=${ticket}&name=n.txt&offset=0&final=1`, { method: 'POST', body: 'x' })
  const landed = await done.json()
  assert.equal(landed.path, join(project, '.dsh-inner-browser-use', 'downloads', 'n.txt'))
  assert.deepEqual(await readdir(join(project, '.dsh-inner-browser-use')).then((rows) => rows.sort()), [
    '.gitignore',
    'downloads',
  ])
  await call('/uplink?session=chat-9', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: landed }),
  })
  await pending
  seat.stop()
  await rm(project, { recursive: true, force: true })
  await rm(elsewhere, { recursive: true, force: true })
})

test('a transfer nobody opened is refused instead of writing', async () => {
  const response = await call('/grab?ticket=unknown&name=a.txt&offset=0&final=1', { method: 'POST', body: 'x' })
  assert.equal(response.status, 404)
})

test('a screenshot lands on disk and the tool returns its path', async () => {
  const seat = await tab('chat-5')
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ib-cwd-'))
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  const pending = defs.get('browser_screenshot').execute({}, { agent: { id: 'chat-5', cwd } })
  const frame = await seat.next()
  assert.equal(frame.tool, 'shot')
  await call('/uplink?session=chat-5', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: { png } }),
  })
  const { text } = await pending
  assert.ok(text.startsWith(join(cwd, '.dsh-inner-browser-use', 'screenshots')), text)
  const bytes = await readFile(text)
  assert.equal(bytes.length, 8)
  /* The work folder keeps itself out of the project's own version control. */
  assert.equal(await readFile(join(cwd, '.dsh-inner-browser-use', '.gitignore'), 'utf8').then((t) => t.includes('*')), true)
  seat.stop()
  await rm(cwd, { recursive: true, force: true })
})

test('upload carries the file into the page and refuses a missing one', async () => {
  const seat = await tab('chat-6')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ib-file-'))
  const file = join(dir, 'note.txt')
  await writeFile(file, 'hello')
  const pending = defs.get('browser_upload').execute({ ref: 2, path: file }, { agent: { id: 'chat-6' } })
  const frame = await seat.next()
  assert.equal(frame.tool, 'upload')
  assert.equal(frame.args.name, 'note.txt')
  assert.equal(frame.args.type, 'text/plain')
  assert.equal(Buffer.from(frame.args.base64, 'base64').toString(), 'hello')
  await call('/uplink?session=chat-6', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: { text: 'Attached' } }),
  })
  assert.deepEqual(await pending, { text: 'Attached' })
  seat.stop()
  await rm(dir, { recursive: true, force: true })
  await assert.rejects(
    defs.get('browser_upload').execute({ ref: 1, path: '/nope/missing.bin' }, { agent: { id: 'chat-6' } }),
    /no file at/,
  )
})

test('a tab that opens in time answers the waiting call', async () => {
  const bridge = new Bridge()
  const seen = []
  bridge.watch({ write: (chunk) => seen.push(String(chunk)), end() {} })
  const waiting = bridge.waitSeat('chat-late', 2_000, undefined)
  bridge.attach('chat-late', { write: () => true, end() {} })
  assert.equal(await waiting, true)
  bridge.want('chat-late')
  assert.match(seen.at(-1), /"type":"wanted"/)
  assert.match(seen.at(-1), /"session":"chat-late"/)
})

test('a waiting call gives up when no tab opens', async () => {
  const bridge = new Bridge()
  const started = Date.now()
  assert.equal(await bridge.waitSeat('chat-none', 120, undefined), false)
  assert.ok(Date.now() - started < 2_000)
})

test('one ask per burst, and no ask when no page is listening', async () => {
  const bridge = new Bridge()
  const seen = []
  bridge.want('chat-1')
  assert.equal(seen.length, 0)
  bridge.watch({ write: (chunk) => seen.push(String(chunk)), end() {} })
  bridge.want('chat-1')
  bridge.want('chat-1')
  assert.equal(seen.length, 1)
  bridge.want('chat-2')
  assert.equal(seen.length, 2)
})

test('a heartbeat reports its own age', () => {
  assert.equal(clientState(undefined), null)
  const frame = { type: 'client-alive', phase: 'ready', tabType: true }
  const fresh = clientState({ ms: 1_000, frame }, 2_000)
  assert.equal(fresh.fresh, true)
  assert.equal(fresh.phase, 'ready')
  const stale = clientState({ ms: 1_000, frame }, 120_000)
  assert.equal(stale.fresh, false)
  assert.equal(stale.tabType, true)
})

test('a tab that reports its own id still answers the chat that asked', () => {
  const bridge = new Bridge()
  const frames = []
  bridge.watch({ write: (frame) => frames.push(frame), end: () => {} })
  assert.equal(bridge.want('chat-a'), undefined)
  bridge.noteOpen({ opened: 'current', session: 'tab-77' })
  bridge.attach('tab-77', { write: () => {}, end: () => {} })
  assert.equal(bridge.hasSeat('chat-a'), true)
  assert.deepEqual(bridge.connected(), ['tab-77'])
})

test('two open tabs stay apart: a chat reaches only its own', () => {
  const bridge = new Bridge()
  const heard = []
  bridge.watch({ write: () => {}, end: () => {} })
  bridge.want('chat-a')
  bridge.noteOpen({ opened: 'current', session: 'tab-a' })
  bridge.attach('tab-a', { write: (frame) => heard.push(['a', frame]), end: () => {} })
  bridge.attach('tab-b', { write: (frame) => heard.push(['b', frame]), end: () => {} })
  assert.equal(bridge.push('chat-a', { type: 'call' }), true)
  assert.deepEqual(heard.map(([seat]) => seat), ['a'])
})

test('two halves never share an epoch, and every heartbeat reply names one', () => {
  const one = new Bridge()
  const two = new Bridge()
  assert.notEqual(one.epoch, two.epoch)
  assert.match(one.epoch, /^[a-z0-9]+-[a-z0-9]+$/)
})

test('a page that just came back takes the call on the second try', async () => {
  const seat = await tab('chat-7')
  const pending = defs.get('browser_click').execute({ ref: 2 }, { agent: { id: 'chat-7' } })
  const first = await seat.next()
  await call('/uplink?session=chat-7', {
    method: 'POST',
    body: JSON.stringify({
      type: 'reply',
      id: first.id,
      ok: false,
      error: 'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.',
    }),
  })
  const second = await seat.next()
  assert.notEqual(second.id, first.id)
  assert.equal(second.tool, 'click')
  await call('/uplink?session=chat-7', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: second.id, ok: true, value: 'Clicked #2' }),
  })
  assert.deepEqual(await pending, { text: 'Clicked #2' })
  seat.stop()
})

test('the selection comes back as the text it holds', async () => {
  const seat = await tab('chat-sel')
  const pending = defs.get('browser_selection').execute({}, { agent: { id: 'chat-sel' } })
  const frame = await seat.next()
  assert.equal(frame.tool, 'selection')
  await call('/uplink?session=chat-sel', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: true, value: { text: 'the quoted paragraph' } }),
  })
  assert.deepEqual(await pending, { text: 'the quoted paragraph' })
  seat.stop()
})

test('copy carries the control it was given, and its failure reaches the model', async () => {
  const seat = await tab('chat-copy')
  const pending = defs.get('browser_copy').execute({ ref: 4 }, { agent: { id: 'chat-copy' } })
  const settled = assert.rejects(pending, /nothing is selected on this page/)
  const frame = await seat.next()
  assert.equal(frame.tool, 'copy')
  assert.equal(frame.args.ref, 4)
  await call('/uplink?session=chat-copy', {
    method: 'POST',
    body: JSON.stringify({ type: 'reply', id: frame.id, ok: false, error: 'nothing is selected on this page' }),
  })
  await settled
  seat.stop()
})
