#!/usr/bin/env node
/**
 * What a read of a real page costs, in characters and tokens, at the column's
 * width. One JSON line per page and budget so a run can be diffed against the
 * last one:
 *
 *   node scripts/readcost.mjs
 *
 * Network is involved: pages that do not answer within the navigation budget
 * are reported as unreachable instead of failing the run.
 */
import { Sidecar } from '../sidecar.js'
import { readPage, renderPage } from '../read.js'

/** Pages worth costing: long article, list of links, form. */
const PAGES = [
  { name: 'article', url: 'https://github.com/rust-lang/rust', modes: ['text', 'links'] },
  { name: 'list', url: 'https://github.com/topics/computer-use', modes: ['links', 'text'] },
  { name: 'form', url: 'https://github.com/login', modes: ['forms', 'text'] },
]

/** @param {string} label - what is measured. @param {Record<string, unknown>} row - numbers. */
function emit(label, row) {
  console.log(JSON.stringify({ label, ...row }))
}

/** @param {number} ms - how long. */
function wait(ms) {
  return new Promise((settle) => setTimeout(settle, ms))
}

/** Wait until the page has content, not merely an address: a read taken before
 * the document is there reports zero controls and understates the cost. */
async function ready(sidecar, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const reply = await sidecar.page.cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ s: document.readyState, n: document.querySelectorAll("*").length, h: document.body?.innerText?.length ?? 0 })', // ui-copy-ignore
      returnByValue: true,
    }).catch(() => null)
    const seen = JSON.parse(String(reply?.result?.value ?? '{"s":"","n":0,"h":0}'))
    if (seen.s === 'complete' && seen.n > 40 && seen.h > 200) return true
    await wait(150)
  }
  return false
}

async function main() {
  const sidecar = new Sidecar({ profile: 'readcost' })
  try {
    for (const spec of PAGES) {
      const at = Date.now()
      try {
        await Promise.race([
          sidecar.ensure({ url: spec.url }),
          wait(25_000).then(() => { throw new Error('no answer in 25 s') }),
        ])
        await ready(sidecar, 15_000)
      } catch (error) {
        emit('page', { page: spec.name, reachable: false, why: String(error?.message ?? error).slice(0, 80) })
        continue
      }
      for (const mode of spec.modes) {
        for (const maxChars of [4600, 2200]) {
          const started = Date.now()
          const read = await readPage(sidecar.page, { mode, maxChars })
          const rendered = renderPage(read, { mode, maxChars })
          emit('read', {
            page: spec.name,
            mode,
            maxChars,
            ms: Date.now() - started,
            controls: read.controls.length,
            chars: rendered.length,
            approxTokens: Math.round(rendered.length / 3.4),
            navigatedMs: Date.now() - at,
          })
        }
      }
      const whole = renderPage(await readPage(sidecar.page, { mode: 'text' }), { mode: 'text', maxChars: 46_000 })
      emit('whole', { page: spec.name, chars: whole.length, approxTokens: Math.round(whole.length / 3.4) })
    }
  } finally {
    await sidecar.shutdown().catch(() => {})
  }
  process.exitCode = 0
}

main().catch((error) => {
  console.error(String(error?.stack ?? error))
  process.exitCode = 1
})
