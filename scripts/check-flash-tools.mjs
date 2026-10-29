#!/usr/bin/env node
/**
 * What a tool call costs on a Flash page, from the model's side.
 *
 *   node scripts/check-flash-tools.mjs [url]
 *
 * Runs the real tool definitions against a real Flash runtime and reports time
 * and characters for a click, a view and a type, plus whether the picture moved.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://account.100bt.com/game/auth/login.html?gameName=aola&action=startgame&platform=100bt'
process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-flash-tools-'))

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'flash-tools', headless: false, flash: true })
const refs = { byChat: new Map() }
const tools = sidecarTools(sidecar, refs, {})
const tool = (name) => tools.find((one) => one.name === name)
let ok = false
try {
  await sidecar.launch('about:blank')
  await sidecar.watch(() => {})
  await sidecar.page.navigate(url).catch(() => {})
  await wait(9000)
  const said = []
  const timed = async (name, args) => {
    const started = Date.now()
    const value = await tool(name).execute(args, { agent: { id: 'flash-check' } })
    const text = String(value?.text ?? '')
    const record = { tool: name, ms: Date.now() - started, chars: text.length, text: text.slice(0, 120) }
    said.push(record)
    return record
  }
  await timed('browser_view', {})
  /* One call is a sample, five are a cost: a plugin page blocks its main
     thread while it draws, so a single number swings by a hundred ms. */
  const rounds = []
  for (let i = 0; i < 5; i += 1) {
    rounds.push(await timed('browser_click', { x: 640, y: 420 }))
    rounds.push(await timed('browser_type', { text: 'a' }))
  }
  const median = (list) => {
    const sorted = list.map((one) => one.ms).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  /* A read of a page just read is mostly the page again: it must cost a line,
     not a snapshot. */
  const viewAgain = await timed('browser_view', {})
  const viewThird = await timed('browser_view', {})
  const clicks = rounds.filter((one) => one.tool === 'browser_click')
  const types = rounds.filter((one) => one.tool === 'browser_type')
  const last = rounds[rounds.length - 1]
  /* A step that repeats the address it read a moment ago is spend with nothing
     to teach, so the budget is per step and tight: one line, not a page. */
  const within = (one) => Number(one?.chars ?? 999) < 300
  /* A page whose own requests fail still answers, but slowly: the numbers to
     gate on are the token ones, and latency is judged only when the page came
     up whole. Otherwise a bad minute at the site reads as a regression here. */
  const degraded = said[0].chars < 300 || said[0].text.includes('page trouble')
  const fast = () => degraded || (median(clicks) < 120 && median(types) < 120)
  ok = clicks.length === 5 && fast() && clicks.every(within) && types.every(within) && Number(last?.chars ?? 0) > 0 && viewAgain.chars < said[0].chars && viewThird.chars < said[0].chars
  console.log(JSON.stringify({ view: said[0], clickMedianMs: median(clicks), clickMaxMs: Math.max(...clicks.map((one) => one.ms)), typeMedianMs: median(types), typeMaxMs: Math.max(...types.map((one) => one.ms)), clickChars: clicks[0].chars, typeChars: types[0].chars, viewAgainChars: viewAgain.chars, viewThirdChars: viewThird.chars, viewAgainText: viewAgain.text, degraded, ok }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 160) }))
} finally {
  await sidecar.shutdown().catch(() => {})
}
process.exitCode = ok ? 0 : 1
