/* The mirror's own arithmetic, run against the real client.
 *
 * `test/client.test.mjs` only reads the source: it proves the functions still
 * look a certain way, not that the numbers they produce are right. A single
 * swapped width/height inside `picture()` passes every one of those checks and
 * still sends every click to the wrong place.
 *
 * So this file runs `client.js` for real: the module loader is captured, the
 * pane component is rendered with a small React stand-in, the picture is laid
 * out at a known box, and pointer events go through the component's own
 * handlers. What arrives at `/sidecar/input` is what the page would receive.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function element(name, rect, extra = {}) {
  return {
    name,
    rect,
    getBoundingClientRect: () => rect,
    focus() {},
    setPointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    ...extra,
  }
}

/* One pane, mounted for real: the component function is the shipped one, the
   hooks are the smallest things that behave like React's. */
function mount(options = {}) {
  let captured = null
  const fetchCalls = []
  const sources = []
  let observers = 0

  const windowStub = {
    __ModuleLoader__: { load: (config) => { captured = config } },
    addEventListener() {},
    removeEventListener() {},
  }

  const state = {
    owner: options.owner ?? 'chat-1',
    press: options.press === false ? false : true,
    view: options.view ?? { w: 3000, h: 1600 },
  }

  const documentStub = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    createElement: () => ({ id: '', dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
  }

  const fetchStub = (url, init = {}) => {
    fetchCalls.push({ url: String(url), body: init.body === undefined ? null : JSON.parse(String(init.body)) })
    if (String(url).includes('/sidecar/state')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ok: true,
          owner: state.owner,
          press: state.press,
          sound: false,
          flash: null,
          chat: { remembered: '' },
        }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  }

  class FakeEventSource {
    constructor(url) {
      this.url = String(url)
      this.onmessage = null
      this.onerror = null
      sources.push(this)
    }
    close() {}
  }
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback
      observers += 1
    }
    observe() {}
    disconnect() {}
  }

  const react = (() => {
    const hooks = []
    let cursor = 0
    const pending = []
    let update = () => {}
    const api = {
      createElement(type, props, ...children) {
        return { type, props: { ...(props ?? {}), children } }
      },
      useState(initial) {
        const at = cursor
        cursor += 1
        if (!(at in hooks)) hooks[at] = { value: initial }
        const slot = hooks[at]
        const setter = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          update()
        }
        return [slot.value, setter]
      },
      useRef(initial) {
        const at = cursor
        cursor += 1
        if (!(at in hooks)) hooks[at] = { current: initial }
        return hooks[at]
      },
      useEffect(run, deps) {
        const at = cursor
        cursor += 1
        const was = hooks[at]
        const same = was !== undefined && deps !== undefined && was.deps !== undefined &&
          deps.length === was.deps.length && deps.every((value, i) => Object.is(value, was.deps[i]))
        hooks[at] = { deps, run }
        if (!same) pending.push({ at, run })
      },
    }
    api.start = (notify) => { update = notify }
    api.inspect = () => hooks.map((one) => (one === undefined ? null : 'value' in one ? one.value : one.current))
    api.begin = () => { cursor = 0; pending.length = 0 }
    api.pending = () => pending.splice(0)
    return api
  })()

  const factory = new Function(
    'window', 'document', 'fetch', 'EventSource', 'ResizeObserver',
    'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    SOURCE,
  )

  factory(
    windowStub, documentStub, fetchStub, FakeEventSource, FakeResizeObserver,
    (callback) => { callback(); return 1 },
    setTimeout, clearTimeout,
    () => 0, () => {},
  )

  assert.ok(captured !== null, 'the module loader never saw the client')
  const plugin = captured.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected module ${id}`)
  })
  assert.equal(typeof plugin.apply, 'function')

  /* The slot is how the host reaches the pane: keep the component it takes. */
  let Component = null
  const context = {
    locale: { register() {} },
    effect: (run) => {
      run()
      return () => {}
    },
    inject: (_services, run) => {
      run(context)
    },
    tabs: { register: () => () => {} },
    slots: {
      inject: (_name, callback) => {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (seed, component) => {
        /* The title slot registers a span; the pane is the seed that takes
           the session and a way to close the mirror. Keep that one. */
        if (Component === null || typeof seed?.inject === 'function') Component = component
        return () => {}
      },
    },
  }
  plugin.apply(context)
  assert.equal(typeof Component, 'function')

  const stageRect = options.stage ?? { left: 0, top: 0, width: 900, height: 1200 }
  const frameRect = options.frame ?? stageRect
  const nodes = {
    stage: element('stage', stageRect),
    frame: element('frame', frameRect, {
      naturalWidth: options.natural?.w ?? state.view.w,
      naturalHeight: options.natural?.h ?? state.view.h,
    }),
    ime: element('ime', { left: 0, top: 0, width: 0, height: 0 }, { value: '' }),
    ptr: element('ptr', { left: 0, top: 0, width: 20, height: 20 }),
  }

  let tree = null
  let settle = Promise.resolve()
  let chainError = null
  const draw = () => {
    react.begin()
    tree = Component({ sessionId: options.sessionId ?? 'chat-1', dropMirror: () => {} })
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      const ref = node.props?.ref
      const name = node.props?.className
      if (ref !== null && ref !== undefined && typeof ref === 'object') {
        if (name === 'dshib-side-stage') ref.current = nodes.stage
        if (name === 'dshib-side-frame') ref.current = nodes.frame
        if (name === 'dshib-side-ime') ref.current = nodes.ime
        if (name === 'dshib-side-ptr') ref.current = nodes.ptr
      }
      walk(node.props?.children ?? [])
    }
    walk(tree)
    const effects = react.pending()
    for (const effect of effects) effect.run()
  }

  react.start(() => {
    settle = settle.then(() => {
      draw()
      return flush()
    }).catch((error) => { chainError = error })
  })

  draw()

  const find = (className) => {
    const search = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return null
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = search(child)
          if (hit !== null) return hit
        }
        return null
      }
      if (node.props?.className === className) return node
      return search(node.props?.children ?? [])
    }
    return search(tree)
  }

  const frames = () => sources.filter((source) => source.url.includes('/sidecar/frames')).at(-1) ?? null

  return {
    state,
    nodes,
    fetchCalls,
    drawn: () => tree,
    find,
    frame: (message) => {
      const stream = frames()
      assert.ok(stream !== null, 'the pane never opened its frame stream')
      assert.equal(typeof stream.onmessage, 'function')
      stream.onmessage({ data: JSON.stringify(message) })
    },
    settle: async () => {
      /* Every state change queues another render: wait until the queue stops
         growing instead of guessing a number of ticks. */
      for (let round = 0; round < 20; round += 1) {
        await flush()
        if (chainError !== null) throw chainError
        const chain = settle
        await chain
        if (chain === settle) break
      }
      if (chainError !== null) throw chainError
    },
    input: () => fetchCalls.filter((call) => call.url.includes('/sidecar/input')).map((call) => call.body),
    reset: () => { fetchCalls.length = 0 },
    observerCount: () => observers,
  }
}

test('a picture smaller than its box sends the point it is drawn at', async () => {
  const pane = mount()
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 3000, h: 1600, target: 'tab-1', url: 'https://example.com/' })
  await pane.settle()
  pane.reset()

  /* 900 wide box, 3000x1600 picture: the picture fills the width (scale 0.3,
     900x480) and is letterboxed 360 px top and bottom. */
  const down = pane.find('dshib-side-stage')
  assert.ok(down !== null)
  down.props.onPointerDown({
    clientX: 450,
    clientY: 600,
    pointerId: 1,
    currentTarget: pane.nodes.stage,
  })
  await pane.settle()
  down.props.onPointerUp({ clientX: 450, clientY: 600 })
  await pane.settle()

  const bodies = pane.input()
  assert.ok(bodies.length > 0, 'a click inside the picture reached no input')
  assert.equal(bodies[0].kind, 'down')
  const body = bodies.at(-1)
  assert.equal(body.kind, 'up')
  assert.equal(body.fw, 3000)
  assert.equal(body.fh, 1600)
  assert.equal(body.pw, 3000)
  assert.equal(body.ph, 1600)
  assert.equal(body.fx, 0.5)
  assert.equal(body.fy, 0.5)
  /* The click at the middle of the picture is the middle of the page. */
  assert.equal(body.x, 1500)
  assert.equal(body.y, 800)
})

test('the same point in the column maps the same way at any column width', async () => {
  const wide = mount({ stage: { left: 0, top: 0, width: 900, height: 1200 } })
  const narrow = mount({ stage: { left: 0, top: 0, width: 450, height: 1200 } })
  for (const pane of [wide, narrow]) {
    await pane.settle()
    pane.frame({ jpeg: 'AA', w: 3000, h: 1600, target: 'tab-1' })
    await pane.settle()
    pane.reset()
    const stage = pane.find('dshib-side-stage')
    /* A quarter of the way across whichever column the pane was given. */
    const across = pane.nodes.stage.rect.width / 4
    stage.props.onPointerDown({ clientX: across, clientY: 600, pointerId: 1, currentTarget: pane.nodes.stage })
    await pane.settle()
    stage.props.onPointerUp({ clientX: across, clientY: 600 })
    await pane.settle()
  }
  const w = wide.input().at(-1)
  const n = narrow.input().at(-1)
  assert.ok(w && n)
  /* 900-wide column: 225 is a quarter across the picture. 450-wide column:
     the picture is scaled to half, so 225 is still a quarter across. */
  assert.equal(w.fx, 0.25)
  assert.equal(n.fx, 0.25)
  assert.equal(w.x, Math.round(0.25 * 2999))
  assert.equal(n.x, w.x)
})

test('a page whose frame is smaller than its layout still maps across the page', async () => {
  /* A display at 150% hands back a picture capped in device pixels: the frame
     is 2000x1200 while the page is 3000x1800. The fraction has to come off the
     picture that is drawn, and the page size has to travel beside it. */
  const pane = mount({ view: { w: 3000, h: 1800 }, natural: { w: 2000, h: 1200 } })
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 3000, h: 1800, target: 'tab-1' })
  await pane.settle()
  pane.reset()

  const stage = pane.find('dshib-side-stage')
  /* 900-wide box, 2000x1200 picture: scale 0.45, drawn 900x540, 330 px down. */
  stage.props.onPointerDown({ clientX: 450, clientY: 600, pointerId: 1, currentTarget: pane.nodes.stage })
  await pane.settle()
  stage.props.onPointerUp({ clientX: 450, clientY: 600 })
  await pane.settle()

  const [body] = pane.input()
  assert.ok(body)
  assert.equal(body.fw, 2000)
  assert.equal(body.fh, 1200)
  assert.equal(body.pw, 3000)
  assert.equal(body.ph, 1800)
  assert.equal(body.fx, 0.5)
  assert.equal(body.fy, 0.5)
})

test('a wheel in the bars beside the picture scrolls the nearest edge', async () => {
  const pane = mount()
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 3000, h: 1600, target: 'tab-1' })
  await pane.settle()
  pane.reset()

  const stage = pane.find('dshib-side-stage')
  /* Below the picture (it ends at 840 in a 1200-tall box): the wheel still
     belongs to the page, pulled to its bottom edge instead of thrown away. */
  stage.props.onWheel({
    clientX: 450,
    clientY: 1190,
    deltaX: 0,
    deltaY: 120,
    preventDefault() {},
  })
  await pane.settle()

  const [body] = pane.input()
  assert.ok(body, 'a wheel beside the picture reached no input')
  assert.equal(body.kind, 'wheel')
  assert.equal(body.dy, 120)
  assert.equal(body.fy, 1)
  assert.equal(body.fx, 0.5)
})

test('the drawn hand sits where a click on the same point lands', async () => {
  /* A Windows display at 150%: the page is 1000x700 points, the picture that
     reaches the pane is 1500x1050 pixels. The hand arrives in page points. */
  const pane = mount({ natural: { w: 1500, h: 1050 } })
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 1000, h: 700, target: 'tab-1' })
  await pane.settle()
  pane.frame({ type: 'pointer', w: 1000, h: 700, pointer: { x: 250, y: 175 } })
  await pane.settle()

  /* 900x1200 box, picture scaled 0.6 to 900x630 and letterboxed at y=285. */
  const hand = pane.find('dshib-side-ptr')
  assert.ok(hand !== null, 'the pane drew no hand')
  assert.equal(hand.props.style.left, '225px')
  assert.equal(hand.props.style.top, '442.5px')
})

test('a press outside the picture opens no gesture', async () => {
  const pane = mount()
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 3000, h: 1600, target: 'tab-1' })
  await pane.settle()
  pane.reset()

  const stage = pane.find('dshib-side-stage')
  stage.props.onPointerDown({ clientX: 450, clientY: 60, pointerId: 1, currentTarget: pane.nodes.stage })
  await pane.settle()
  stage.props.onPointerUp({ clientX: 450, clientY: 60 })
  await pane.settle()

  assert.deepEqual(pane.input(), [])
})

test('a drag reaches the page at the speed the hand drew it', async () => {
  const pane = mount()
  await pane.settle()
  pane.frame({ jpeg: 'AA', w: 3000, h: 1600, target: 'tab-1', url: 'https://example.com/' })
  await pane.settle()
  pane.reset()
  const stage = pane.find('dshib-side-stage')
  /* Eight moves 12 ms apart is a slow drag a person would draw a curve with.
     A 40 ms gate lets two or three of them through and turns the rest into
     straight lines. */
  for (let i = 0; i < 8; i += 1) {
    stage.props.onPointerMove({ clientX: 100 + i * 40, clientY: 600, pointerId: 1, currentTarget: pane.nodes.stage })
    await new Promise((resolve) => setTimeout(resolve, 12))
  }
  await new Promise((resolve) => setTimeout(resolve, 120))
  const points = pane.input().filter((body) => body.kind === 'hover')
  assert.ok(points.length >= 8, `the page saw ${points.length} of 8 points of the drag`)
})
