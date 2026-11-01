#!/usr/bin/env node
/**
 * browser_look against a real Chrome and a page that draws itself.
 *
 *   node scripts/check-look.mjs
 *
 * Paints a canvas, reads the screen as letters, paints one square, reads again
 * and reports whether the second read named only that square. Exits non-zero
 * when the tool stops being able to see a self-drawn page.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-look-'))
const folder = mkdtempSync(join(tmpdir(), 'dsh-look-page-'))
writeFileSync(join(folder, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#101010}canvas{display:block}</style>
<canvas id="c"></canvas>
<script>
const c = document.getElementById('c')
c.width = innerWidth
c.height = innerHeight
const g = c.getContext('2d')
g.fillStyle = '#202020'
g.fillRect(0, 0, c.width, c.height)
g.fillStyle = '#e0e0e0'
g.fillRect(0, 0, c.width, c.height / 2)
</script>`)

const { Sidecar } = await import('../sidecar.js')
const { sidecarTools, sessionScope, workScope } = await import('../tools.js')

const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'look-check', headless: true })
const tools = sidecarTools(sidecar, { byChat: new Map() }, {})
const tool = (name) => tools.find((one) => one.name === name)
/* Every tool path reads the chat from the scope it is called in, so the check
   binds the same chat the plugin would bind for a real conversation. */
const run = (name, args) => sessionScope.run('look-check', () => workScope.run(folder, () => tool(name).execute(args, { agent: { id: 'look-check' } })))
let failed = 0
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed += 1
}
try {
  await sidecar.launch('about:blank')
  await sidecar.watch(() => {})
  const page = await sidecar.ensure({ session: 'look-check' })
  await page.navigate(pathToFileURL(join(folder, 'index.html')).href).catch(() => {})
  await wait(900)

  const first = await run('browser_look', { cols: 12 })
  const firstText = String(first?.text ?? '')
  console.log('--- first look ---\n' + firstText)
  check(/^look 12x\d+ of the screen/m.test(firstText), 'the whole screen is read as a 12-wide grid')
  check(/1 canvas/.test(firstText), 'the call says the page draws itself')
  check((firstText.match(/^[.:+\-*#rgbcmyopn]+$/gm) ?? []).length >= 6, 'the grid arrives as rows of palette letters')
  check(/first look at this screen/.test(firstText), 'the first look says there is nothing to compare yet')

  const painted = await run('browser_eval', { code: "(() => { const c = document.querySelector('canvas'); const g = c.getContext('2d'); g.fillStyle = '#ff2020'; g.fillRect(c.width * 0.2, c.height * 0.15, c.width * 0.4, c.height * 0.2); return 'painted' })()" })
  check(/painted/.test(String(painted?.text ?? '')), 'the page can be asked to paint a square')
  await wait(300)

  const second = await run('browser_look', { cols: 12 })
  const secondText = String(second?.text ?? '')
  console.log('--- second look ---\n' + secondText)
  check(/changed: \d+ cells? in box \d+,\d+ \d+x\d+/.test(secondText), 'the second look names only the part that moved')
  /* Red has to be in the changed box, not anywhere in a page that may already
     use it: the diff block is only palette rows, so one of those rows must
     carry r. */
  const diffBlock = secondText.slice(secondText.search(/changed:/))
  check(/^[.:+*#rgbcmyopn-]*r[.:+*#rgbcmyopn-]*$/m.test(diffBlock), 'the picture of the change shows red where the square is')

  const same = await run('browser_look', { cols: 12 })
  check(/nothing changed since the last look/.test(String(same?.text ?? '')), 'a look that sees nothing new says so')
  const chars = firstText.length + secondText.length + String(same?.text ?? '').length
  console.log(`three looks cost ${chars} characters and no picture`)
} catch (error) {
  console.error('look check failed:', error)
  failed += 1
} finally {
  await sidecar.close?.().catch(() => {})
}
process.exitCode = failed === 0 ? 0 : 1
