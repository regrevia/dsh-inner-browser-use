/* What the Flash window accepts on /input, decided in one place: the same
   choices are unit-tested without Electron, and the runtime only forwards what
   comes out of here. Two rules are load-bearing and were both wrong before:

   - Coordinates are already page pixels. `sendInputEvent` takes them in the
     page's own layout space, so multiplying by the window's scale put every
     press at twice its distance from the corner and missed the target.
   - A named key reaches Chromium the way an accelerator spells it. `ArrowUp`
     is not a key code there (`Up` is): the old passthrough sent a keydown with
     an empty key and keyCode 0, so arrows and page keys did nothing.

   Mouse buttons are carried too: a press tells the page which button is down
   (`leftButtonDown`), which is what a plugin's own input loop reads. */

const MAX_INPUT_BYTES = 8192

const MOUSE_TYPES = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel'])
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'char'])
const MODIFIERS = new Set(['alt', 'control', 'meta', 'shift'])
const BUTTONS = new Set(['left', 'middle', 'right'])

/* Accelerator spellings for the names a page uses. Everything not listed here
   is already spelled the same way in both worlds (Enter, Tab, Escape,
   Backspace, Delete, Home, End, PageUp, PageDown, Insert, F1–F24). */
const NAMED_KEYS = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  tab: 'Tab',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  caps: 'Capslock',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  printscreen: 'PrintScreen',
  meta: 'Super',
  super: 'Super',
  command: 'Super',
  cmd: 'Super',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
}

/**
 * @param {string} name - a key name from a page or from a tool call.
 * @returns {string} the name Chromium takes for the same key.
 */
function keyCodeOf(name) {
  const text = String(name)
  if (text.length <= 1) return text
  return NAMED_KEYS[text.toLowerCase()] ?? text
}

/**
 * Modifier bits (`1 alt, 2 control, 4 meta, 8 shift`) or a list of names.
 * @param {unknown} value - what the caller passed.
 * @returns {string[]} names Chromium knows.
 */
function modifiersOf(value) {
  const names = []
  const put = (name) => {
    const flat = String(name).toLowerCase()
    if (MODIFIERS.has(flat) && names.includes(flat) !== true) names.push(flat)
  }
  if (Array.isArray(value)) {
    for (const one of value) put(one)
    return names
  }
  const bits = Number(value ?? 0)
  if (!Number.isFinite(bits)) return names
  if ((bits & 1) !== 0) put('alt')
  if ((bits & 2) !== 0) put('control')
  if ((bits & 4) !== 0) put('meta')
  if ((bits & 8) !== 0) put('shift')
  return names
}

/** Which mouse buttons a run of events should report as held. */
function heldButtons(value) {
  const bits = Number(value ?? 0)
  const names = []
  if (!Number.isFinite(bits)) return names
  if ((bits & 1) !== 0) names.push('leftButtonDown')
  if ((bits & 2) !== 0) names.push('rightButtonDown')
  if ((bits & 4) !== 0) names.push('middleButtonDown')
  return names
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * One event for `webContents.sendInputEvent`.
 * @param {any} raw - the JSON body of a request.
 * @returns {object|null} the event, or null when the body cannot be honoured.
 */
function buildEvent(raw) {
  if (raw === null || typeof raw !== 'object' || typeof raw.type !== 'string') return null
  const type = raw.type.trim()
  if (type === '') return null
  const base = modifiersOf(raw.modifiers)
  if (MOUSE_TYPES.has(type) === true) {
    const x = finite(raw.x)
    const y = finite(raw.y)
    if (x === null || y === null) return null
    const at = { x: Math.round(x), y: Math.round(y) }
    if (type === 'mouseWheel') {
      return { type, ...at, deltaX: Math.round(finite(raw.deltaX) ?? 0), deltaY: Math.round(finite(raw.deltaY) ?? 0), modifiers: base }
    }
    const button = BUTTONS.has(String(raw.button ?? 'left')) ? String(raw.button ?? 'left') : 'left'
    const clickCount = Math.min(3, Math.max(1, Math.round(finite(raw.clickCount) ?? 1)))
    const held = type === 'mouseDown' ? [`${button}ButtonDown`] : type === 'mouseMove' ? heldButtons(raw.buttons) : []
    const modifiers = [...new Set([...base, ...held])]
    return { type, ...at, button, clickCount: type === 'mouseMove' ? 0 : clickCount, modifiers }
  }
  if (KEY_TYPES.has(type) === true) {
    const named = raw.keyCode
    if (typeof named !== 'string' || named === '') return null
    if (type === 'char') return { type, keyCode: named, modifiers: base }
    return { type, keyCode: keyCodeOf(named), modifiers: base }
  }
  return null
}

/**
 * One keystroke as the events the window wants: the key itself, then the text
 * it types on the way down.
 * @param {{type: string, key?: string, text?: string, modifiers?: unknown}} key - one key.
 * @returns {object[]} events to send in order.
 */
function keyEvents(key) {
  const type = String(key?.type ?? '')
  if (KEY_TYPES.has(type) !== true) return []
  const char = String(key?.text ?? '')
  const named = String(key?.key ?? '')
  const first = buildEvent({ type, keyCode: char !== '' ? char : named, modifiers: key?.modifiers })
  if (first === null) return []
  const events = [first]
  if (type === 'keyDown' && char !== '') {
    const typed = buildEvent({ type: 'char', keyCode: char, modifiers: key?.modifiers })
    if (typed !== null) events.push(typed)
  }
  return events
}

/**
 * Decide a whole `/input` request, the way the HTTP handler must answer it.
 * @param {{method?: string, body?: string, alive?: boolean}} request - what arrived.
 * @returns {{status: number, event?: object}} status, plus the event for 200.
 */
function planInput(request) {
  if (request?.method !== 'POST') return { status: 405 }
  const body = String(request?.body ?? '')
  if (Buffer.byteLength(body, 'utf8') > MAX_INPUT_BYTES) return { status: 413 }
  let raw = null
  try {
    raw = JSON.parse(body === '' ? '{}' : body)
  } catch {
    return { status: 500 }
  }
  if (request?.alive !== true) return { status: 503 }
  const event = buildEvent(raw)
  if (event === null) return { status: 400 }
  return { status: 200, event }
}

module.exports = { MAX_INPUT_BYTES, buildEvent, keyCodeOf, keyEvents, modifiersOf, planInput }
