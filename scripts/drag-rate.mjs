#!/usr/bin/env node
/**
 * How many points of a drag actually reach the page, per second.
 *
 * The pane sends a hover point for every move the hand makes, but it used to
 * hold each one for 40 ms — a slow curve arrived as a polyline the page could
 * see (fifteen points a second). This probe drives one page through the same
 * pipe at three paces and asks the page how many moves it received and how far
 * apart they were, so the pane's gate is a number instead of a claim.
 *
 *   node scripts/drag-rate.mjs            # one JSON line
 *   node scripts/drag-rate.mjs --pretty    # one indented block
 */

import { Sidecar } from '../sidecar.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const HTML = `data:text/html,<body style="margin:0;width:3000px;height:1600px;background:%23f0f0f0">
<canvas id=c width=3000 height=1600></canvas>
<script>
window.__pts=[]
document.addEventListener('mousemove',(e)=>{window.__pts.push({t:Math.round(performance.now()),x:e.clientX,y:e.clientY})},true)
</script></body>`

const sidecar = new Sidecar({ profile: 'drag-rate' })
try {
  await sidecar.launch(HTML)
  const page = sidecar.page
  await wait(500)
  const run = async (js) => {
    const answer = await page.cdp.send('Runtime.evaluate', { expression: js, returnByValue: true })
    return answer?.result?.value
  }

  /* One curve, three paces. The count is fixed so the only variable is how
     long the pipe holds each point. */
  const trace = async (gapMs, count = 50) => {
    await run('window.__pts=[]')
    const startedAt = Date.now()
    for (let i = 0; i < count; i += 1) {
      const x = Math.round(20 + (i / (count - 1)) * 1900)
      const y = Math.round(400 + Math.sin(i / 6) * 200)
      await page.mouse('mouseMoved', { x, y })
      if (gapMs > 0) await wait(gapMs)
    }
    const took = Date.now() - startedAt
    await wait(300)
    const points = JSON.parse(await run('JSON.stringify(window.__pts)'))
    let maxGapMs = 0
    for (let i = 1; i < points.length; i += 1) maxGapMs = Math.max(maxGapMs, points[i].t - points[i - 1].t)
    return {
      gapMs,
      sent: count,
      seen: points.length,
      took,
      perSec: Math.round((points.length / took) * 1000),
      maxGapMs,
      first: points[0] ?? null,
      last: points.at(-1) ?? null,
    }
  }

  const out = { current: await trace(40), faster: await trace(8), bare: await trace(0) }
  const plain = process.argv.includes('--pretty')
  console.log(plain ? JSON.stringify(out, null, 2) : JSON.stringify(out))
} finally {
  await sidecar.shutdown().catch(() => {})
}
