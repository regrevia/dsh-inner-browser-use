#!/usr/bin/env node
/**
 * Live: the same tools, on real sites, over the real network.
 * One JSON line per check, each with how long it took and how much it cost.
 * Pages change their words; a check here asserts what the page does, not a
 * screenshot of it, so the site can change copy without turning this red.
 *
 * Run: node scripts/live.mjs
 */
import { Sidecar } from '../sidecar.js'
import { sidecarTools } from '../tools.js'

const sidecar = new Sidecar({ profile: 'live' })
let page
const results = []

/** @param {string} check - name. @param {boolean} ok - passed. @param {string} detail - what happened. */
function line(check, ok, detail) {
  const row = { check, ok, detail }
  results.push(row)
  console.log(JSON.stringify(row))
}

/** @param {number} ms - how long. @returns {Promise<void>} resolves later. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {Promise<any>} work - to bound. @param {number} ms - ceiling. @returns {Promise<any>} the work or a timeout. */
async function within(work, ms) {
  return Promise.race([work, sleep(ms).then(() => ({ timedOut: true }))])
}

/** @param {string} expression - page JavaScript. @returns {Promise<string>} what it said. */
async function said(expression) {
  const out = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null)
  return String(out?.result?.value ?? '')
}

/** @returns {Promise<string>} the page's own title, as the page sees it. */
async function title() {
  return said('document.title')
}

/** Wait for a real document, since the network is not a local server.
 * @param {number} [ms] - ceiling. @returns {Promise<boolean>} whether it arrived. */
async function loaded(ms = 25_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const state = await said('document.readyState + "|" + location.href')
    if (state.startsWith('complete|') && !state.includes('about:blank') && !state.includes('chromewebdata')) return true
    await sleep(150)
  }
  return false
}

const tools = sidecarTools(sidecar, { last: undefined })
/** @param {string} name - tool name. @returns {any} the tool. */
const tool = (name) => tools.find((each) => each.name === name)

try {
  const openAt = Date.now()
  page = await within(sidecar.ensure({ url: 'https://example.com/' }), 30_000)
  if (page === undefined || page?.timedOut === true) throw new Error('example.com did not answer in 30 s')
  await loaded()
  line('live-open', (await title()) === 'Example Domain', `${Date.now() - openAt} ms to a real page over the network · ${await title()}`)

  const view = tool('sidecar_view')
  const read = String((await within(view.execute({ max_chars: 700 }), 20_000))?.text ?? '')
  line('live-read', read.includes('Example Domain') && /\[link\]/.test(read), `${read.length} chars · ${read.split('\n')[1]?.slice(0, 50)}`)

  // The language picker is a page whose controls are all links: click one by its words.
  const wiki = await within(sidecar.ensure({ url: 'https://www.wikipedia.org/' }), 30_000)
  if (wiki === undefined || wiki?.timedOut === true) throw new Error('wikipedia.org did not answer in 30 s')
  await loaded()
  const click = tool('sidecar_click')
  const clickedAt = Date.now()
  const clicked = await within(click.execute({ text: 'English' }), 30_000)
  await loaded(15_000)
  const landed = String(page.url)
  line('live-follow-link', landed.includes('en.wikipedia.org'), `${Date.now() - clickedAt} ms → ${landed.slice(0, 60)} · ${String(clicked?.text ?? '').split('\n')[0].slice(0, 40)}`)

  const nav = tool('sidecar_nav')
  await within(nav.execute({ back: true }), 20_000)
  await loaded(10_000)
  line('live-back', String(page.url).includes('www.wikipedia.org'), String(page.url).slice(0, 60))

  // A real article body: rows of list items with links in them.
  const more = await within(sidecar.ensure({ url: 'https://en.wikipedia.org/wiki/Web_scraping' }), 30_000)
  if (more === undefined || more?.timedOut === true) {
    line('live-list', false, 'en.wikipedia.org did not answer in 30 s')
  } else {
    await loaded()
    const extract = tool('sidecar_extract')
    const started = Date.now()
    const rows = String((await within(extract.execute({ select: '#mw-content-text ul > li', limit: 10 }), 30_000))?.text ?? '')
    const count = Number((rows.match(/^(\d+) of/) ?? [])[1] ?? 0)
    line('live-list', count >= 8 && rows.includes('· '), `${Date.now() - started} ms · ${count} rows · ${rows.length} chars · ${rows.split('\n')[1]?.slice(0, 60)}`)
  }

  // Typing into a real search box and pressing Enter, the way a person uses it.
  const home = await within(sidecar.ensure({ url: 'https://www.wikipedia.org/' }), 30_000)
  if (home === undefined || home?.timedOut === true) {
    line('live-search', false, 'wikipedia.org did not answer in 30 s')
  } else {
    await loaded()
    const typed = tool('sidecar_type')
    const shown = String((await within(view.execute({ max_chars: 1200 }), 20_000))?.text ?? '')
    const searchRef = Number((shown.match(/^(\d+) \[input\] [^\n]*[Ss]earch/m) ?? [])[1] ?? 0)
    const typedStart = Date.now()
    const wrote = String((await within(typed.execute({ ref: searchRef, text: 'browser automation', submit: true }), 30_000))?.text ?? '')
    await loaded(15_000)
    await sleep(500)
    line('live-search', searchRef > 0 && /Special:Search|browser automation/i.test(`${page.url} ${await title()}`), `${Date.now() - typedStart} ms · ref ${searchRef} · ${String(page.url).slice(0, 60)} · ${wrote.split('\n')[0].slice(0, 30)}`)
  }
} catch (error) {
  line('live-crashed', false, String(error?.message ?? error).slice(0, 120))
} finally {
  const pass = results.filter((row) => row.ok).length
  console.log(JSON.stringify({ summary: `${pass}/${results.length} live checks`, network: true }))
  await sidecar.shutdown()
  process.exit(0)
}
