/**
 * What the Flash window is asked to type and click. This is the half of Flash
 * input that used to be wrong in ways nobody could see from the outside: a
 * press landed at twice its distance from the corner, and arrow keys arrived
 * as an empty key with key code 0. Both are decided here, without Electron.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { MAX_INPUT_BYTES, keyCodeOf, keyEvents, modifiersOf, planInput } = await import('../runtime/flash-input.cjs')

const post = (body) => planInput({ method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), alive: true })

test('a drag keeps the button held from press to release', () => {
  /* A plugin's input loop reads the held button on every move. Without it the
     page sees a hand that goes down and comes up one pixel later. */
  const press = post({ type: 'mouseDown', x: 10, y: 10, buttons: 0 }).event
  const moves = [12, 14, 16].map((x) => post({ type: 'mouseMove', x, y: 12, buttons: 1 }).event)
  const release = post({ type: 'mouseUp', x: 16, y: 12, buttons: 1 }).event
  assert.deepEqual(press.modifiers, ['leftButtonDown'])
  for (const move of moves) assert.deepEqual(move.modifiers, ['leftButtonDown'])
  assert.deepEqual(release.modifiers, [])
  assert.deepEqual(moves.map((move) => move.x), [12, 14, 16])
})

test('the endpoint answers the way the window does', () => {
  assert.equal(planInput({ method: 'GET', body: '{}', alive: true }).status, 405)
  assert.equal(post('x'.repeat(MAX_INPUT_BYTES + 1)).status, 413)
  assert.equal(post('not json').status, 500)
  assert.equal(planInput({ method: 'POST', body: '{"type":"keyDown","keyCode":"a"}', alive: false }).status, 503)
  assert.equal(post({ type: '' }).status, 400)
  assert.equal(post({ x: 1, y: 2 }).status, 400)
  assert.equal(post({ type: 'mouseDown', x: 'left', y: 2 }).status, 400)
  assert.equal(post({ type: 'paste', text: 'hi' }).status, 400)
})

test('a press lands where it was asked to', () => {
  /* The window takes page pixels. Scaling them here is what put every press at
     twice its distance from the corner once the window ran at scale 2. */
  const plan = post({ type: 'mouseDown', x: 60, y: 30, clickCount: 1 })
  assert.equal(plan.status, 200)
  assert.deepEqual(plan.event, { type: 'mouseDown', x: 60, y: 30, button: 'left', clickCount: 1, modifiers: ['leftButtonDown'] })
})

test('a release and a move carry the right button state', () => {
  const up = post({ type: 'mouseUp', x: 60, y: 30 }).event
  assert.deepEqual(up.modifiers, [])
  assert.equal(up.clickCount, 1)

  const move = post({ type: 'mouseMove', x: 61, y: 31, buttons: 1 }).event
  assert.deepEqual(move.modifiers, ['leftButtonDown'])
  assert.equal(move.clickCount, 0)

  const hover = post({ type: 'mouseMove', x: 61, y: 31 }).event
  assert.deepEqual(hover.modifiers, [])
})

test('a wheel keeps its deltas and its point', () => {
  const plan = post({ type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -600 })
  assert.deepEqual(plan.event, { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -600, modifiers: [] })
})

test('a named key is spelled the way the window spells it', () => {
  /* Accelerator names, not DOM names: `ArrowUp` reached the page as an empty
     key with key code 0, while `Enter` and `Tab` happened to work. */
  assert.equal(keyCodeOf('ArrowUp'), 'Up')
  assert.equal(keyCodeOf('arrowdown'), 'Down')
  assert.equal(keyCodeOf('PageUp'), 'PageUp')
  /* One character stays itself: it is the text to type. */
  assert.equal(keyCodeOf(' '), ' ')
  assert.equal(keyCodeOf('Space'), 'Space')
  assert.equal(keyCodeOf('Spacebar'), 'Space')
  assert.equal(keyCodeOf('Return'), 'Enter')
  assert.equal(keyCodeOf('Esc'), 'Escape')
  assert.equal(keyCodeOf('a'), 'a')
  assert.equal(keyCodeOf('Enter'), 'Enter')
})

test('a keystroke is the key, then the text it types', () => {
  const typed = keyEvents({ type: 'keyDown', key: 'a', text: 'a' })
  assert.deepEqual(typed, [{ type: 'keyDown', keyCode: 'a', modifiers: [] }, { type: 'char', keyCode: 'a', modifiers: [] }])
  assert.deepEqual(keyEvents({ type: 'keyDown', key: 'ArrowUp' }), [{ type: 'keyDown', keyCode: 'Up', modifiers: [] }])
  assert.deepEqual(keyEvents({ type: 'keyUp', key: 'ArrowUp' }), [{ type: 'keyUp', keyCode: 'Up', modifiers: [] }])
  assert.deepEqual(keyEvents({ type: 'char', key: 'a' }), [{ type: 'char', keyCode: 'a', modifiers: [] }])
  assert.deepEqual(keyEvents({ type: 'keyDown' }), [])
  assert.deepEqual(keyEvents({ type: 'paste', key: 'a' }), [])
})

test('modifier bits and names both work', () => {
  assert.deepEqual(modifiersOf(8), ['shift'])
  assert.deepEqual(modifiersOf(1 | 2 | 4 | 8), ['alt', 'control', 'meta', 'shift'])
  assert.deepEqual(modifiersOf(['Shift', 'shift', 'Control']), ['shift', 'control'])
  assert.deepEqual(modifiersOf(undefined), [])
  assert.deepEqual(post({ type: 'keyDown', keyCode: 'A', modifiers: 8 }).event.modifiers, ['shift'])
})
