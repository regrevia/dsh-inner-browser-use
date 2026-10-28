#!/usr/bin/env node
/**
 * What a page still needs Flash for, and whether this browser can give it.
 *
 *   node scripts/probe-flash.mjs http://aoqi.100bt.com/
 *
 * Prints the swf embeds, the frames that hold them, the text the page shows,
 * and what the browser answers when a page asks for the Flash plugin.
 * Its own profile, its own Chrome, both closed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'http://aoqi.100bt.com/'
const state = mkdtempSync(join(tmpdir(), 'dsh-flash-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = state

const { Sidecar } = await import('../sidecar.js')

/** @param {number} ms - how long. */
const wait = (ms) => new Promise((settle) => setTimeout(settle, ms))
const sidecar = new Sidecar({ profile: 'flash-check', headless: true })
let chrome = 0
try {
  await sidecar.launch(url)
  await wait(3000)
  const page = sidecar.page
  chrome = sidecar.child?.pid ?? 0
  const evalIn = async (expression) => {
    const reply = await page.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return reply?.result?.value
  }
  const report = await evalIn(`(() => {
    const clean = (u) => String(u || '').split('#')[0].slice(0, 200)
    const embeds = [...document.querySelectorAll('embed, object, param')].map((node) => ({
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type') || '',
      src: clean(node.getAttribute('src') || node.getAttribute('data') || node.getAttribute('movie') || node.getAttribute('value') || ''),
    })).filter((row) => /swf|shockwave|flash/i.test(row.type + ' ' + row.src))
    const swfLinks = [...document.querySelectorAll('a[href]')].map((a) => clean(a.href)).filter((h) => /\\.swf(\\?|$)/i.test(h))
    const frames = [...document.querySelectorAll('iframe[src], frame[src]')].map((f) => clean(f.getAttribute('src'))).slice(0, 12)
    const plugin = navigator.mimeTypes && navigator.mimeTypes['application/x-shockwave-flash']
    const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
    return { title: document.title, swfWithoutPlugin: plugin ? false : true, plugin: Boolean(plugin),
      embeds, swfLinks, frames, text, scripts: [...document.querySelectorAll('script[src]')].map((s) => clean(s.getAttribute('src'))).slice(0, 8) }
  })()`)
  console.log(JSON.stringify({ url, ...report }, null, 1))
} finally {
  try {
    await sidecar.shutdown()
  } catch {
    /* a browser already gone needs no shutdown */
  }
  if (chrome !== 0) {
    try {
      process.kill(chrome, 'SIGKILL')
    } catch {
      /* it went with the socket */
    }
  }
  rmSync(state, { recursive: true, force: true })
}
