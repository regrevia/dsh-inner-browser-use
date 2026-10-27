/**
 * The model-facing half: what a call can do to the sidecar browser, and what it
 * says back.
 *
 * Two costs decide whether this is usable: the tokens a read spends, and the
 * round trips a task spends. The tool surface here is shaped around both — a
 * read can be narrowed (`mode`, `max_chars`) and diffed (`changed_only`), and
 * `sidecar_do` runs a run of steps in one call with waits that know when a page
 * has settled.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { VIEW } from './sidecar.js?v=1'
import { readPage, renderPage, locate, contextFor, REF_GONE } from './read.js?v=1'

/** Where a screenshot from `sidecar_shot` lands, under the user's home. */
export const SHOT_DIR = join('.dsh-inner-browser-use', 'screenshots')

/** Shown when the sidecar has never been started in this run. */
export const SIDECAR_OFF = 'The sidecar browser is not running. Call sidecar_open with the address first.'

/** Output schema every tool returns. */
const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  /**
   * @param {unknown} _args - call arguments, unused.
   * @param {unknown} value - tool value.
   * @returns {Array<{type: string, text: string}>} blocks.
   */
  render(_args, value) {
    return [{ type: 'text', text: String(value?.text ?? '') }]
  },
}


/**
 * One line about where the page now is. A step that worked says so in a few
 * words; the model reads the page only when it needs to, which is most of the
 * saving over reading after every action.
 * @param {any} page - sidecar page.
 * @returns {Promise<string>} address, title, focus and any open dialog.
 */
async function brief(page) {
  const dialog = page.dialog
  if (dialog !== null && dialog !== undefined) {
    return `${String(page.url ?? '')} · dialog ${String(dialog.type ?? '')}: ${String(dialog.message ?? '')}`
  }
  const info = await evaluate(page, `(() => {
    const a = document.activeElement
    const focus = a !== null && a !== document.body && a !== document.documentElement
      ? { name: String(a.getAttribute('aria-label') || a.getAttribute('placeholder') || (a.labels && a.labels[0] && a.labels[0].innerText) || a.innerText || a.name || a.tagName).trim().slice(0, 60), value: String(a.value === undefined ? '' : a.value).slice(0, 60) }
      : null
    return { url: location.href, title: document.title.slice(0, 80), focus }
  })()`)
  const bits = [String(info?.url ?? '')]
  if (String(info?.title ?? '') !== '') bits.push(String(info.title))
  if (info?.focus) bits.push(`focus ${info.focus.name}${info.focus.value === '' ? '' : ` = ${info.focus.value}`}`)
  return bits.join(' · ')
}

/**
 * What an action returns: a short line, or the whole read when asked for one.
 * @param {any} page - sidecar page.
 * @param {any} args - tool arguments.
 * @param {() => Promise<string>} look - full read.
 * @param {string} label - what was done.
 * @returns {Promise<string>} reply text.
 */
async function acted(page, args, look, label) {
  if (args?.read === true) return await look()
  return `ok ${label} · ${await brief(page)}`
}

/**
 * Say the network failed, instead of reading Chrome's own error page as if it
 * were the site. Those pages mention proxies and firewalls, which is not what
 * the person asked about.
 * @param {any} page - sidecar page.
 * @returns {string} a sentence, or an empty string when the page is real.
 */
function unreachable(page) {
  const url = String(page.url ?? '')
  if (!url.startsWith('chrome-error://') && !url.startsWith('edge-error://')) return ''
  return `the network could not reach that address — the browser stopped on a network error page (${String(page.title ?? 'no details')}). Check the address, or the proxy this machine needs.`
}

/** Key names this driver can press, spelled as a model would. */
export const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

/**
 * Press a key: keyDown, then keyUp, with the character when the key types one.
 * @param {any} page - sidecar page.
 * @param {string} name - key name.
 * @param {number} [modifiers] - CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
 * @returns {Promise<void>} done.
 */
export async function pressKey(page, name, modifiers = 0) {
  const key = KEYS[name] ?? KEYS[name.charAt(0).toUpperCase() + name.slice(1)]
  if (key === undefined) throw new Error(`sidecar: no such key ${name}`) // ui-copy-ignore
  const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers }
  await page.key('keyDown', key.text === undefined ? base : { ...base, text: key.text })
  await page.key('keyUp', base)
}

/** @param {number} ms - how long. */
function wait(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}

/**
 * Evaluate an expression and return its value, JSON-safe.
 * @param {any} page - sidecar page.
 * @param {string} expression - JavaScript.
 * @param {{contextId?: number, sessionId?: string}|null} [route] - frame to run in.
 * @returns {Promise<any>} the value.
 */
async function evaluate(page, expression, route) {
  const params = { expression, returnByValue: true, awaitPromise: true }
  if (route?.contextId !== undefined) params.contextId = route.contextId
  const call = page.cdp.send('Runtime.evaluate', params, route?.sessionId)
  const raced = await Promise.race([call, wait(2000).then(() => 'timeout')])
  if (raced === 'timeout') return undefined
  const { result, exceptionDetails } = raced
  if (exceptionDetails !== undefined) {
    return { error: String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed') }
  }
  return result?.value
}

/**
 * Wait until the page has settled: loading finished and the address stopped
 * changing. Acting on a page mid-navigation is how a driver clicks the old page.
 * @param {any} page - sidecar page.
 * @param {number} [timeout] - ceiling in milliseconds.
 * @returns {Promise<string>} the address it settled on.
 */
export async function settle(page, timeout = 5000) {
  /* A click may have opened a tab. The mirror follows it, so every tool that
     waited on a page ends up on the page the person would be looking at. */
  const opened = typeof page.adoptOpened === 'function' ? await page.adoptOpened().catch(() => '') : ''
  const deadline = Date.now() + timeout
  let last = ''
  let steady = 0
  while (Date.now() < deadline) {
    if (page.dialog !== null && page.dialog !== undefined) return String(page.url ?? '')
    const state = await evaluate(page, '({ ready: document.readyState, href: location.href })')
    const key = `${String(state?.ready)}|${String(state?.href)}`
    steady = key === last ? steady + 1 : 0
    last = key
    if (state?.ready !== 'loading' && steady >= 2) return String(state?.href ?? '')
    await wait(60)
  }
  return ''
}

/**
 * Poll the page until a condition holds.
 * @param {any} page - sidecar page.
 * @param {string} expression - a JavaScript expression that is true when done.
 * @param {number} timeout - ceiling in milliseconds.
 * @returns {Promise<boolean>} whether it ever held.
 */
async function until(page, expression, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await evaluate(page, expression)
    if (value === true) return true
    await wait(100)
  }
  return false
}

/**
 * One step of a batch. Kept small on purpose: every step is one thing a person
 * would do with a mouse or a keyboard.
 * @param {any} page - sidecar page.
 * @param {any} step - the step.
 * @returns {Promise<string>} a compact report.
 */
async function runStep(page, step) {
  if (step.ref !== undefined) {
    const spot = await locate(page, Number(step.ref))
    if (spot.gone === true) return `ref ${String(step.ref)}: ${REF_GONE}`
    if (step.tap !== undefined) {
      const point = { x: Number(spot.x), y: Number(spot.y) }
      await page.mouse('mouseMoved', point)
      await page.mouse('mousePressed', { ...point, clickCount: 1 })
      await page.mouse('mouseReleased', { ...point, clickCount: 1 })
      return `clicked ${String(step.ref)} ${String(spot.name ?? '')}`.trim()
    }
    if (step.text !== undefined) {
      const point = { x: Number(spot.x), y: Number(spot.y) }
      await page.mouse('mouseMoved', point)
      await page.mouse('mousePressed', { ...point, clickCount: 1 })
      await page.mouse('mouseReleased', { ...point, clickCount: 1 })
      await wait(80)
      await page.insertText(String(step.text))
      if (step.submit === true) await pressKey(page, 'Enter')
      return `typed into ${String(step.ref)} ${String(spot.name ?? '')}`.trim()
    }
  }
  if (step.tap !== undefined) {
    const [x, y] = String(step.tap).split(',').map(Number)
    const point = { x, y }
    await page.mouse('mouseMoved', point)
    await page.mouse('mousePressed', { ...point, clickCount: 1 })
    await page.mouse('mouseReleased', { ...point, clickCount: 1 })
    return `clicked ${String(x)},${String(y)}`
  }
  if (step.text !== undefined) {
    await page.insertText(String(step.text))
    if (step.submit === true) await pressKey(page, 'Enter')
    return `typed ${String(step.text).slice(0, 60)}`
  }
  if (step.key !== undefined) {
    await pressKey(page, String(step.key))
    return `pressed ${String(step.key)}`
  }
  if (step.scroll !== undefined) {
    const dy = Number(step.scroll)
    await page.wheel({ x: VIEW.width / 2, y: VIEW.height / 2, dy })
    return `scrolled ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}`
  }
  if (step.wait_text !== undefined) {
    const needle = JSON.stringify(String(step.wait_text))
    const ok = await until(page, `document.body ? document.body.innerText.includes(${needle}) : false`, Number(step.timeout ?? 8000))
    return ok ? `saw ${String(step.wait_text)}` : `did not see ${String(step.wait_text)}`
  }
  if (step.wait_gone !== undefined) {
    const needle = JSON.stringify(String(step.wait_gone))
    const ok = await until(page, `document.body ? !document.body.innerText.includes(${needle}) : true`, Number(step.timeout ?? 8000))
    return ok ? `${String(step.wait_gone)} went away` : `${String(step.wait_gone)} stayed`
  }
  if (step.wait_url !== undefined) {
    const needle = JSON.stringify(String(step.wait_url))
    const ok = await until(page, `location.href.includes(${needle})`, Number(step.timeout ?? 8000))
    return ok ? `at ${String(step.wait_url)}` : `still at a different address`
  }
  if (step.open !== undefined) {
    const landed = await page.navigate(String(step.open))
    return `opened ${landed?.url ?? String(step.open)}`
  }
  if (step.eval !== undefined) {
    const value = await evaluate(page, String(step.eval))
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `eval ${String(text).slice(0, 300)}`
  }
  if (step.sleep_ms !== undefined) {
    await wait(Math.min(10_000, Number(step.sleep_ms)))
    return `waited ${String(step.sleep_ms)} ms`
  }
  if (step.wait_idle !== undefined) {
    await settle(page, Number(step.timeout ?? 5000))
    return 'idle'
  }
  return 'nothing to do'
}

/**
 * Read the page and keep the previous read, so `changed_only` has something to
 * compare against.
 * @param {any} page - sidecar page.
 * @param {{refs: any[], at: number, last?: any}} refs - read state for this page.
 * @param {{mode?: string, maxChars?: number}} options - narrowing.
 * @returns {Promise<any>} the read.
 */
async function remember(page, refs, options) {
  const read = await readPage(page, options)
  refs.refs = read.controls
  refs.at = Date.now()
  return read
}

/**
 * Say only what changed since the previous read.
 * @param {any} previous - the read before.
 * @param {any} next - the read now.
 * @param {{maxChars?: number}} options - narrowing.
 * @returns {string} a diff, small by construction.
 */
export function diffRead(previous, next, options = {}) {
  const maxChars = Number(options.maxChars ?? 2000)
  const before = new Map(previous.controls.map((control) => [control.ref, control]))
  const after = new Map(next.controls.map((control) => [control.ref, control]))
  const lines = [next.url]
  if (previous.url !== next.url) lines.push(`address changed to ${next.url}`)
  const added = next.controls.filter((control) => !before.has(control.ref))
  const removed = previous.controls.filter((control) => !after.has(control.ref))
  const changed = next.controls.filter((control) => {
    const old = before.get(control.ref)
    if (old === undefined) return false
    return old.name !== control.name || old.value !== control.value || old.checked !== control.checked || old.disabled !== control.disabled
  })
  for (const control of added.slice(0, 40)) lines.push(`+ ${control.ref} [${control.kind}] ${control.name}`)
  for (const control of removed.slice(0, 40)) lines.push(`- ${control.ref} ${control.name}`)
  for (const control of changed.slice(0, 40)) {
    const old = before.get(control.ref)
    lines.push(`~ ${control.ref} ${control.name}${old?.value !== control.value ? `: ${old?.value ?? ''} → ${control.value}` : ''}${old?.checked !== control.checked ? (control.checked ? ' (now checked)' : ' (now unchecked)') : ''}`)
  }
  if (added.length + removed.length + changed.length === 0) lines.push('no control changed')
  if (previous.text !== next.text) {
    const head = next.text.slice(0, Math.max(200, Math.min(1200, maxChars - 800)))
    lines.push('', 'text now:', head)
    if (next.text.length > head.length) lines.push(`… ${next.text.length - head.length} more characters`)
  }
  if (next.focused !== null && previous.focused?.ref !== next.focused.ref) lines.push(`focus ${next.focused.ref} ${next.focused.name}`)
  return lines.join('\n')
}

/**
 * The tool surface.
 * @param {any} sidecar - the sidecar browser.
 * @param {{refs: any[], at: number, last?: any}} refs - read state.
 * @param {{logger?: any}} [host] - host services. // ui-copy-ignore
 * @returns {any[]} tool definitions.
 */
export function sidecarTools(sidecar, refs, host = {}) { // ui-copy-ignore
  const withPage = async (work) => {
    if (!sidecar.alive) return { text: SIDECAR_OFF }
    const page = await sidecar.ensure()
    return { text: await work(page) }
  }
  const look = (page, options) => remember(page, refs, options).then((read) => renderPage(read, options))
  return [
    {
      name: 'sidecar_open', // ui-copy-ignore
      description: 'Start (or reuse) the sidecar browser — a real Chrome with its own persistent profile — and open a URL in it. It runs in the background and its screen appears in this chat\'s sidebar tab, so it keeps working while the person looks elsewhere. Logins survive restarts.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open. Omit to reuse the current page.' },
          headless: { type: 'boolean', description: 'Run without a window. Default true; turn off only if a site refuses a windowless browser.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @param {any} exec - tool run. @returns {Promise<{text: string}>} what the page is. */
      execute: async (args, exec) => {
        const page = await sidecar.ensure({ url: args?.url, headless: args?.headless })
        if (args?.url === undefined) await page.readTitle()
        /* The tab appears in the calling chat and nowhere else: the person may
           be reading a different chat, and a browser there would be a surprise. */
        const who = String(exec?.agent?.id ?? '')
        if (who !== '') host.want?.(who) // ui-copy-ignore
        await settle(page, 8000)
        const dead = unreachable(page)
        if (dead !== '') return { text: dead }
        return { text: await look(page, { mode: 'text' }) }
      },
    },
    {
      name: 'sidecar_view', // ui-copy-ignore
      description: 'Read the sidecar browser: numbered controls and the words on screen. Numbers stay valid across reads and actions until the page navigates. Narrow it with mode (text, links, forms, full) and max_chars; ask for changed_only after an action to spend fewer tokens.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          mode: { type: 'string', enum: ['text', 'links', 'forms', 'full'], description: 'What to include. Default text: controls plus the visible words.' },
          max_chars: { type: 'integer', description: 'Character budget for the page text. Default 6000.' },
          changed_only: { type: 'boolean', description: 'Only what changed since the last read.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the read. */
      execute: async (args) => withPage(async (page) => {
        const options = { mode: String(args?.mode ?? 'text'), maxChars: Number(args?.max_chars ?? 4600) }
        const read = await remember(page, refs, options)
        if (args?.changed_only === true && refs.last !== undefined) return diffRead(refs.last, read, options)
        refs.last = read
        return renderPage(read, options)
      }),
    },
    {
      name: 'sidecar_click', // ui-copy-ignore
      description: 'Click a numbered control, a point, or the first control whose words contain `text` — the last needs no read first. The click is real mouse input and the mirror shows where it landed.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from sidecar_view.' },
          text: { type: 'string', description: 'Words on the control, when its number is not known.' },
          x: { type: 'integer', description: 'Viewport x, when clicking a point.' },
          y: { type: 'integer', description: 'Viewport y, when clicking a point.' },
          double: { type: 'boolean', description: 'Double-click.' },
          right: { type: 'boolean', description: 'Right-click, opening a context menu.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        let point = { x: Number(args?.x ?? NaN), y: Number(args?.y ?? NaN) }
        let label = args?.ref === undefined ? `${point.x},${point.y}` : String(args.ref)
        if (args?.ref !== undefined) {
          const spot = await locate(page, Number(args.ref))
          if (spot.gone === true) return REF_GONE
          point = { x: Number(spot.x), y: Number(spot.y) }
        } else if (String(args?.text ?? '') !== '') {
          const words = String(args.text)
          const read = await readPage(page, { mode: 'text', maxChars: 1200, max: 200 })
          const shown = read.controls.filter((control) => control.view !== false)
          const wanted = words.toLowerCase()
          const hit = shown.find((control) => control.name.toLowerCase() === wanted) ?? shown.find((control) => control.name.toLowerCase().includes(wanted))
          if (hit === undefined) return `No control says ${JSON.stringify(words)}. Call sidecar_view to see what is there.`
          const spot = await locate(page, hit.ref)
          if (spot.gone === true) return REF_GONE
          point = { x: Number(spot.x), y: Number(spot.y) }
          label = `"${hit.name.slice(0, 60)}"`
        }
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return 'Give a ref from sidecar_view, or both x and y.'
        const button = args?.right === true ? 'right' : 'left'
        await page.mouse('mouseMoved', point)
        await page.mouse('mousePressed', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        await page.mouse('mouseReleased', { ...point, clickCount: args?.double === true ? 2 : 1, button })
        await settle(page)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 3000 }), `click ${label}`)
      }),
    },
    {
      name: 'sidecar_type', // ui-copy-ignore
      description: 'Type text into the sidecar browser — Chinese included — optionally pressing Enter. Pass a ref to focus that control first. With clear, the field is emptied first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to type.' },
          ref: { type: 'integer', description: 'Control to click before typing.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          clear: { type: 'boolean', description: 'Select all and delete before typing.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['text'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        if (args?.ref !== undefined) {
          const spot = await locate(page, Number(args.ref))
          if (spot.gone === true) return REF_GONE
          const point = { x: Number(spot.x), y: Number(spot.y) }
          await page.mouse('mouseMoved', point)
          await page.mouse('mousePressed', { ...point, clickCount: 1 })
          await page.mouse('mouseReleased', { ...point, clickCount: 1 })
          await wait(80)
        }
        if (args?.clear === true) {
          await page.key('keyDown', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
          await page.key('keyUp', { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
          await pressKey(page, 'Backspace')
        }
        await page.insertText(String(args?.text ?? ''))
        if (args?.submit === true) await pressKey(page, 'Enter')
        await settle(page)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), 'type') // ui-copy-ignore
      }),
    },
    {
      name: 'sidecar_key', // ui-copy-ignore
      description: 'Press one key in the sidecar browser: Enter, Tab, Escape, Backspace, Delete, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Home, End, PageUp, PageDown, Space.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          key: { type: 'string', description: 'Key name.' },
          modifiers: { type: 'string', description: 'Held while pressing: Ctrl, Alt, Shift or Meta, joined by +.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['key'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const name = String(args?.key ?? 'Enter')
        const held = String(args?.modifiers ?? '')
        const mods = (held.includes('Alt') ? 1 : 0) + (held.includes('Ctrl') ? 2 : 0) + (held.includes('Meta') ? 4 : 0) + (held.includes('Shift') ? 8 : 0)
        await pressKey(page, name, mods)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `key ${name}`)
      }),
    },
    {
      name: 'sidecar_scroll', // ui-copy-ignore
      description: 'Scroll the sidecar browser by wheel at its centre (negative goes up), then return what it shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          dy: { type: 'integer', description: 'Wheel delta: 600 is about a screen down.' },
          x: { type: 'integer', description: 'Viewport x for the wheel.' },
          y: { type: 'integer', description: 'Viewport y for the wheel.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        await page.wheel({ x: Number(args?.x ?? VIEW.width / 2), y: Number(args?.y ?? VIEW.height / 2), dy: Number(args?.dy ?? 600) })
        await wait(200)
        const delta = Number(args?.dy ?? 600)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 4000 }), `scroll ${delta > 0 ? '+' : ''}${delta}`)
      }),
    },
    {
      name: 'sidecar_hover', // ui-copy-ignore
      description: 'Move the pointer onto a numbered control, so hover-only menus and tooltips open, then return what the page shows.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number from sidecar_view.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        required: ['ref'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const spot = await locate(page, Number(args?.ref))
        if (spot.gone === true) return REF_GONE
        const cursor = await page.hover({ x: Number(spot.x), y: Number(spot.y) })
        await wait(400)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2500 }), `hover ${String(args?.ref)} · ${cursor}`)
      }),
    },
    {
      name: 'sidecar_nav', // ui-copy-ignore
      description: 'Change the sidecar browser\'s address: open a url, go back, go forward, or reload. Use this instead of clicking the browser chrome.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Address to open.' },
          back: { type: 'boolean', description: 'Go back one history entry.' },
          forward: { type: 'boolean', description: 'Go forward one entry.' },
          reload: { type: 'boolean', description: 'Reload the current page.' },
          read: { type: 'boolean', description: 'Read the page after the action, instead of a one-line confirmation.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 60_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        if (typeof args?.url === 'string' && args.url !== '') await page.navigate(args.url)
        else if (args?.back === true) await page.history(-1)
        else if (args?.forward === true) await page.history(1)
        else if (args?.reload === true) await page.reload()
        else return 'Give a url, or ask to go back, forward or reload.'
        await settle(page, 8000)
        const dead = unreachable(page)
        if (dead !== '') return dead
        return acted(page, args, () => look(page, { mode: 'text' }), 'navigate') // ui-copy-ignore
      }),
    },
    {
      name: 'sidecar_do', // ui-copy-ignore
      description: 'Run several steps in one call and report one compact result: the whole of "click search, type a query, press Enter, wait for results" is one call instead of five. Steps run in order and stop at the first that cannot proceed. Each step: {ref, tap | text, submit}, {tap: "x,y"}, {text}, {key}, {scroll}, {wait_text}, {wait_gone}, {wait_url}, {wait_idle}, {eval}, {open}, {sleep_ms}. Waits know when the page has settled.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          steps: { // ui-copy-ignore
            type: 'array', // ui-copy-ignore
            description: 'Steps, in order.',
            items: { // ui-copy-ignore
              type: 'object', // ui-copy-ignore
              properties: {
                ref: { type: 'integer', description: 'Control number for tap or text.' },
                tap: { type: 'string', description: 'Click: a ref number, or "x,y".' },
                text: { type: 'string', description: 'Type this text (into ref, or wherever focus is).' },
                submit: { type: 'boolean', description: 'Press Enter after typing.' },
                key: { type: 'string', description: 'Key name.' },
                scroll: { type: 'integer', description: 'Wheel delta.' },
                wait_text: { type: 'string', description: 'Wait for this text to appear.' },
                wait_gone: { type: 'string', description: 'Wait for this text to disappear.' },
                wait_url: { type: 'string', description: 'Wait for the address to contain this.' },
                wait_idle: { type: 'boolean', description: 'Wait for the page to settle.' },
                eval: { type: 'string', description: 'Run JavaScript in the page.' },
                open: { type: 'string', description: 'Open an address.' },
                sleep_ms: { type: 'integer', description: 'Wait a fixed time.' },
                timeout: { type: 'integer', description: 'Ceiling for this step\'s wait, in milliseconds.' },
              },
              additionalProperties: false,
            },
          },
          read: { type: 'string', enum: ['none', 'text', 'links', 'forms', 'changed'], description: 'What to read at the end. Default text.' },
          max_chars: { type: 'integer', description: 'Character budget for that final read.' },
        },
        required: ['steps'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 180_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what happened and the page after. */
      execute: async (args) => withPage(async (page) => {
        const steps = Array.isArray(args?.steps) ? args.steps : []
        if (steps.length === 0) return 'Give at least one step.'
        const report = []
        for (const [index, step] of steps.entries()) {
          const said = await runStep(page, step ?? {})
          report.push(`${index + 1}. ${said}`)
          if (/^ref \d+: That control is gone/.test(said)) return `${report.join('\n')}\nStopped: the page changed. Call sidecar_view and use the new numbers.`
          if (step?.sleep_ms === undefined && step?.wait_text === undefined && step?.wait_gone === undefined && step?.wait_url === undefined && step?.wait_idle === undefined) {
            await settle(page, Number(step?.timeout ?? 5000))
          }
        }
        const mode = String(args?.read ?? 'text')
        if (mode === 'none') return report.join('\n')
        const options = { mode: mode === 'changed' ? 'text' : mode, maxChars: Number(args?.max_chars ?? 3000) }
        const read = await remember(page, refs, options)
        if (mode === 'changed' && refs.last !== undefined) {
          const diff = diffRead(refs.last, read, options)
          refs.last = read
          return `${report.join('\n')}\n${diff}`
        }
        refs.last = read
        return `${report.join('\n')}\n\n${renderPage(read, options)}`
      }),
    },
    {
      name: 'sidecar_eval', // ui-copy-ignore
      description: 'Run JavaScript in the sidecar page and return its value. For what the numbered controls cannot express: reading a table, setting storage, filling a widget. The page must be opened first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          code: { type: 'string', description: 'Expression or statements. A returned value is handed back, trimmed.' },
          await: { type: 'boolean', description: 'Await the result if it is a promise.' },
        },
        required: ['code'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the value. */
      execute: async (args) => withPage(async (page) => {
        const code = String(args?.code ?? '')
        if (code === '') return 'Give code to run.'
        const wrapped = args?.await === true ? `(async () => { ${code} })()` : code
        const { result, exceptionDetails } = await page.cdp.send('Runtime.evaluate', {
          expression: wrapped,
          returnByValue: true,
          awaitPromise: args?.await === true,
          userGesture: true,
        })
        if (exceptionDetails !== undefined) return String(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'evaluate failed').slice(0, 2000)
        const value = result?.value
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        if (text === undefined) return 'undefined'
        return text.length > 4000 ? `${text.slice(0, 4000)}\n… ${text.length - 4000} more characters` : text
      }),
    },
    {
      name: 'sidecar_select', // ui-copy-ignore
      description: 'Choose an option in a dropdown, by visible label or value, then return the page.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the select control from sidecar_view.' },
          value: { type: 'string', description: 'Option label or value to choose.' },
        },
        required: ['ref', 'value'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const spot = await locate(page, Number(args?.ref))
        if (spot.gone === true) return REF_GONE
        const wanted = JSON.stringify(String(args?.value ?? ''))
        const route = await contextFor(page, Number(args?.ref))
        const local = route?.local ?? Number(args?.ref)
        const said = await evaluate(page, `(() => {
  const reg = window.__dshRead
  const hit = reg && reg.find(${local})
  if (!hit || hit.el.tagName !== 'SELECT') return 'that control is not a dropdown'
  const select = hit.el
  const wanted = ${wanted}
  const option = Array.from(select.options).find((item) => item.value === wanted || item.text.trim() === wanted || item.text.trim().toLowerCase() === wanted.toLowerCase())
  if (!option) return 'no option ' + wanted + '; options are ' + Array.from(select.options).slice(0, 12).map((item) => item.text.trim()).join(' | ')
  select.value = option.value
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
  return 'chose ' + option.text.trim()
})()`, route)
        await settle(page, 3000)
        if (args?.read === true) return `${String(said)}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
        return `${String(said)} · ${await brief(page)}`
      }),
    },
    {
      name: 'sidecar_upload', // ui-copy-ignore
      description: 'Put files into a file input on the page, by absolute path, then return the page. The file chooser never opens.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Number of the file input from sidecar_view.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths on this machine.' },
        },
        required: ['ref', 'files'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the page after. */
      execute: async (args) => withPage(async (page) => {
        const ref = Number(args?.ref)
        const files = Array.isArray(args?.files) ? args.files.map(String) : []
        if (files.length === 0) return 'Give at least one absolute path.'
        const route = await contextFor(page, ref)
        const uploadParams = { expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${route?.local ?? ref}); return hit ? hit.el : null })()` }
        if (route?.contextId !== undefined) uploadParams.contextId = route.contextId
        const handle = await page.cdp.send('Runtime.evaluate', uploadParams, route?.sessionId)
        const objectId = handle.result?.objectId
        if (objectId === undefined) return REF_GONE
        const node = await page.cdp.send('DOM.describeNode', { objectId }, route?.sessionId)
        const backendNodeId = node?.node?.backendNodeId
        if (backendNodeId === undefined) return 'That control cannot take a file.'
        await page.cdp.send('DOM.setFileInputFiles', { files, backendNodeId }, route?.sessionId)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `upload ${String(files.length)} file`) // ui-copy-ignore
      }),
    },
    {
      name: 'sidecar_shot', // ui-copy-ignore
      description: 'Save a PNG of the sidecar browser into the session folder and return its absolute path. Default is the visible screen; full takes the whole page, ref takes one control.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          name: { type: 'string', description: 'File name without extension.' },
          full: { type: 'boolean', description: 'The whole page, not just the screen.' },
          ref: { type: 'integer', description: 'One control from sidecar_view.' },
          scale: { type: 'integer', description: 'Pixel ratio. Default 1; 2 is sharper and heavier.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the saved path. */
      execute: async (args) => withPage(async (page) => {
        const scale = Math.max(1, Math.min(3, Number(args?.scale ?? 1)))
        let clip = undefined
        if (args?.ref !== undefined) {
          const spot = await locate(page, Number(args.ref))
          if (spot.gone === true) return REF_GONE
          clip = { x: Math.max(0, Number(spot.x) - 20), y: Math.max(0, Number(spot.y) - 20), width: 220, height: 140 }
        }
        const data = await page.shot({ full: args?.full === true, rect: clip, scale })
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const name = String(args?.name ?? '').replace(/[^\w.-]/g, '') || `sidecar-${Date.now()}`
        const file = join(dir, name.endsWith('.png') ? name : `${name}.png`)
        await writeFile(file, Buffer.from(data, 'base64'))
        return file
      }),
    },
    {
      name: 'sidecar_state', // ui-copy-ignore
      description: 'Report the sidecar browser: whether it runs, its profile, address, title, and how many people are watching its mirror.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} the state. */
      execute: async () => {
        const state = await sidecar.state()
        const owner = String(host.owner?.() ?? '') // ui-copy-ignore
        const rows = [
          state.alive ? 'running' : 'stopped',
          `profile ${String(state.profile)}`,
          `url ${String(state.url)}`,
          `title ${String(state.title)}`,
          `viewers ${String(state.viewers)}`,
          owner === '' ? 'no owner' : `owner ${owner}`,
        ]
        return { text: rows.join('\n') }
      },
    },

    {
      name: 'sidecar_downloads', // ui-copy-ignore
      description: 'List what this browser has downloaded, newest first, with the file name, its size and when it arrived.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @returns {Promise<{text: string}>} the files. */
      execute: async () => {
        const files = sidecar.downloads()
        if (files.length === 0) return { text: 'no downloads yet' }
        return { text: files.map((file) => `${String(file.name)} · ${String(file.bytes)} B · ${String(file.at)}`).join('\n') }
      },
    },

    {
      name: 'sidecar_drag', // ui-copy-ignore
      description: 'Drag from one place to another with real mouse steps: from a ref or a point, to a point or offset. Use it for sliders, dashboards and drag-and-drop lists.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          from: { type: 'integer', description: 'Ref to start on.' },
          x: { type: 'integer', description: 'Start x, when not using from.' },
          y: { type: 'integer', description: 'Start y, when not using from.' },
          to_x: { type: 'integer', description: 'Where to let go, x.' },
          to_y: { type: 'integer', description: 'Where to let go, y.' },
          steps: { type: 'integer', description: 'Mouse moves along the way. Default 12.' },
          read: { type: 'boolean', description: 'Read the page after the drag.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what happened. */
      execute: async (args) => withPage(async (page) => {
        let start = { x: Number(args?.x ?? NaN), y: Number(args?.y ?? NaN) }
        if (args?.from !== undefined) {
          const spot = await locate(page, Number(args.from))
          if (spot.gone === true) return REF_GONE
          start = { x: Number(spot.x), y: Number(spot.y) }
        }
        const end = { x: Number(args?.to_x ?? NaN), y: Number(args?.to_y ?? NaN) }
        if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return 'Give from (or x and y) and to_x and to_y.'
        const count = Math.max(2, Math.min(40, Number(args?.steps ?? 12)))
        await page.mouse('mouseMoved', start)
        await page.mouse('mousePressed', start)
        for (let index = 1; index <= count; index += 1) {
          await page.mouse('mouseMoved', {
            x: Math.round(start.x + ((end.x - start.x) * index) / count),
            y: Math.round(start.y + ((end.y - start.y) * index) / count),
          })
        }
        await page.mouse('mouseReleased', end)
        await settle(page, 3000)
        return acted(page, args, () => look(page, { mode: 'text', maxChars: 2000 }), `drag ${start.x},${start.y} → ${end.x},${end.y}`)
      }),
    },
    {
      name: 'sidecar_check', // ui-copy-ignore
      description: 'Set a checkbox, radio or switch to a known state, and say whether it took. Clicking blindly flips a control that is already right; this one looks first.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          ref: { type: 'integer', description: 'Control number from sidecar_view.' },
          checked: { type: 'boolean', description: 'Wanted state. Omit to flip it.' },
          read: { type: 'boolean', description: 'Read the page after.' },
        },
        required: ['ref'], // ui-copy-ignore
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the state now. */
      execute: async (args) => withPage(async (page) => {
        const checkRoute = await contextFor(page, Number(args?.ref))
        const checkParams = {
          expression: `(() => { const reg = window.__dshRead; const hit = reg && reg.find(${checkRoute?.local ?? Number(args?.ref)}); if (!hit) return null; const el = hit.el; return { checked: Boolean(el.checked), name: String(el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.name || '').trim().slice(0, 60) } })()`,
          returnByValue: true,
        }
        if (checkRoute?.contextId !== undefined) checkParams.contextId = checkRoute.contextId
        const probe = await page.cdp.send('Runtime.evaluate', checkParams, checkRoute?.sessionId)
        const now = probe.result?.value
        if (now === null || now === undefined) return REF_GONE
        const want = args?.checked === undefined ? !Boolean(now.checked) : args.checked === true
        if (Boolean(now.checked) !== want) {
          const spot = await locate(page, Number(args.ref))
          if (spot.gone === true) return REF_GONE
          await page.mouse('mouseMoved', { x: Number(spot.x), y: Number(spot.y) })
          await page.mouse('mousePressed', { x: Number(spot.x), y: Number(spot.y) })
          await page.mouse('mouseReleased', { x: Number(spot.x), y: Number(spot.y) })
          await settle(page, 3000)
        }
        const line = `${now.name} is now ${want ? 'on' : 'off'}`
        if (args?.read === true) return `${line}\n${await look(page, { mode: 'text', maxChars: 2000 })}`
        return line
      }),
    },
    {
      name: 'sidecar_wait', // ui-copy-ignore
      description: 'Wait until the page shows a piece of text, stops showing it, reaches an address, or goes quiet. Cheaper than reading in a loop.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          text: { type: 'string', description: 'Text to wait for.' },
          gone: { type: 'string', description: 'Text to wait to disappear.' },
          url: { type: 'string', description: 'Address piece to wait for.' },
          idle: { type: 'boolean', description: 'Wait for the page to settle.' },
          timeout: { type: 'integer', description: 'Ceiling in milliseconds. Default 8000.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 30_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} whether it happened. */
      execute: async (args) => withPage(async (page) => {
        const timeout = Math.max(500, Math.min(30_000, Number(args?.timeout ?? 8000)))
        if (typeof args?.text === 'string' && args.text !== '') {
          const seen = await until(page, `document.body !== null && document.body.innerText.includes(${JSON.stringify(String(args.text))})`, timeout)
          return seen ? `saw ${String(args.text)}` : `did not see ${String(args.text)} within ${timeout} ms`
        }
        if (typeof args?.gone === 'string' && args.gone !== '') {
          const gone = await until(page, `document.body === null || !document.body.innerText.includes(${JSON.stringify(String(args.gone))})`, timeout)
          return gone ? `${String(args.gone)} is gone` : `${String(args.gone)} is still there after ${timeout} ms`
        }
        if (typeof args?.url === 'string' && args.url !== '') {
          const at = await until(page, `location.href.includes(${JSON.stringify(String(args.url))})`, timeout)
          return at ? `at ${String(await evaluate(page, 'location.href'))}` : `address never contained ${String(args.url)}`
        }
        await settle(page, timeout)
        return 'idle'
      }),
    },
    {
      name: 'sidecar_dialog', // ui-copy-ignore
      description: 'Answer the alert, confirm or prompt the page is showing, or read what it asks. A dialog blocks the page until it is answered, so nothing else works while one is open.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          accept: { type: 'boolean', description: 'Yes or OK. Default true; false dismisses it.' },
          text: { type: 'string', description: 'What to answer a prompt with.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what the dialog said. */
      execute: async (args) => withPage(async (page) => {
        const dialog = page.dialog
        if (dialog === null || dialog === undefined) return 'no dialog is open'
        const said = `${String(dialog.type ?? '')}: ${String(dialog.message ?? '')}`
        await page.cdp.send('Page.handleJavaScriptDialog', {
          accept: args?.accept !== false,
          promptText: String(args?.text ?? ''),
        })
        page.dialog = null
        await settle(page, 3000)
        return said
      }),
    },
    {
      name: 'sidecar_console', // ui-copy-ignore
      description: 'The console lines and errors this page has produced, newest last. Use it when a click seemed to do nothing.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { limit: { type: 'integer', description: 'How many lines. Default 30.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the lines. */
      execute: async (args) => withPage(async (page) => {
        const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 30)))
        const lines = page.console.slice(-limit).map((entry) => `${entry.type}: ${entry.text}`)
        return lines.length === 0 ? 'no console output' : lines.join('\n')
      }),
    },
    {
      name: 'sidecar_failed', // ui-copy-ignore
      description: 'Requests this page tried and that failed, newest last. A blank area is often one of these.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: { limit: { type: 'integer', description: 'How many. Default 20.' } },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the failures. */
      execute: async (args) => withPage(async (page) => {
        const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20)))
        const rows = page.failed.slice(-limit).map((row) => `${row.type}: ${row.error}`)
        return rows.length === 0 ? 'no request failed' : rows.join('\n')
      }),
    },
    {
      name: 'sidecar_cookie',
      description: 'Read or change the cookies this browser keeps. Login state is a cookie, so this is how you check a sign-in and how you keep one.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          url: { type: 'string', description: 'Only cookies this address would send.' },
          set: { type: 'string', description: 'Write one cookie as name=value, for the current address or domain.' },
          domain: { type: 'string', description: 'Domain for a cookie being written.' },
          clear: { type: 'boolean', description: 'Drop every cookie in this browser.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 20_000,
      /* Reading the jar is safe; writing one is not, and the tool can do both. */
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} what the jar holds now. */
      execute: async (args) => withPage(async (page) => {
        if (args?.clear === true) {
          await page.clearCookies()
          return 'every cookie is gone'
        }
        if (typeof args?.set === 'string' && args.set !== '') {
          const at = args.set.indexOf('=')
          if (at < 1) return 'write one cookie as name=value'
          const name = args.set.slice(0, at)
          const value = args.set.slice(at + 1)
          const answer = await page.setCookie({
            name,
            value,
            domain: typeof args.domain === 'string' && args.domain !== '' ? args.domain : undefined,
          })
          return answer.ok ? `kept ${name}` : `the browser refused ${name}: ${answer.reason}`
        }
        const url = typeof args?.url === 'string' && args.url !== '' ? [args.url] : undefined
        const jar = await page.cookies(url)
        if (jar.length === 0) return 'no cookies'
        return jar
          .slice(0, 40)
          .map((c) => `${c.domain}${c.path ?? '/'} ${c.name}=${String(c.value).slice(0, 60)}`)
          .join('\n')
      }),
    },
    {
      name: 'sidecar_clipboard', // ui-copy-ignore
      description: 'Read the sidecar browser\'s clipboard, or put text on it and paste it with a key press. For a page that only copies through a button, click it then read here.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          set: { type: 'string', description: 'Text to put on the clipboard.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 15_000,
      isConcurrencySafe: () => false,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} clipboard text. */
      execute: async (args) => withPage(async (page) => {
        if (typeof args?.set === 'string') {
          await page.clipboardWrite(args.set)
          return `clipboard set, ${String(args.set.length)} characters`
        }
        const text = await page.clipboardRead()
        return text === '' ? 'clipboard is empty, or the page did not allow reading it' : text
      }),
    },
    {
      name: 'sidecar_network', // ui-copy-ignore
      description: 'List the responses the page has received, newest first: method, status, type and address. Use it when a page fills itself from the network and the screen does not say why.',
      parameters: {
        type: 'object', // ui-copy-ignore
        properties: {
          filter: { type: 'string', description: 'Only rows whose address contains this text.' },
          limit: { type: 'integer', description: 'How many rows. Default 20, at most 60.' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 10_000,
      isConcurrencySafe: () => true,
      /** @param {any} args - arguments. @returns {Promise<{text: string}>} the requests. */
      execute: async (args) => {
        const want = String(args?.filter ?? '').toLowerCase()
        const limit = Math.min(60, Math.max(1, Number(args?.limit ?? 20) || 20))
        const rows = sidecar.network()
          .filter((row) => want === '' || String(row.url).toLowerCase().includes(want))
          .slice(0, limit)
        if (rows.length === 0) return { text: 'no responses yet' }
        return { text: rows.map((row) => `${String(row.status)} ${String(row.method)} ${String(row.type)} ${String(row.url)}`).join('\n') }
      },
    },

    {
      name: 'sidecar_pdf', // ui-copy-ignore
      description: 'Print the page to a PDF and return its path. Useful when the person wants the document rather than a picture of it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT, // ui-copy-ignore
      timeoutMs: 40_000,
      isConcurrencySafe: () => false,
      /** @returns {Promise<{text: string}>} where the PDF is. */
      execute: async () => withPage(async (page) => {
        const data = await page.pdf()
        const dir = join(homedir(), SHOT_DIR)
        await mkdir(dir, { recursive: true })
        const file = join(dir, `sidecar-${Date.now()}.pdf`)
        await writeFile(file, Buffer.from(data, 'base64'))
        return file
      }),
    },
  ]
}
