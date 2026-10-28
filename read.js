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
  /* A drawing surface has no words in the tree, but it is the whole page in
     some products: number it, and let a picture be taken of it. */
  'canvas',
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
    const pointing = String(el.getAttribute?.('aria-labelledby') ?? '')
    const named = pointing.split(/\s+/).filter(Boolean).map((id) => {
      const other = el.ownerDocument.getElementById(id)
      return other === null ? '' : String(other.innerText ?? other.textContent ?? '')
    }).join(' ').replace(/\s+/g, ' ').trim()
    const own = named || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.getAttribute?.('placeholder') || ''
    const text = String(el.innerText ?? '').replace(/\\s+/g, ' ').trim()
    const value = el.tagName === 'INPUT' && el.type !== 'password' ? String(el.value ?? '') : ''
    if (el.tagName === 'CANVAS' && label === '' && own === '' && text === '' && value === '') {
      const b = el.getBoundingClientRect()
      return 'drawing ' + Math.round(b.width) + 'x' + Math.round(b.height)
    }
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
  /* A page with almost no words and one big picture is answering with the
     picture. Say so here, in the same round trip, so a model that cannot open
     files still learns that something came back: and sample it small to tell a
     blank chart from a chart. */
  const picture = (() => {
    if (full >= 40) return null
    let best = null
    const missing = []
    for (const el of document.querySelectorAll('img,canvas')) {
      const b = box(el)
      /* A picture that failed to arrive shrinks to an error icon, so its own
         declared size is what the page meant to show. */
      const askW = Number(el.getAttribute?.('width')) || 0
      const askH = Number(el.getAttribute?.('height')) || 0
      const wide = Math.max(b.width, askW)
      const high = Math.max(b.height, askH)
      if (wide < 64 || high < 64 || wide * high < 8000) continue
      const s = getComputedStyle(el)
      if (s.visibility === 'hidden' || s.display === 'none') continue
      /* A picture slot that never got its picture is the commonest way a
         generated image goes missing, and it is silent by default. */
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) {
        missing.push({ width: Math.round(wide), height: Math.round(high) })
        missing[missing.length - 1].name = String(el.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
        continue
      }
      const w = el.tagName === 'CANVAS' ? el.width : el.naturalWidth || Math.round(b.width)
      const h = el.tagName === 'CANVAS' ? el.height : el.naturalHeight || Math.round(b.height)
      if (best === null || w * h > best.w * best.h) best = { el, w, h, kind: String(el.tagName).toLowerCase() }
    }
    if (best === null) return missing.length === 0 ? null : { missing }
    /* What the read hands back about one picture: not a screen of fields. */
    const said = { name: String(best.el.getAttribute?.('alt') ?? best.el.getAttribute?.('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) }
    said.kind = best.kind
    said.width = best.w
    said.height = best.h
    said.colors = 0
    said.flat = 0
    try {
      const board = document.createElement('canvas')
      board.width = 32
      board.height = 32
      const pen = board.getContext('2d', { willReadFrequently: true })
      if (pen === null) return said
      pen.drawImage(best.el, 0, 0, 32, 32)
      const dots = pen.getImageData(0, 0, 32, 32).data
      const tally = new Map()
      for (let at = 0; at < dots.length; at += 4) {
        const key = (dots[at] >> 5) * 64 + (dots[at + 1] >> 5) * 8 + (dots[at + 2] >> 5)
        tally.set(key, (tally.get(key) || 0) + 1)
      }
      let most = 0
      for (const count of tally.values()) most = Math.max(most, count)
      said.colors = tally.size
      said.flat = Math.round((most / 1024) * 100) / 100
    } catch {
      /* A picture from elsewhere cannot be sampled: report its size only. */
    }
    return said
  })()
  /* What no amount of text will tell the reader: the screen shows something
     that has no words in the tree. Counted here so every read can say it. */
  const blind = (() => {
    const out = { pictures: 0, canvases: 0, videos: 0, frames: 0 }
    const speaks = (el) => {
      const said = String(el.getAttribute?.('alt') ?? '').trim() || String(el.getAttribute?.('aria-label') ?? '').trim() || String(el.getAttribute?.('title') ?? '').trim()
      if (said.length > 1) return true
      let near = el.closest?.('figure, picture')
      if (near) {
        const words = String(near.querySelector?.('figcaption')?.textContent ?? '').trim()
        if (words.length > 1) return true
      }
      return false
    }
    const shows = (el) => {
      const b = box(el)
      if (b.width < 48 || b.height < 48) return false
      if (!inView(b)) return false
      const st = getComputedStyle(el)
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05
    }
    for (const el of document.querySelectorAll('img')) {
      if (!shows(el) || speaks(el)) continue
      out.pictures += 1
    }
    for (const el of document.querySelectorAll('canvas')) if (shows(el)) out.canvases += 1
    for (const el of document.querySelectorAll('video')) if (shows(el)) out.videos += 1
    /* A tracking pixel of a frame is not something the reader is missing: only
       frames that occupy the screen are worth a sentence. */
    for (const el of document.querySelectorAll('iframe')) if (shows(el)) out.frames += 1
    return out
  })()
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
    picture,
    blind,
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

/**
 * Click the control the page itself registered, instead of moving the mouse to
 * it. A page whose own handlers want a click, or a control an overlay covers,
 * is reachable this way; a page that watches real pointer movement is not.
 * @param {number} ref - ref from a read.
 * @param {{double?: boolean, right?: boolean}} [options] - how to click.
 * @returns {string} an expression that answers with what it hit.
 */
export function clickInDom(ref, options = {}) {
  const double = options.double === true
  const right = options.right === true
  return `(() => {
  const reg = window.${REGISTRY}
  const hit = reg && reg.find(${Number(ref)})
  if (!hit) return JSON.stringify({ ok: false, gone: true })
  const el = hit.el
  const name = String(el.innerText ?? el.value ?? el.getAttribute?.('aria-label') ?? '').trim().slice(0, 60)
  try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* a detached node has no place */ }
  try { el.focus({ preventScroll: true }) } catch { /* not every node takes focus */ }
  const send = (type, button) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button, buttons: type === 'mousedown' || type === 'pointerdown' ? (button === 2 ? 2 : 1) : 0 }))
  if (${right}) {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }))
  } else {
    send('pointerdown', 0)
    send('mousedown', 0)
    el.click ? el.click() : send('click', 0)
    if (${double}) { el.click ? el.click() : send('click', 0) }
    send('pointerup', 0)
    send('mouseup', 0)
  }
  return JSON.stringify({ ok: true, name, tag: String(el.tagName).toLowerCase() })
})()`
}

/**
 * Put text into a control through the page's own value and input events, the
 * way the page's own code would; no key is pressed and no pointer moves.
 * @param {number} ref - ref from a read.
 * @param {string} text - what to put in.
 * @param {{clear?: boolean, submit?: boolean}} [options] - replace, and send it.
 * @returns {string} an expression that answers with the field's new value.
 */
export function writeInDom(ref, text, options = {}) {
  return `(() => {
  const reg = window.${REGISTRY}
  const hit = reg && reg.find(${Number(ref)})
  if (!hit) return JSON.stringify({ ok: false, gone: true })
  const el = hit.el
  const whole = ${JSON.stringify(String(text))}
  const clear = ${options.clear === true}
  const submit = ${options.submit === true}
  try { el.focus({ preventScroll: true }) } catch { /* a plain div takes no focus */ }
  if (/^(input|textarea)$/i.test(el.tagName)) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = clear ? whole : String(el.value ?? '') + whole
    set === undefined ? (el.value = next) : set.call(el, next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    el.textContent = clear ? whole : String(el.textContent ?? '') + whole
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: whole, inputType: 'insertText' }))
  } else {
    return JSON.stringify({ ok: false, why: 'not a field' })
  }
  if (submit) {
    const form = el.form ?? el.closest?.('form') ?? null
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit()
    else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
  }
  return JSON.stringify({ ok: true, value: String(el.value ?? el.textContent ?? '').slice(0, 60) })
})()`
}

/**
 * How big the control is and where it sits, so a picture can be of it alone.
 * @param {number} ref - ref from a read.
 * @returns {string} an expression that answers with the rectangle.
 */
export function bounds(ref) {
  return `(() => {
  const reg = window.${REGISTRY}
  if (!reg) return JSON.stringify({ gone: true })
  const hit = reg.find(${Number(ref)})
  if (!hit) return JSON.stringify({ gone: true })
  const el = hit.el
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' })
  const b = el.getBoundingClientRect()
  if (b.width < 2 || b.height < 2) return JSON.stringify({ gone: true, off: true })
  return JSON.stringify({ gone: false, x: b.left, y: b.top, width: b.width, height: b.height })
})()`
}

/**
 * The pictures on the page, as files a person can open.
 * A generated image or a chart is often the whole answer, and there is no
 * wording in the tree that stands for it: take the picture itself.
 * @param {number} [ref] - only pictures at or inside this control.
 * @param {number} [count] - how many, largest first. Default 1.
 * @returns {string} an expression that answers with `{pictures: [...]}`.
 */
export function pictures(ref, count) {
  const scope = Number(ref)
  const limit = Math.max(1, Math.min(4, Number(count) || 1))
  return `(async () => {
  const reg = window.${REGISTRY}
  const where = ${Number.isFinite(scope) ? `(reg ? (reg.find(${scope}) || {}).el : null)` : 'null'}
  const picked = []
  const seen = new Set()
  const add = (el, kind) => {
    if (el === null || el === undefined || seen.has(el)) return
    seen.add(el)
    const b = el.getBoundingClientRect()
    const w = kind === 'canvas' ? el.width : kind === 'video' ? el.videoWidth || b.width : el.naturalWidth || b.width
    const h = kind === 'canvas' ? el.height : kind === 'video' ? el.videoHeight || b.height : el.naturalHeight || b.height
    if (w < 48 || h < 48) return
    if (b.width < 8 || b.height < 8) return
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return
    picked.push({ el, kind, w, h, area: w * h })
  }
  const roots = where ? [where, ...where.querySelectorAll('*')] : [document, ...document.querySelectorAll('*')]
  for (const node of roots) {
    if (node === document || node === where) continue
    const tag = node.tagName
    if (tag === 'IMG') add(node, 'img')
    else if (tag === 'CANVAS') add(node, 'canvas')
    /* A paused video is the frame the person is looking at; it never arrives as
       an image file, so it has to be drawn out of the element. */
    else if (tag === 'VIDEO' && (node.videoWidth || 0) > 0) add(node, 'video')
  }
  if (where && where.tagName === 'IMG') add(where, 'img')
  if (where && where.tagName === 'CANVAS') add(where, 'canvas')
  if (where && where.tagName === 'VIDEO' && (where.videoWidth || 0) > 0) add(where, 'video')
  picked.sort((a, b) => b.area - a.area)
  /* A picture nobody can look at still has to be describable: how much of it is
     one colour tells a blank chart from a chart. Sampled at 32x32, which is
     enough for that and costs nothing. */
  const look = async (data) => {
    try {
      const img = new Image()
      img.src = data
      await img.decode()
      const board = document.createElement('canvas')
      board.width = 32
      board.height = 32
      const pen = board.getContext('2d', { willReadFrequently: true })
      if (pen === null) return null
      pen.drawImage(img, 0, 0, 32, 32)
      const dots = pen.getImageData(0, 0, 32, 32).data
      const tally = new Map()
      for (let at = 0; at < dots.length; at += 4) {
        const key = (dots[at] >> 5) * 64 + (dots[at + 1] >> 5) * 8 + (dots[at + 2] >> 5)
        tally.set(key, (tally.get(key) || 0) + 1)
      }
      let most = 0
      for (const count of tally.values()) most = Math.max(most, count)
      return { colors: tally.size, flat: Math.round((most / 1024) * 100) / 100 }
    } catch {
      return null
    }
  }
  const out = []
  for (const item of picked.slice(0, ${limit})) {
    let data = ''
    let type = 'image/png'
    try {
      if (item.kind === 'canvas' || item.kind === 'video') {
        /* Same path for both: a video frame is copied onto a board and read as
           a picture. Nothing here needs the video to be playing. */
        const board = document.createElement('canvas')
        board.width = Math.max(1, Math.round(item.w))
        board.height = Math.max(1, Math.round(item.h))
        const pen = board.getContext('2d')
        pen.drawImage(item.el, 0, 0, board.width, board.height)
        data = board.toDataURL('image/png')
      } else {
        const url = item.el.currentSrc || item.el.src || ''
        const answer = await fetch(url, { credentials: 'include' })
        const blob = await answer.blob()
        type = blob.type || type
        data = await new Promise((done, fail) => {
          const reader = new FileReader()
          reader.onload = () => done(String(reader.result))
          reader.onerror = () => fail(new Error('unreadable'))
          reader.readAsDataURL(blob)
        })
      }
    } catch {
      data = ''
    }
    const feel = data ? await look(data) : null
    out.push({ kind: item.kind, width: item.w, height: item.h, type, data, colors: feel?.colors ?? 0, flat: feel?.flat ?? 0 })
  }
  return JSON.stringify({ pictures: out })
})()`
}

/**
 * What sits on top of a control at click time, when it is not the control.
 * A cookie banner or a modal over the thing the agent meant to click is the
 * commonest quiet failure on real pages: the click lands, nothing happens.
 * @param {number} ref - ref from a read.
 * @returns {string} an expression that answers `{tag, text, dismiss}` or an empty string.
 */
export function covering(ref) {
  return `(() => {
  const reg = window.${REGISTRY}
  if (!reg) return ''
  const hit = reg.find(${Number(ref)})
  if (!hit) return ''
  const el = hit.el
  const b = el.getBoundingClientRect()
  const x = Math.round(b.left + b.width / 2)
  const y = Math.round(b.top + b.height / 2)
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return ''
  const top = document.elementFromPoint(x, y)
  if (top === null || top === el || el.contains(top) || top.contains(el)) return ''
  const raw = String(top.innerText ?? top.value ?? top.getAttribute?.('aria-label') ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  /* The thing in the way usually carries its own way out, and taking it is the
     step the agent would take next anyway. Find that control while the overlay
     is already being measured, so clearing it costs no extra round trip. The
     words are a narrow safe list on purpose: an overlay that offers to delete,
     pay or confirm is reported, never dismissed on the person's behalf. */
  let scope = top
  for (let node = top.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    const r = node.getBoundingClientRect()
    if (r.width >= innerWidth * 0.6 && r.height >= innerHeight * 0.5) scope = node
  }
  const box = scope.getBoundingClientRect()
  const wide = box.width >= innerWidth * 0.6 && box.height >= innerHeight * 0.5
  const claimed = String(scope.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 400)
  const risky = /(delete|remove|purchase|payment|pay now|buy now|sign out|log out|transfer|删除|支付|购买|付款|注销|退出登录|转账)/i.test(claimed)
  const words = /^(accept|accept all|agree|allow|allow all|ok|okay|got it|close|dismiss|i agree|接受|同意|允许|允许全部|关闭|确定|知道了|好的)$/i
  let dismiss = null
  if (wide && !risky) {
    const cands = scope.querySelectorAll('button,[role=button],a,input[type=button],input[type=submit]')
    for (const node of [scope, ...cands]) {
      if (node === el || el.contains(node) || node.contains(el)) continue
      const name = String(node.innerText ?? node.value ?? node.getAttribute?.('aria-label') ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40)
      if (name === '' || !words.test(name)) continue
      const r = node.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue
      dismiss = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), name }
      break
    }
  }
  return JSON.stringify({ tag: String(top.tagName).toLowerCase(), text: raw, dismiss })
})()`
}

/** Where refs of controls inside iframes start. Main-frame refs stay small. */
const FRAME_BASE = 900_000

/** Room for the refs of one frame between FRAME_BASE steps. */
const FRAME_SLOT = 100_000

/** A frame is addressed either by its world or by the session of its own process. */
function asRoute(route) {
  if (route === undefined || route === null) return {}
  if (typeof route === 'number') return { contextId: route }
  return route
}

/**
 * Evaluate in a page, in one frame of it, or in the process of a frame Chrome
 * keeps apart.
 * @param {any} page - sidecar page.
 * @param {string} expression - JavaScript.
 * @param {number|{contextId?: number, sessionId?: string}} [route] - where to run it.
 * @returns {Promise<any>} the JSON-safe value.
 */
async function evaluateIn(page, expression, route) {
  const where = asRoute(route)
  const params = { expression, returnByValue: true }
  if (where.contextId !== undefined) params.contextId = where.contextId
  const { result } = await page.cdp.send('Runtime.evaluate', params, where.sessionId)
  return result?.value
}

/** @param {any} page - sidecar page. @param {any} [route] - world to seed. */
async function seedPage(page, route) {
  await evaluateIn(page, seed(SELECTOR, VERSION), route)
}

/**
 * @param {any} page - sidecar page.
 * @param {string} mode - read mode.
 * @param {number} budget - text budget.
 * @param {number} max - control cap.
 * @param {any} [route] - world to read.
 * @returns {Promise<any>} the snapshot.
 */
async function evaluateSnapshot(page, mode, budget, max, route) {
  const raw = String((await evaluateIn(page, snapshot(mode, budget, max), route)) ?? '{}')
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
 * @param {{slot?: number, contextId?: number, sessionId?: string}} route - the frame.
 * @returns {Promise<{x: number, y: number}>} the offset.
 */
async function frameOffset(page, route) {
  const where = asRoute(route)
  if (where.contextId !== undefined) {
    const own = await evaluateIn(page, `(() => { try {
      const frame = window.frameElement
      if (!frame) return null
      const b = frame.getBoundingClientRect()
      return { x: Math.round(b.left), y: Math.round(b.top) }
    } catch (error) { return null } })()`, where)
    if (own !== null && own !== undefined && Number.isFinite(own.x)) return own
  }
  if (where.frameId !== undefined && typeof page.frameBox === 'function') {
    const own = await page.frameBox(where.frameId).catch(() => null)
    if (own !== null) return own
  }
  const index = Math.max(0, Number(where.slot ?? 1) - 1)
  const fallback = await evaluateIn(page, `(() => {
    const frame = document.querySelectorAll('iframe')[${index}]
    if (!frame) return null
    const b = frame.getBoundingClientRect()
    return { x: Math.round(b.left), y: Math.round(b.top) }
  })()`)
  if (fallback !== null && fallback !== undefined && Number.isFinite(fallback.x)) return fallback
  return { x: 0, y: 0 }
}

/**
 * Where a frame's refs live: its slot in the frame tree, and how to reach it —
 * by world when it shares the page's process, by session when Chrome runs it
 * apart.
 * @param {any} page - sidecar page.
 * @param {any} frame - one entry from the frame list.
 * @param {number} slot - its position under the main frame.
 * @returns {{slot: number, contextId?: number, sessionId?: string, frameId?: string}|null} the route.
 */
function routeOf(page, frame, slot) {
  const sessionId = frame.contextId === undefined && typeof page.childSession === 'function' ? page.childSession(frame.frameId) : undefined
  if (frame.contextId === undefined && sessionId === undefined) return null
  return { slot, contextId: frame.contextId, sessionId, frameId: frame.frameId }
}

/**
 * Read the frames under the page, so a control inside an iframe is numbered
 * like any other. A frame Chrome runs in its own process is read through the
 * session of that process; the corner it sits at still comes from the page.
 * @param {any} page - sidecar page.
 * @param {string} mode - read mode.
 * @param {number} budget - characters of text to keep.
 * @returns {Promise<{text: string, controls: any[], frames: number}>} what the frames add.
 */
async function readFrames(page, mode, budget) {
  if (typeof page.frameList !== 'function') return { text: '', controls: [], frames: 0 }
  let frames = []
  try {
    frames = await page.frameList()
  } catch (error) {
    return { text: '', controls: [], frames: 0 }
  }
  const children = frames.slice(1)
  const controls = []
  let text = ''
  for (let slot = 0; slot < children.length && slot < 8; slot += 1) {
    const route = routeOf(page, children[slot], slot + 1)
    if (route === null) continue
    try {
      await seedPage(page, route)
      const inside = await evaluateSnapshot(page, mode, Math.min(budget, 600), 40, route)
      if (inside?.broken === true) continue
      const offset = await frameOffset(page, route)
      const tag = FRAME_BASE + slot * FRAME_SLOT
      for (const item of inside.controls ?? []) {
        controls.push({ ...item, ref: tag + Number(item.ref), frame: slot + 1, x: Number(item.x ?? 0) + offset.x, y: Number(item.y ?? 0) + offset.y })
      }
      if (text.length < 400 && typeof inside.text === 'string' && inside.text !== '') text += `${text === '' ? '' : '\n'}${inside.text.slice(0, 400)}`
    } catch (error) {
      continue
    }
  }
  return { text, controls, frames: children.length }
}

/** Decode a ref into the frame it lives in and the number that frame knows. */
function splitFrameRef(ref) {
  const number = Number(ref)
  if (!Number.isFinite(number) || number < FRAME_BASE) return null
  const slot = Math.floor((number - FRAME_BASE) / FRAME_SLOT)
  return { slot, local: number - FRAME_BASE - slot * FRAME_SLOT }
}

/**
 * Where a ref lives, for a tool that has to look the element up itself.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref from a read.
 * @returns {Promise<{slot: number, local: number, contextId?: number, sessionId?: string, frameId?: string}|null>} the route, or nothing for the page itself.
 */
export async function contextFor(page, ref) {
  const split = splitFrameRef(ref)
  if (split === null) return null
  if (typeof page.frameList !== 'function') return null
  const frames = await page.frameList().catch(() => [])
  const frame = frames[split.slot + 1]
  if (frame === undefined) return null
  const route = routeOf(page, frame, split.slot + 1)
  if (route === null) return null
  return { ...route, local: split.local }
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
    picture: read?.picture ?? null,
    scroll: read?.scroll,
    focused: read?.focused ?? null,
    controls: Array.isArray(read?.controls) ? read.controls : [],
    blind: blindSpots(read?.blind, framed.frames),
  }
}

/**
 * Merge what the page counted with what the frame reader managed to see.
 * @param {any} said - counts from the page.
 * @param {number} [read] - frames that answered.
 * @returns {{pictures: number, canvases: number, videos: number, frames: number}} what text cannot show.
 */
export function blindSpots(said, read) {
  const n = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0)
  /* The page knows which frames take up the screen; the frame reader knows how
     many exist, tracking pixels included. The screen is what the reader is
     missing, so its count wins whenever the page could count at all. */
  const frames = said !== undefined && said !== null && said.frames !== undefined ? n(said.frames) : n(read)
  return { pictures: n(said?.pictures), canvases: n(said?.canvases), videos: n(said?.videos), frames }
}

/**
 * Resolve a ref into a point, at the moment of the action.
 * @param {any} page - sidecar page.
 * @param {number} ref - ref from a read.
 * @returns {Promise<{gone: boolean, x?: number, y?: number, name?: string, kind?: string, off?: boolean, hidden?: boolean, disabled?: boolean}>} where it is now.
 */
/**
 * Whether a number still means what it meant when it was read.
 *
 * A page can keep the same element and change its words: "Send" becomes
 * "Stop", a row is reused for another order. Pressing the old number then
 * does something the person never asked for.
 * @param {any} known - the control the read handed out.
 * @param {any} spot - what the number resolves to now.
 * @returns {string} what changed, or '' when it is the same control.
 */
export function differs(known, spot) {
  if (known === undefined || known === null || spot === undefined || spot === null) return ''
  const before = String(known.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  const now = String(spot.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
  if (before === '' || now === '' || before === now) return ''
  const head = Math.min(12, before.length, now.length)
  if (head >= 4 && (before.slice(0, head) === now.slice(0, head) || before.includes(now.slice(0, head)) || now.includes(before.slice(0, head)))) return ''
  return `that number now points at "${now}" instead of "${before}" — read the page again and use the new number.`
}

export async function locate(page, ref) {
  const split = splitFrameRef(ref)
  let route = null
  if (split !== null) {
    route = await contextFor(page, ref)
    if (route === null) return { gone: true }
  }
  const said = await evaluateIn(page, resolve(split === null ? ref : route.local), route).catch(() => undefined)
  let spot = { gone: true }
  try {
    spot = JSON.parse(String(said ?? '{"gone":true}'))
  } catch (error) {
    spot = { gone: true }
  }
  if (split === null || spot.gone === true) return spot
  const offset = await frameOffset(page, route)
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
  /* A browser error page is not a site with nothing on it: it is a site that
     never arrived. Saying so is the only way the reader stops looking for the
     content that would have been there. */
  if (String(read.url).startsWith('chrome-error://')) lines.push('the page did not load — sidecar_nav to open the address again, or sidecar_open if the browser is gone')
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
  if (read.blind !== undefined && read.blind !== null) {
    const bits = []
    if (read.blind.pictures > 0) bits.push(`${read.blind.pictures} picture(s) with no words`)
    if (read.blind.canvases > 0) bits.push(`${read.blind.canvases} drawing surface(s)`)
    if (read.blind.videos > 0) bits.push(`${read.blind.videos} video(s)`)
    if (read.blind.frames > 0) bits.push(`${read.blind.frames} embedded frame(s)`)
    /* Only when something is actually out of reach: a line saying "nothing is
       hidden" on every read is a line the reader learns to skip. */
    if (bits.length > 0) lines.push(`text cannot show: ${bits.join(', ')} — sidecar_grab takes the picture, sidecar_shot shows the screen`)
  }
  if (read.picture && Array.isArray(read.picture.missing)) {
    /* Something was meant to be here and is not: say that instead of nothing. */
    for (const gone of read.picture.missing.slice(0, 2)) {
      const size = `${Math.round(Number(gone.width) || 0)}x${Math.round(Number(gone.height) || 0)}`
      lines.push(`picture ${size}${gone.name === '' ? '' : ` "${gone.name}"`} did not load — the page may need a reload, or the picture is gone`)
    }
  } else if (read.picture) {
    const pic = read.picture
    const look = Number(pic.flat) >= 0.9 ? 'mostly one colour' : Number(pic.colors) <= 3 ? 'a few colours' : 'a picture with detail'
    const size = `${Math.round(Number(pic.width) || 0)}x${Math.round(Number(pic.height) || 0)}`
    lines.push(`picture ${size} ${look}${pic.name === '' ? '' : ` "${pic.name}"`} — sidecar_grab saves it as a file`)
  }
  if (read.scroll && read.scroll.height > read.scroll.viewport + 40) {
    lines.push(`scroll ${read.scroll.y}/${read.scroll.height - read.scroll.viewport}`)
  }
  return lines.join('\n').slice(0, Math.max(600, maxChars) + 600)
}

/** A ref that was valid on the previous read and is no longer here. */
export const REF_GONE = 'That control is gone: the page changed since the read. Call sidecar_view and use the new number.'

/**
 * The control itself, not its number: what it is, what it is called, and where
 * it sat. Kept from the read that produced the ref so a re-render can be
 * survived without asking the person to read the page again.
 * @param {any} control - a control from a read.
 * @returns {{kind: string, name: string, href: string, inert: boolean}} what to look for.
 */
export function identityOf(control) {
  const kind = String(control?.kind ?? '')
  const name = String(control?.name ?? '')
  const href = String(control?.href ?? '')
  const inert = ['input', 'select', 'textarea', 'password', 'search', 'email', 'number', 'tel', 'url', 'date'].includes(kind)
  return { kind, name, href, inert }
}

/**
 * Whether a control read now is the one described by an identity: the same
 * words, and not a container that happens to contain them.
 * @param {{kind: string, name: string, href: string, inert: boolean}} want - identity.
 * @param {any} control - a control from the current read.
 * @returns {boolean} true when this is the same control.
 */
export function sameThing(want, control) {
  /* Nothing to look for is not a licence to click whatever is nearest. */
  if (want.name === '') return false
  if (String(control?.name ?? '') !== want.name) return false
  if (String(control?.kind ?? '') !== want.kind) return false
  /* A field and the button beside it can share their words; a field never
     becomes a button, so the kind must match exactly rather than loosely. */
  if (want.inert && !['input', 'select', 'textarea', 'search', 'email', 'number', 'tel', 'url', 'date'].includes(String(control?.kind ?? ''))) return false
  if (want.href !== '' && String(control?.href ?? '') !== want.href) return false
  return true
}

/** The in-page half shared by `labelSpot` and `selectSpot`: shadow roots, what says what. */
const NAME_PRELUDE = `
  const roots = [document]
  for (const el of document.querySelectorAll('*')) {
    if (roots.length > 400) break
    if (el.shadowRoot) roots.push(el.shadowRoot)
  }
  const norm = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim()
  const short = (s) => { const t = norm(s); return t !== '' && t.length <= 80 ? t : '' }
  const editable = (el) => {
    const tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true
    if (tag === 'INPUT') {
      const type = String(el.type ?? 'text').toLowerCase()
      return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(type)
    }
    if (el.isContentEditable === true) return true
    return ['textbox', 'searchbox', 'combobox'].includes(String(el.getAttribute('role') ?? ''))
  }
  const shown = (el) => {
    const b = el.getBoundingClientRect()
    if (b.width < 2 || b.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const names = (el) => {
    const out = []
    const add = (v) => { const t = short(v); if (t !== '') out.push(t) }
    if (el.labels) for (const l of el.labels) add(l.innerText ?? l.textContent)
    for (const id of String(el.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter(Boolean)) {
      const other = document.getElementById(id)
      if (other) add(other.innerText ?? other.textContent)
    }
    add(el.getAttribute('aria-label'))
    add(el.getAttribute('placeholder'))
    add(el.getAttribute('title'))
    if (el.id) for (const l of document.querySelectorAll('label[for]')) if (l.htmlFor === el.id) add(l.innerText ?? l.textContent)
    const prev = el.previousElementSibling
    if (prev && editable(prev) !== true) add(prev.innerText ?? prev.textContent)
    const parent = el.parentElement
    if (parent && parent.querySelectorAll('input,textarea,select,[contenteditable=true]').length <= 1) add(parent.innerText ?? parent.textContent)
    /* Wrapped a couple of levels deep (a styled box hiding a real input), the
       words sit before the wrapper, not before the input. */
    let up = parent
    for (let depth = 0; depth < 3 && up; depth += 1) {
      const before = up.previousElementSibling
      if (before && editable(before) !== true) add(before.innerText ?? before.textContent)
      up = up.parentElement
    }
    /* The attribute is the last resort for a name on screen: it is often the
       developer's word for the field, not the one the user reads. */
    add(el.getAttribute('name'))
    return out
  }
  const squeeze = (s) => String(s).toLowerCase().replace(/\s+/g, '')
  const scored = (el, want) => {
    let score = 0
    let name = ''
    const flat = squeeze(want)
    for (const nm of names(el)) {
      const low = nm.toLowerCase()
      if (low === want || squeeze(low) === flat) score = Math.max(score, 3)
      else if (want.length >= 2 && low.includes(want)) score = Math.max(score, 2)
      else if (flat.length >= 2 && squeeze(low).includes(flat)) score = Math.max(score, 2)
      else if (low.length >= 3 && want.includes(low)) score = Math.max(score, 1)
      if (score > 0 && name === '') name = nm
    }
    return { score, name }
  }
  const boxOf = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const b = node.getBoundingClientRect()
      if (b.width < 8 || b.height < 8) continue
      const s = getComputedStyle(node)
      if (s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05) return b
    }
    return null
  }
  const bestOf = (selector, want, hiddenOk) => {
    let best = null
    for (const root of roots) {
      for (const el of root.querySelectorAll(selector)) {
        if (hiddenOk !== true && shown(el) !== true) continue
        const hit = scored(el, want)
        if (hit.score === 0) continue
        if (best === null || hit.score > best.score) best = { el, score: hit.score, name: hit.name }
      }
    }
    return best
  }
`

/**
 * The field a label belongs to, when nothing formally connects the two.
 * ...
 */
/**
 * The field a label belongs to, when nothing formally connects the two.
 *
 * `{field: "Email"}` used to mean "click the control that says Email". On a real
 * form the words live in a div above a bare input, so the click landed on the
 * text and the typing went wherever focus already was — the classic silent wrong
 * field. This finds the *editable* element the words point at: a real label, an
 * aria name, a placeholder, a name attribute, the text right before it, or the
 * text of the small wrapper it sits in.
 * @param {string} words - what the field is called.
 * @returns {string} an expression that evaluates to a spot, or {} when nothing fits.
 */
export function labelSpot(words) {
  const wanted = JSON.stringify(String(words ?? '').toLowerCase())
  return `(() => {
  const want = ${wanted}
  if (want === '') return JSON.stringify({})
  ${NAME_PRELUDE}
  const selector = 'input,textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]'
  let best = bestOf(selector, want)
  let box = best === null ? null : boxOf(best.el)
  let behind = false
  if (best === null || box === null) {
    /* The field a date picker shows is often a transparent box over a styled
       div: the input stays out of sight, but the words still name it. */
    const under = bestOf(selector, want, true)
    const place = under === null ? null : boxOf(under.el)
    if (under !== null && place !== null) { best = under; box = place; behind = true }
  }
  if (best === null || box === null) return JSON.stringify({})
  if (editable(best.el) !== true) return JSON.stringify({})
  best.el.scrollIntoView({ block: 'center', inline: 'nearest' })
  const fresh = boxOf(best.el) ?? box
  return JSON.stringify({ x: Math.round(fresh.left + fresh.width / 2), y: Math.round(fresh.top + fresh.height / 2), name: best.name, score: best.score, behind })
})()`
}

/**
 * The dropdown the words belong to, with the wanted option already chosen.
 * @param {string} words - what the dropdown is called on screen.
 * @param {string} value - option label or value.
 * @returns {string} an expression that picks the option and says what it did.
 */
export function selectSpot(words, value) {
  const wanted = JSON.stringify(String(words ?? '').toLowerCase())
  const wanted2 = JSON.stringify(String(value ?? ''))
  return `(() => {
  const want = ${wanted}
  const wanted = ${wanted2}
  if (want === '') return 'no dropdown was named'
  ${NAME_PRELUDE}
  const best = bestOf('select', want)
  if (best === null) return 'no dropdown says ' + JSON.stringify(want)
  const select = best.el
  const option = Array.from(select.options).find((item) => item.value === wanted || item.text.trim() === wanted || item.text.trim().toLowerCase() === wanted.toLowerCase())
  if (!option) return 'no option ' + wanted + ' in ' + best.name + '; options are ' + Array.from(select.options).slice(0, 12).map((item) => item.text.trim()).join(' | ')
  select.value = option.value
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return 'chose ' + option.text.trim() + ' in ' + best.name
})()`
}
