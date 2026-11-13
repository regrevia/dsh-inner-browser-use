/**
 * Where a control is, is a fact about the page, so these run the expressions
 * read.js sends into it. A page that scrolls smoothly answers with the
 * animation's starting rectangle unless the scroll is asked to be instant, and
 * a window is not the page: a point outside it is not the control.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, covering, resolveFirst } from '../read.js'

/** Run one of read.js's page expressions against a fake page. */
function run(expression, page) {
  return new Function('window', 'document', 'getComputedStyle', 'innerHeight', 'innerWidth', `return ${expression}`)(
    { __dshRead: { find: () => ({ el: page.el }) } },
    { elementFromPoint: page.at ?? (() => null) },
    () => ({ visibility: 'visible', display: 'block' }),
    page.height ?? 900,
    page.width ?? 1280,
  )
}

/** A control at a place, with nothing inside it. */
function control(at, extra = {}) {
  return {
    tagName: 'BUTTON', innerText: 'Go', value: '', disabled: false, parentElement: null,
    getAttribute: () => null, contains: () => false,
    scrollIntoView() {},
    getBoundingClientRect: () => at,
    ...extra,
  }
}

const box = (left, top, width = 100, height = 20) => ({ left, top, right: left + width, bottom: top + height, width, height })

test('the scroll skips the animation, so the rectangle is the final one', () => {
  let asked = null
  const el = control(box(10, 4000), { scrollIntoView: (options) => { asked = options } })
  run(resolve(4), { el })
  assert.equal(asked.behavior, 'instant', 'a smooth page would report the pre-scroll rectangle')
})

test('a control that never comes on screen is off, not gone', () => {
  const said = JSON.parse(run(resolve(4), { el: control(box(10, 4000)) }))
  assert.equal(said.off, true)
  assert.equal(said.gone, true, 'there is nowhere to press, so it cannot be used')
  assert.equal(said.name, 'Go', 'the words still say which control it was')
})

test('a control half over the edge is pressed on the part that shows', () => {
  const said = JSON.parse(run(resolve(4), { el: control(box(-40, 100)) }))
  assert.equal(said.off, undefined)
  assert.equal(said.x, 30, 'the middle of the visible 60 px, not the middle of the control')
  assert.equal(said.y, 110)
})

test('a control that fits is pressed in its middle', () => {
  const said = JSON.parse(run(resolve(4), { el: control(box(100, 100)) }))
  assert.deepEqual([said.x, said.y], [150, 110])
})

test('body painted over the control is a cover, not a miss', () => {
  const el = control(box(10, 10))
  const body = {
    tagName: 'BODY', innerText: 'page', getAttribute: () => null, parentElement: null,
    querySelectorAll: () => [], getBoundingClientRect: () => ({ width: 1280, height: 900 }),
    contains: () => true,
  }
  const said = JSON.parse(run(covering(4), { el, at: () => body }))
  assert.equal(said.tag, 'body', 'an ancestor holds every control, and a press there reaches nobody')
})

test('the control own child taking the press is not a cover', () => {
  const child = { tagName: 'SPAN', innerText: 'label', getAttribute: () => null, parentElement: null, contains: () => false }
  const el = control(box(10, 10), { contains: (node) => node === child })
  assert.equal(run(covering(4), { el, at: () => child }), '', 'the press bubbles back to the control')
})

test('a banner is found under a control that was below the fold', () => {
  /* A pinned banner covers the same strip at every scroll position, so a
     control far down the page is under it too. Looking up the raw rectangle
     would answer about a place the control is not. */
  let rect = box(100, 4000)
  const el = control(rect, {
    scrollIntoView() {
      rect = box(100, 400)
    },
    getBoundingClientRect: () => rect,
  })
  const banner = { tagName: 'DIV', innerText: 'We use cookies', getAttribute: () => null, parentElement: null, querySelectorAll: () => [], getBoundingClientRect: () => box(0, 0, 1280, 600), contains: () => true }
  const said = JSON.parse(run(covering(4), { el, at: () => banner }))
  assert.equal(said.tag, 'div', 'the probe asks about where the press would land, not where the control was')
  assert.equal(said.text, 'We use cookies')
})

test('a control half under a banner is pressed on the part that shows', () => {
  /* The banner covers the top half. The middle of the control would send the
     press into the banner, so the point that the page hands back has to be
     the one below it — that is the difference between "refused although it
     was clickable" and "clicked where it shows". */
  const el = control(box(100, 100, 100, 100))
  const banner = { tagName: 'DIV', innerText: 'banner', getAttribute: () => null, parentElement: null, contains: () => true }
  const said = JSON.parse(run(resolve(4), { el, at: (_x, y) => (y < 160 ? banner : el) }))
  assert.notEqual(said.gone, true)
  assert.equal(said.y, 170, 'the lower part of the control, which the page agrees is reachable')
})

test('a control covered everywhere keeps its middle, and the cover probe refuses it', () => {
  const el = control(box(100, 100))
  const banner = { tagName: 'DIV', innerText: 'We use cookies', getAttribute: () => null, parentElement: null, querySelectorAll: () => [], getBoundingClientRect: () => box(0, 0, 1280, 900), contains: () => true }
  const at = () => banner
  assert.deepEqual([JSON.parse(run(resolve(4), { el, at })).x, JSON.parse(run(resolve(4), { el, at })).y], [150, 110])
  assert.equal(JSON.parse(run(covering(4), { el, at })).tag, 'div', 'the same question, asked twice, agrees')
})

test('a control nothing of can be pressed says what is on top of it', () => {
  const el = control(box(100, 200, 600, 120))
  const banner = { innerText: 'Delivery note', tagName: 'DIV', getAttribute: () => null }
  const said = JSON.parse(run(resolve(4), { el, at: () => banner }))
  assert.equal(said.gone, false, 'it is there, and a caller asking only where still gets a point')
  assert.equal(said.covered, 'Delivery note', 'the answer names the thing in the way')
  assert.equal(said.y, 260, 'the point it offers is still the middle, for callers that only locate')
})

test('a control that is free everywhere is not reported as covered', () => {
  const el = control(box(100, 200, 600, 120))
  const said = JSON.parse(run(resolve(4), { el }))
  assert.equal(said.covered, undefined, 'a clear page says nothing about a cover')
})

/**
 * Run resolveFirst against a page whose numbers map to given controls. The
 * words arrive squeezed, which is how findWords calls it.
 */
function runFirst(expression, byRef, page) {
  return new Function('window', 'document', 'getComputedStyle', 'innerHeight', 'innerWidth', `return ${expression}`)(
    { __dshRead: { find: (ref) => byRef[ref] } },
    { elementFromPoint: page.at ?? (() => null) },
    () => ({ overflowX: 'visible', overflowY: 'visible' }),
    page.height ?? 900,
    page.width ?? 1280,
  )
}

test('a name found by its words is pressed on a free part of a half covered control', () => {
  const el = control(box(100, 200, 600, 120))
  const banner = { innerText: 'Delivery note', tagName: 'DIV', getAttribute: () => null }
  /* The banner covers the middle and the right, but not the left third. */
  const said = JSON.parse(runFirst(resolveFirst([4], 'go'), { 4: { el } }, { el, at: (x) => (x > 300 ? banner : el) }))
  assert.equal(said.gone, false)
  assert.equal(said.covered, undefined, 'the free part is used instead of refusing')
  assert.ok(said.x < 300, `pressed at ${said.x}, on the part that shows`)
})

test('a name whose every candidate is covered answers with the name of the cover', () => {
  const one = control(box(100, 200, 600, 120))
  const two = control(box(100, 400, 600, 120))
  const banner = { innerText: 'Delivery note', tagName: 'DIV', getAttribute: () => null }
  const said = JSON.parse(runFirst(resolveFirst([4, 5], 'go'), { 4: { el: one }, 5: { el: two } }, { el: one, at: () => banner }))
  assert.equal(said.gone, false, 'refusing is not the same as the control being gone')
  assert.equal(said.covered, 'Delivery note')
  assert.equal(said.ref, 4, 'the first candidate is the one named')
})
