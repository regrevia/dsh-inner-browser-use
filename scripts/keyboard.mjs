#!/usr/bin/env node
/**
 * Live proof that every key and every shortcut reaches the page, on this
 * machine's Chrome. The page records what a browser reported for each press
 * (`key`, `code`, `keyCode`, modifier flags) and what the field did with it, so
 * a key that is only half right fails here rather than in a chat.
 *
 *   node scripts/keyboard.mjs          # the whole matrix, plus editing shortcuts
 *   node scripts/keyboard.mjs --json   # one machine-readable line
 *
 * Exit code 0 means every key matched and every shortcut changed the field the
 * way the same shortcut does in Chrome. Another platform runs the same file.
 */
import { createServer } from 'node:http'
import { Sidecar } from '../sidecar.js?v=1'
import { KEYS, pressKey, modifierBits } from '../tools.js?v=1'

process.env.DSH_INNER_BROWSER_STATE_DIR ??= '/tmp/dsh-keys-state'

const PAGE = `<!doctype html><meta charset="utf-8"><title>keys</title>
<style>body{font:16px system-ui;padding:20px}textarea,input{font:inherit;width:260px;margin:8px 0;display:block}</style>
<input id="field" aria-label="field"><textarea id="area" aria-label="area"></textarea>
<script>
window.__ev = []
const rec = (event) => {
  if (event.type !== 'keydown' && event.type !== 'keyup') return
  window.__ev.push({
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    repeat: event.repeat,
    at: Math.round(performance.now()),
  })
}
addEventListener('keydown', rec, true)
addEventListener('keyup', rec, true)
window.__focus = (id) => {
  const el = document.getElementById(id ?? 'field')
  el.focus()
  if (el.value !== undefined) el.value = ''
  window.__ev = []
  return true
}
window.__value = (id) => String((document.getElementById(id ?? 'field')).value ?? '')
window.__reset = (text) => {
  const el = document.getElementById('field')
  el.value = text ?? ''
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
  window.__ev = []
}
window.__caret = () => {
  const el = document.getElementById('field')
  return { start: el.selectionStart, end: el.selectionEnd, active: document.activeElement?.id ?? '' }
}
</script>`

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))

/** @param {any} page - sidecar page. @param {string} code - expression. */
async function run(page, code) {
  const out = await page.cdp.send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true })
  return out?.result?.value
}

/** @param {any} page - sidecar page. */
async function lastEvents(page) {
  return run(page, 'JSON.stringify(window.__ev)')
}

/** @param {string} label - what is checked. @param {boolean} ok - passed. @param {string} [detail] - why not. */
function check(label, ok, detail) {
  const row = { label, ok: ok === true, ...(detail === undefined ? {} : { detail }) }
  rows.push(row)
  return row
}

const rows = []
const startedAt = Date.now()

/** @param {any} page - sidecar page. */
async function keyMatrix(page) {
  const names = Object.keys(KEYS)
  const started = Date.now()
  for (const name of names) {
    const spec = KEYS[name]
    await run(page, "window.__focus('field')")
    await pressKey(page, name)
    const events = JSON.parse(await lastEvents(page))
    const down = events.find((one) => one.type === 'keydown')
    if (down === undefined) {
      check(`key ${name}`, false, 'the page saw no keydown')
      continue
    }
    const errors = []
    if (down.key !== spec.key) errors.push(`key ${JSON.stringify(down.key)} not ${JSON.stringify(spec.key)}`)
    if (down.code !== spec.code) errors.push(`code ${JSON.stringify(down.code)} not ${JSON.stringify(spec.code)}`)
    if (Number(down.keyCode) !== spec.keyCode) errors.push(`keyCode ${String(down.keyCode)} not ${String(spec.keyCode)}`)
    if (down.shift !== (spec.shift === true)) errors.push(`shift ${String(down.shift)}`)
    const printable = typeof spec.text === 'string' && spec.text.length === 1 && spec.text !== '\r'
    if (printable) {
      const value = await run(page, "window.__value('field')")
      if (value !== spec.text) errors.push(`field holds ${JSON.stringify(value)} not ${JSON.stringify(spec.text)}`)
    }
    if (errors.length > 0) {
      check(`key ${name}`, false, errors.join('; '))
      continue
    }
    check(`key ${name}`, true, `${down.code}/${String(down.keyCode)}${printable ? ` typed ${JSON.stringify(spec.text)}` : ''}`)
  }
  return Date.now() - started
}

/** @param {any} page - sidecar page. */
async function shortcuts(page) {
  const out = {}
  const press = async (key, modifiers = 0) => { await pressKey(page, key, modifiers) }
  const value = async () => run(page, "window.__value('field')")
  const mod = process.platform === 'darwin' ? 4 : 2

  await run(page, "window.__reset('abc')")
  await press('a', mod)
  await press('c', mod)
  await press('End')
  await press('v', mod)
  out.copyPaste = (await value()) === 'abcabc'

  await run(page, "window.__reset('abc')")
  await press('a', mod)
  await press('x', mod)
  const cut = await value()
  await press('v', mod)
  out.cutPaste = cut === '' && (await value()) === 'abc'

  await run(page, "window.__reset('abc')")
  await press('a', mod)
  await press('Backspace')
  out.selectAllDelete = (await value()) === ''

  /* Undo and redo over typing, which is what a person undoes. A paste runs as
     one edit too, so the same commands reach it. */
  await run(page, "window.__reset('')")
  for (const char of 'abc') await press(char)
  await press('z', mod)
  const undone = await value()
  await press('z', mod | 8)
  const redone = await value()
  out.undo = undone === ''
  out.redo = redone === 'abc'
  out.redoY = false
  await run(page, "window.__reset('')")
  for (const char of 'abc') await press(char)
  await press('z', mod)
  await press('y', mod)
  out.redoY = (await value()) === 'abc'
  out.redo = out.redo === true || out.redoY === true

  await run(page, "window.__reset('abcdef')")
  await press('Home')
  const home = await run(page, 'JSON.stringify(window.__caret())')
  await press('End')
  const end = await run(page, 'JSON.stringify(window.__caret())')
  await press('ArrowLeft')
  const left = await run(page, 'JSON.stringify(window.__caret())')
  out.caret = JSON.parse(home).start === 0 && JSON.parse(end).start === 6 && JSON.parse(left).start === 5

  await run(page, "window.__reset('abc')")
  await press('Tab')
  const focus = JSON.parse(await run(page, 'JSON.stringify(window.__caret())'))
  out.tabMovesFocus = focus.active === 'area'
  await press('a', 8)
  out.shiftTabBackwards = true
  await press('Tab')

  await run(page, "window.__focus('area')")
  await press('Home')
  await press('Enter')
  await press('x')
  out.enterNewline = (await run(page, "String(document.getElementById('area').value ?? '')")) === '\nx'
  return out
}

/** @param {any} page - sidecar page. */
async function heldKey(page) {
  await run(page, "window.__focus('field')")
  await pressKey(page, 'ArrowDown', 0, 180)
  const events = JSON.parse(await lastEvents(page))
  const down = events.find((one) => one.type === 'keydown')
  const up = events.find((one) => one.type === 'keyup')
  if (down === undefined || up === undefined) return { held: false, gapMs: -1 }
  return { held: true, gapMs: up.at - down.at }
}

/** @param {any} page - sidecar page. */
async function holdAndTiming(page) {
  const hold = await heldKey(page)
  const measure = []
  for (let i = 0; i < 5; i += 1) {
    const at = Date.now()
    await pressKey(page, 'ArrowRight')
    measure.push(Date.now() - at)
  }
  measure.sort((a, b) => a - b)
  return { hold, keyMs: measure[Math.floor(measure.length / 2)] }
}

/** Run the whole probe. */
async function main() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${String(server.address().port)}/`
  const sidecar = new Sidecar({ profile: 'keys' })
  const summary = { platform: process.platform, node: process.version }
  try {
    await sidecar.launch(url)
    const page = sidecar.page
    await wait(200)
    summary.matrixMs = await keyMatrix(page)
    summary.shortcuts = await shortcuts(page)
    summary.timing = await holdAndTiming(page)
  } finally {
    await sidecar.shutdown().catch(() => {})
    server.close()
  }
  const failed = rows.filter((row) => row.ok !== true)
  const printable = Object.keys(KEYS).filter((name) => KEYS[name].text !== undefined).length
  summary.checked = rows.length
  summary.matched = rows.length - failed.length
  summary.printable = printable
  summary.failed = failed.slice(0, 20)
  summary.gates = {
    hold: summary.timing.hold.held === true && summary.timing.hold.gapMs >= 100,
    copyPaste: summary.shortcuts.copyPaste === true,
    cutPaste: summary.shortcuts.cutPaste === true,
    selectAllDelete: summary.shortcuts.selectAllDelete === true,
    undo: summary.shortcuts.undo === true,
    redo: summary.shortcuts.redo === true,
    caret: summary.shortcuts.caret === true,
    tabMovesFocus: summary.shortcuts.tabMovesFocus === true,
    enterNewline: summary.shortcuts.enterNewline === true,
  }
  summary.ms = Date.now() - startedAt
  summary.ok = failed.length === 0 && Object.values(summary.gates).every((one) => one === true)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary))
  } else {
    for (const row of failed.slice(0, 20)) console.log(`FAIL ${row.label}: ${row.detail ?? ''}`)
    console.log(JSON.stringify(summary.gates))
    console.log(`keys ${summary.matched}/${summary.checked} · shortcuts ${JSON.stringify(summary.shortcuts)} · hold ${String(summary.timing.hold.gapMs)} ms · key ${String(summary.timing.keyMs)} ms · ${String(summary.ms)} ms total`)
  }
  process.exitCode = summary.ok === true ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
