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

  // A dead host: the browser stops on its own error page, which is not the site.
  // Reading it back must say the network failed, not quote "This site can't be
  // reached" as if it were page content — and the browser must recover after.
  const deadAt = Date.now()
  const dead = await within(sidecar.ensure({ url: 'https://never-resolves-this.invalid/' }), 30_000)
  if (dead === undefined || dead?.timedOut === true) {
    line('live-dead-host', false, 'the invalid host never even failed')
  } else {
    await sleep(1200)
    const deadRead = String((await within(view.execute({ max_chars: 700 }), 20_000))?.text ?? '')
    const named = /the network could not reach that address/.test(deadRead)
    const quoted = /ERR_[A-Z0-9_]+|can.t be reached|无法访问/.test(deadRead) && !named
    // A read is the obvious case; a click and a batch are the ones that would
    // otherwise press "Reload" on Chrome's page and call it progress.
    const deadClick = String((await within(tool('sidecar_click').execute({ text: '重新加载' }), 20_000))?.text ?? '')
    const deadBatch = String((await within(tool('sidecar_do').execute({ steps: [{ tap: 'Reload' }], read: 'none' }), 20_000))?.text ?? '')
    const allNamed = [deadRead, deadClick, deadBatch].every((said) => /the network could not reach that address/.test(said))
    line('live-dead-host', named && !quoted && allNamed, `${Date.now() - deadAt} ms · ${String(page.url).slice(0, 40)} · read/click/batch all refused · ${deadRead.split('\n')[0].slice(0, 70)}`)
    // The recovery is the other half of the promise: a real address still works.
    await within(nav.execute({ url: 'https://example.com/' }), 30_000)
    const back = await loaded(15_000)
    line('live-dead-host-recovers', back && (await title()) === 'Example Domain', `${back ? 'back on a real page' : 'stuck'} · ${String(page.url).slice(0, 50)}`)
  }

  // Typing into a real search box and pressing Enter, the way a person uses it.
  // By the box's own words rather than a control number: a search box is a
  // combobox on one engine and an input on another, and the words are the part
  // a person reads. wikipedia.org was dropped as the host here — its home page
  // answers while its search redirect times out on this network, which failed
  // this check three runs running and said nothing about the tools.
  const home = await within(sidecar.ensure({ url: 'https://www.bing.com/' }), 30_000)
  if (home === undefined || home?.timedOut === true) {
    line('live-search', false, 'bing.com did not answer in 30 s')
  } else {
    await loaded()
    const batch = tool('sidecar_do')
    const typedStart = Date.now()
    const wrote = String((await within(batch.execute({ steps: [{ field: '搜索词', text: 'browser automation', submit: true }], read: 'text', max_chars: 500 }), 45_000))?.text ?? '')
    await loaded(15_000)
    await sleep(500)
    const landedOn = String(page.url)
    const results = /\/search\?/.test(landedOn) && /browser automation/i.test(await title())
    line('live-search', results, `${Date.now() - typedStart} ms · ${landedOn.slice(0, 60)} · ${wrote.split('\n')[0].slice(0, 40)}`)
  }
} catch (error) {
  line('live-crashed', false, String(error?.message ?? error).slice(0, 120))
} finally {
  const pass = results.filter((row) => row.ok).length
  console.log(JSON.stringify({ summary: `${pass}/${results.length} live checks`, network: true }))
  await sidecar.shutdown()
  process.exit(0)
}
