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

  const view = tool('browser_view')
  const read = String((await within(view.execute({ max_chars: 700 }), 20_000))?.text ?? '')
  line('live-read', read.includes('Example Domain') && /\[link\]/.test(read), `${read.length} chars · ${read.split('\n')[1]?.slice(0, 50)}`)

  // A page whose only control is a link: click it by its words and land on the
  // page it points at. example.com's own link goes to iana.org, which answers on
  // this network; wikipedia.org was dropped here because its redirect does not.
  const click = tool('browser_click')
  const nav = tool('browser_nav')
  const clickedAt = Date.now()
  const clicked = await within(click.execute({ text: 'Learn more' }), 30_000)
  await loaded(15_000)
  const landed = String(page.url)
  line('live-follow-link', landed.includes('iana.org'), `${Date.now() - clickedAt} ms → ${landed.slice(0, 60)} · ${String(clicked?.text ?? '').split('\n')[0].slice(0, 40)}`)

  await within(nav.execute({ back: true }), 20_000)
  await loaded(10_000)
  line('live-back', String(page.url).includes('example.com'), String(page.url).slice(0, 60))

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
    const deadClick = String((await within(tool('browser_click').execute({ text: '重新加载' }), 20_000))?.text ?? '')
    const deadBatch = String((await within(tool('browser_do').execute({ steps: [{ tap: 'Reload' }], read: 'none' }), 20_000))?.text ?? '')
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
    const batch = tool('browser_do')
    const typedStart = Date.now()
    const wrote = String((await within(batch.execute({ steps: [{ field: '搜索词', text: 'browser automation', submit: true }], read: 'text', max_chars: 500 }), 45_000))?.text ?? '')
    await loaded(15_000)
    await sleep(500)
    const landedOn = String(page.url)
    const results = /\/search\?/.test(landedOn) && /browser automation/i.test(await title())
    line('live-search', results, `${Date.now() - typedStart} ms · ${landedOn.slice(0, 60)} · ${wrote.split('\n')[0].slice(0, 40)}`)

    // Rows of results with links in them: a real list to read as rows.
    const extract = tool('browser_extract')
    const listedAt = Date.now()
    const rows = String((await within(extract.execute({ select: '#b_results > li', limit: 10 }), 30_000))?.text ?? '')
    const count = Number((rows.match(/^(\d+) of/) ?? [])[1] ?? 0)
    line('live-list', count >= 5 && rows.includes('· '), `${Date.now() - listedAt} ms · ${count} rows · ${rows.length} chars · ${rows.split('\n')[1]?.slice(0, 60)}`)

    /* The everyday stale ref: the page redraws itself and the number from the
       last read stops pointing at the control while the control stays on
       screen. One call carries on instead of costing a read and a fresh turn. */
    const resultState = { last: undefined }
    const resultTools = sidecarTools(sidecar, resultState)
    const before = Date.now()
    await resultTools.find((each) => each.name === 'browser_view').execute({ mode: 'text', max_chars: 500 })
    const link = (resultState.refs ?? []).find((each) => each.kind === 'link' && each.href.startsWith('http'))
    const moved = link === undefined ? 'no link numbered' : String(await said(`(() => {
      const gone = ${JSON.stringify(String(link.name))}
      const all = Array.from(document.querySelectorAll('a'))
      const found = all.find((a) => (a.textContent || '').trim().startsWith(gone.slice(0, 12)))
      if (found === undefined) return 'no match'
      found.replaceWith(found.cloneNode(true))
      return 'redrew a'
    })()`))
    const carried = link === undefined ? 'nothing to use' : String((await within(resultTools.find((each) => each.name === 'browser_click').execute({ ref: link.ref, read: false }), 30_000))?.text ?? '')
    line('live-redraw-survives', moved === 'redrew a' && carried.includes('new number'), `${Date.now() - before} ms · ${moved} · ${carried.replace(/\n/g, ' / ').slice(0, 110)}`)
  }
} catch (error) {
  line('live-crashed', false, String(error?.message ?? error).slice(0, 120))
} finally {
  const pass = results.filter((row) => row.ok).length
  console.log(JSON.stringify({ summary: `${pass}/${results.length} live checks`, network: true }))
  await sidecar.shutdown()
  process.exitCode = 0
}
