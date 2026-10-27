/**
 * The read model: what the page is, said in as few tokens as the truth allows.
 *
 * Two rules shape this file.
 *
 * 1. A number means the same control twice. Playwright MCP and browser-use both
 *    hand out refs, and both pay for it by making the model re-read after every
 *    action. Here the page keeps a registry, so a ref survives a read, a
 *    checkbox and a tool boundary; only a navigation drops it, and a click on a
 *    dead ref says so instead of clicking something else.
 *
 * 2. Text is read from the viewport, not the document. A 60-paragraph article
 *    is 2.4k tokens if the whole page is printed. The person is looking at a
 *    screenful, the model is acting on a screenful, and scrolling is a call it
 *    can make on purpose.
 */

/** Name of the page-side registry. */
const REGISTRY = '__dshRead'

/** Bumped when the page-side half changes, so a stale page is re-seeded. */
const VERSION = 2

/** Interactive elements worth numbering, in the order a reader would meet them. */
const SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="textbox"]',
  '[role="searchbox"]',
].join(',')

/** How a role is written in the compact read: short enough to cost little. */
const SIGIL = { // ui-copy-ignore
  a: 'link', // ui-copy-ignore
  button: 'btn', // ui-copy-ignore
  input: 'input', // ui-copy-ignore
  select: 'select', // ui-copy-ignore
  textarea: 'textarea', // ui-copy-ignore
  summary: 'summary', // ui-copy-ignore
  label: 'label', // ui-copy-ignore
  role: 'role', // ui-copy-ignore
}

/**
 * The page-side half. Installed on every read; it is a no-op when the registry
 * is already there, which is what makes refs survive reads.
 * @param {string} selector - interactive selector.
 * @param {number} version - registry version.
 * @returns {string} an expression to evaluate.
 */
function seed(selector, version) {
  return `(() => {
  const w = window
  const current = w.${REGISTRY}
  if (current && current.version === ${version}) return 'kept'
  const refs = new Map()
  const ids = new WeakMap()
  let seq = 0
  w.${REGISTRY} = {
    version: ${version},
    refs,
    /**
     * Give an element the number it already has, or the next free one.
     * @param {Element} el - element to number.
     * @returns {number} its ref.
     */
    id(el) {
      const known = ids.get(el)
      if (known !== undefined && refs.get(known) === el) return known
      seq += 1
      ids.set(el, seq)
      refs.set(seq, el)
      return seq
    },
    /** @param {Element} el - element to forget. */
    drop(el) {
      const known = ids.get(el)
      if (known !== undefined) refs.delete(known)
    },
    /**
     * @param {number} ref - number from a read.
     * @returns {{el: Element, ref: number} | null} the element, if still here.
     */
    find(ref) {
      const el = refs.get(ref)
      if (!el || !el.isConnected) { refs.delete(ref); return null }
      return { el, ref }
    },
    selector: ${JSON.stringify(selector)},
  }
  return 'seeded'
})()`
}

/**
 * Read the page. One evaluate, one JSON, no round trip per control.
 * @param {string} mode - what to include: text, links, forms, full.
 * @param {number} budget - characters of page text to keep.
 * @param {number} max - controls to number at most.
 * @returns {string} an expression to evaluate.
 */
function snapshot(mode, budget, max) {
  const wanted = JSON.stringify(mode)
  return `(() => {
  const reg = window.${REGISTRY}
  if (!reg) return JSON.stringify({ broken: true })
  const mode = ${wanted}
  const budget = ${budget}
  const max = ${max}
  const name = (el) => {
    const label = el.labels && el.labels[0] ? String(el.labels[0].innerText ?? '') : ''
    const own = el.getAttribute?.('aria-label') ?? el.getAttribute?.('title') ?? el.getAttribute?.('placeholder') ?? ''
    const text = String(el.innerText ?? '').replace(/\\s+/g, ' ').trim()
    const value = el.tagName === 'INPUT' && el.type !== 'password' ? String(el.value ?? '') : ''
    return String(label || own || text || value || el.getAttribute?.('alt') || el.getAttribute?.('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 140)
  }
  const box = (el) => el.getBoundingClientRect()
  const shown = (el) => {
    const b = box(el)
    if (b.width < 2 || b.height < 2) return false
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none') return false
    if (Number(s.opacity) <= 0.05) return false
    return true
  }
  const inView = (b) => b.bottom > 0 && b.right > 0 && b.top < innerHeight && b.left < innerWidth
  /* Web components keep their controls in a shadow root, where
     querySelectorAll on the document never looks. Open roots are collected
     first, so a control inside one is numbered like any other. */
  const roots = [document]
  for (let i = 0; i < roots.length; i += 1) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot)
    }
  }
  const each = (fn) => {
    for (const root of roots) for (const el of root.querySelectorAll(reg.selector)) fn(el)
  }
  const role = (el) => {
    const explicit = el.getAttribute?.('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = String(el.type ?? 'text')
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'search') return type
      return 'input'
    }
    return tag
  }
  const controls = []
  const seen = new Set()
  each((el) => {
    if (controls.length >= max * 3) return
    const b = box(el)
    if (b.width < 2 || b.height < 2) return
    if (!shown(el)) return
    const label = name(el)
    if (label === '' && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') return
    const kind = role(el)
    if (mode === 'links' && kind !== 'link') return
    if (mode === 'forms' && kind !== 'input' && kind !== 'select' && kind !== 'textarea' && kind !== 'btn' && kind !== 'button' && kind !== 'combobox' && kind !== 'checkbox' && kind !== 'radio') return
    const view = inView(b)
    /* Offscreen controls are numbered but sorted last: the person is acting on
       what is on screen, and a scroll should not renumber everything. */
    controls.push({
      ref: reg.id(el),
      kind,
      name: label,
      value: el.tagName === 'INPUT' && el.type !== 'password' ? String(el.value ?? '').slice(0, 80) : '',
      checked: el.checked === true,
      disabled: el.disabled === true || el.getAttribute?.('aria-disabled') === 'true',
      view,
      x: Math.round(b.left + b.width / 2),
      y: Math.round(b.top + b.height / 2),
      href: kind === 'link' ? String(el.href ?? '').slice(0, 120) : '',
    })
    seen.add(el)
  })
  /* Refs that pointed at elements now gone are dropped, so a later number
     cannot quietly mean a different control. */
  for (const ref of Array.from(reg.refs.keys())) {
    const el = reg.refs.get(ref)
    if (!el || !el.isConnected) reg.refs.delete(ref)
  }
  controls.sort((a, b) => Number(b.view) - Number(a.view))
  /* Only the first screenful and a bit is worth a line each: an offscreen
     control is a scroll away, and a hundred dead rows cost the reader tokens. */
  const picked = controls.slice(0, max)
  const parts = []
  let used = 0
  let full = 0
  const take = (text) => {
    if (text === '') return
    full += text.length
    if (used >= budget) return
    const room = budget - used
    parts.push(room >= text.length ? text : text.slice(0, room))
    used += Math.min(room, text.length)
  }
  const main = document.querySelector('main, article, [role="main"]') ?? document.body
  const texts = [main, ...roots.slice(1)]
  if (mode !== 'links' && mode !== 'forms') {
    const emitted = new Set()
    for (const root of texts) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = String(node.nodeValue ?? '').replace(/\\s+/g, ' ').trim()
        const parent = node.parentElement
        if (text === '' || !parent || emitted.has(parent)) continue
        const b = box(parent)
        const style = getComputedStyle(parent)
        const fits = style.display !== 'none' && style.visibility !== 'hidden' && b.width > 1 && b.height > 1
        if (!fits || !inView(b)) continue
        emitted.add(parent)
        take(text)
        if (parent.tagName === 'P' || parent.tagName === 'DIV' || parent.tagName === 'LI' || /^H[1-6]$/.test(parent.tagName)) take('\\n')
      }
    }
  }
  return JSON.stringify({
    url: location.href, // ui-copy-ignore
    title: document.title, // ui-copy-ignore
    text: parts.join(' ').replace(/\\n /g, '\\n').replace(/ {2,}/g, ' ').trim(),
    textChars: full,
    scroll: { y: Math.round(scrollY), height: Math.round(document.documentElement.scrollHeight), viewport: Math.round(innerHeight) },
    focused: (() => { // ui-copy-ignore
      const el = document.activeElement
      if (!el || el === document.body) return null
      return { ref: reg.id(el), kind: role(el), name: name(el) }
    })(),
    controls: picked,
  })
})()`
}

/**
 * Resolve a ref at action time, so a page that moved under the last read is
 * clicked where the control is now, not where it was.
 * @param {number} ref - ref from a read.
 * @returns {string} an expression to evaluate.
 */
export function resolve(ref) {
  return `(() => {
  const reg = window.${REGISTRY}
  if (!reg) return JSON.stringify({ gone: true })
  const hit = reg.find(${Number(ref)})
  if (!hit) return JSON.stringify({ gone: true })
  const el = hit.el
  const b = el.getBoundingClientRect()
  if (b.width < 2 || b.height < 2) return JSON.stringify({ gone: true, off: true })
  if (b.top < 0 || b.left < 0 || b.bottom > innerHeight || b.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center' })
  const after = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return JSON.stringify({ gone: false, x: Math.round(after.left + after.width / 2), y: Math.round(after.top + after.height / 2), name: String(el.innerText ?? el.value ?? el.getAttribute?.('aria-label') ?? '').trim().slice(0, 80), kind: String(el.tagName).toLowerCase(), hidden: s.visibility === 'hidden' || s.display === 'none', disabled: el.disabled === true })
})()`
}

/** Where refs of controls inside iframes start. Main-frame refs stay small. */
const FRAME_BASE = 900_000

/** Room for the refs of one frame between FRAME_BASE steps. */
const FRAME_SLOT = 100_000

/**
 * Evaluate in a page or in one frame of it.
 * @param {any} page - sidecar page.
 * @param {string} expression - JavaScript.
 * @param {number} [contextId] - world to run in; the main frame when absent.
 * @returns {Promise<any>} the JSON-safe value.
 */
async function evaluateIn(page, expression, contextId) {
  const params = { expression, returnByValue: true }
  if (contextId !== undefined) params.contextId = contextId
  const { result } = await page.cdp.send('Runtime.evaluate', params)
  return result?.value
}

/** @param {any} page - sidecar page. @param {number} [contextId] - world to seed. */
async function seedPage(page, contextId) {
  await evaluateIn(page, seed(SELECTOR, VERSION), contextId)
}

/**
 * @param {any} page - sidecar page.
 * @param {string} mode - read mode.
 * @param {number} budget - text budget.
 * @param {number} max - control cap.
 * @param {number} [contextId] - world to read.
 * @returns {Promise<any>} the snapshot.
 */
async function evaluateSnapshot(page, mode, budget, max, contextId) {
  const raw = String((await evaluateIn(page, snapshot(mode, budget, max), contextId)) ?? '{}')
  try {
    return JSON.parse(raw)
  } catch {
    return { broken: true }
  }
}

/**
 * Where an iframe sits on the page. A ref inside a frame is resolved against
 * the frame's own viewport, so its point needs the frame's corner added.
 * @param {any} page - sidecar page.
 * @param {number} contextId - the frame world.
 * @param {number} slot - which child frame it is, for the fallback.
 * @returns {Promise<{x: number, y: number}>} the offset.
 */
async function frameOffset(page, contextId, slot) {
  const own = await evaluateIn(page, `(() => { try {
    const frame = window.frameElement
    if (!frame) return null
    const b = frame.getBoundingClientRect()
    return { x: Math.round(b.left), y: Math.round(b.top) }
  } catch (error) { return null } })()`, contextId)
  if (own !== null && own !== undefined && Number.isFinite(own.x)) return own
  const fallback = await evaluateIn(page, `(() => {
    const frame = document.querySelectorAll('iframe')[${Number(slot)}]
    if (!frame) return null
    const b = frame.getBoundingClientRect()
    return { x: Math.round(b.left), y: Math.round(b.top) }
  })()`)
  if (fallback !== null && fallback !== undefined && Number.isFinite(fallback.x)) return fallback
  return { x: 0, y: 0 }
}

/**
 * Read the frames under the page, so a control inside an iframe is numbered
 * like any other. Same-origin frames are read directly; a frame without a
 * context of its own (a cross-origin child Chrome runs elsewhere) is skipped,
 * and its controls stay reachable by clicking the frame itself.
 * @param {any} page - sidecar page.
 * @param {string} mode - read mode.
 * @param {number} budget - characters of text to keep.
 * @returns {Promise<{text: string, controls: any[]}>} what the frames add.
 */
async function readFrames(page, mode, budget) {
  if (typeof page.frameList !== 'function') return { text: '', controls: [] }
  let frames = []
  try {
    frames = await page.frameList()
  } catch (error) {
    return { text: '', controls: [] }
  }
  const children = frames.slice(1)
  const controls = []
  let text = ''
  for (let slot = 0; slot < children.length && slot < 8; slot += 1) {
    const child = children[slot]
    if (child.contextId === undefined) continue
    try {
      await seedPage(page, child.contextId)
      const inside = await evaluateSnapshot(page, mode, Math.min(budget, 600), 40, child.contextId)
      if (inside?.broken === true) continue
      const offset = await frameOffset(page, child.contextId, slot)
      const tag = FRAME_BASE + slot * FRAME_SLOT
      for (const item of inside.controls ?? []) {
        controls.push({ ...item, ref: tag + Number(item.ref), frame: slot + 1, x: Number(item.x ?? 0) + offset.x, y: Number(item.y ?? 0) + offset.y })
      }
      if (text.length < 400 && typeof inside.text === 'string' && inside.text !== '') text += `${text === '' ? '' : '\n'}${inside.text.slice(0, 400)}`
    } catch (error) {
      continue
    }
  }
  return { text, controls }
}

/** Decode a ref into the frame it lives in and the number that frame knows. */
function splitFrameRef(ref) {
  const number = Number(ref)
  if (!Number.isFinite(number) || number < FRAME_BASE) return null
  const slot = Math.floor((number - FRAME_BASE) / FRAME_SLOT)
  return { slot, local: number - FRAME_BASE - slot * FRAME_SLOT }
}

/**
 * The world a ref lives in, for a tool that has to look the element up itself.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref from a read.
 * @returns {Promise<number|undefined>} the context id, or nothing for the page.
 */
export async function contextFor(page, ref) {
  const split = splitFrameRef(ref)
  if (split === null || typeof page.frameList !== 'function') return undefined
  const frames = await page.frameList().catch(() => [])
  return frames[split.slot + 1]?.contextId
}

/**
 * Read the page and hand back the shape the renderer wants.
 * @param {any} page - sidecar page.
 * @param {{mode?: string, maxChars?: number, max?: number}} [options] - how much to read.
 * @returns {Promise<{url: string, title: string, text: string, textChars: number, scroll?: any, focused?: any, controls: any[]}>} the read.
 */
export async function readPage(page, options = {}) {
  const mode = String(options.mode ?? 'text')
  const maxChars = Number.isFinite(Number(options.maxChars)) ? Math.max(400, Math.min(24_000, Number(options.maxChars))) : 6000
  const max = Number.isFinite(Number(options.max)) ? Math.max(5, Math.min(200, Number(options.max))) : 90
  await seedPage(page)
  let read = await evaluateSnapshot(page, mode, maxChars, max)
  if (read?.broken === true) {
    await seedPage(page)
    read = await evaluateSnapshot(page, mode, maxChars, max)
  }
  const framed = await readFrames(page, mode, Math.min(maxChars, 1200))
  if (framed.controls.length > 0) read = { ...read, controls: [...(read.controls ?? []), ...framed.controls] }
  if (framed.text !== '') read = { ...read, text: `${String(read.text ?? '')}${String(read.text ?? '') === '' ? '' : '\n'}${framed.text}` }
  return {
    url: String(read?.url ?? page.url),
    title: String(read?.title ?? page.title),
    text: String(read?.text ?? ''),
    textChars: Number(read?.textChars ?? 0),
    scroll: read?.scroll,
    focused: read?.focused ?? null,
    controls: Array.isArray(read?.controls) ? read.controls : [],
  }
}

/**
 * Resolve a ref into a point, at the moment of the action.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref from a read.
 * @returns {Promise<{gone: boolean, x?: number, y?: number, name?: string, kind?: string, off?: boolean, hidden?: boolean, disabled?: boolean}>} where it is now.
 */
export async function locate(page, ref) {
  const split = splitFrameRef(ref)
  let contextId
  if (split !== null) {
    contextId = await contextFor(page, ref)
    if (contextId === undefined) return { gone: true }
  }
  const said = await evaluateIn(page, resolve(split === null ? ref : split.local), contextId).catch(() => undefined)
  let spot = { gone: true }
  try {
    spot = JSON.parse(String(said ?? '{"gone":true}'))
  } catch (error) {
    spot = { gone: true }
  }
  if (split === null || spot.gone === true) return spot
  const offset = await frameOffset(page, contextId, split.slot)
  return { ...spot, x: Number(spot.x ?? 0) + offset.x, y: Number(spot.y ?? 0) + offset.y }
}

/** Roles that read better without a sigil. */
function sigilOf(control) {
  const kind = String(control.kind ?? '')
  if (kind === 'link') return 'link'
  if (kind === 'button') return 'btn'
  if (kind === 'input' || kind === 'search') return 'input'
  if (kind === 'checkbox' || kind === 'radio') return kind
  return SIGIL[kind] ?? kind ?? 'el'
}

/**
 * Render a read as compact text, controls first, then the viewport's words.
 * @param {{url: string, title: string, text: string, textChars: number, scroll?: any, focused?: any, controls: any[]}} read - page read.
 * @param {{mode?: string, maxChars?: number}} [options] - how it was read.
 * @returns {string} the text a model sees.
 */
export function renderPage(read, options = {}) {
  const mode = String(options.mode ?? 'text')
  const maxChars = Number(options.maxChars ?? 6000)
  const lines = [read.url]
  if (read.title !== '') lines.push(`# ${read.title}`)
  const shown = read.controls.filter((control) => control.view !== false || mode === 'full')
  const hidden = read.controls.length - shown.length
  for (const control of shown) {
    let line = `${control.ref} [${sigilOf(control)}] ${control.name === '' ? '(unnamed)' : control.name}`
    if (control.kind === 'checkbox' || control.kind === 'radio') line += control.checked ? ' (checked)' : ' (unchecked)'
    else if (control.value !== '' && control.value !== control.name) line += ` = ${control.value}`
    if (control.disabled) line += ' (disabled)'
    if (mode === 'links' && control.href !== '') line += ` → ${control.href}`
    lines.push(line)
  }
  if (hidden > 0 && mode !== 'links' && mode !== 'forms') lines.push(`… ${hidden} more controls off screen`)
  if (read.focused) lines.push(`focus ${read.focused.ref} [${read.focused.kind}] ${read.focused.name}`)
  const body = read.text
  if (body !== '') {
    lines.push('')
    lines.push(body)
    if (read.textChars > body.length) lines.push(`… ${read.textChars - body.length} more characters`)
  }
  if (read.scroll && read.scroll.height > read.scroll.viewport + 40) {
    lines.push(`scroll ${read.scroll.y}/${read.scroll.height - read.scroll.viewport}`)
  }
  return lines.join('\n').slice(0, Math.max(600, maxChars) + 600)
}

/** A ref that was valid on the previous read and is no longer here. */
export const REF_GONE = 'That control is gone: the page changed since the read. Call sidecar_view and use the new number.'
