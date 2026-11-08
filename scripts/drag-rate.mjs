import { Sidecar } from '/Users/apple/Desktop/DSH/dsh-inner-browser-use/sidecar.js'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const html = `data:text/html,<body style="margin:0;width:3000px;height:1600px;background:%23f0f0f0">
<canvas id=c width=3000 height=1600></canvas>
<script>
window.__pts=[]
document.addEventListener('mousemove',(e)=>{window.__pts.push({t:Math.round(performance.now()),x:e.clientX,y:e.clientY})},true)
</script></body>`
const side = new Sidecar({ profile: 'drag-dbg' })
await side.launch(html)
const page = side.page
await wait(500)
const run = async (js) => { const r = await page.cdp.send('Runtime.evaluate', { expression: js, returnByValue: true }); return r?.result?.value }
const trace = async (gapMs, count = 50) => {
  await run('window.__pts=[]')
  const t0 = Date.now()
  for (let i = 0; i < count; i += 1) {
    const x = Math.round(20 + (i / (count - 1)) * 1900)
    const y = Math.round(400 + Math.sin(i / 6) * 200)
    await page.mouse('mouseMoved', { x, y })
    if (gapMs > 0) await wait(gapMs)
  }
  const took = Date.now() - t0
  await wait(300)
  const pts = JSON.parse(await run('JSON.stringify(window.__pts)'))
  let maxGap = 0
  for (let i = 1; i < pts.length; i += 1) maxGap = Math.max(maxGap, pts[i].t - pts[i - 1].t)
  return { gapMs, sent: count, seen: pts.length, took, perSec: Math.round((pts.length / took) * 1000), maxGapMs: maxGap, first: pts[0], last: pts.at(-1) }
}
const out = { current: await trace(40), faster: await trace(8), bare: await trace(0) }
console.log(JSON.stringify(out))
process.exit(0)
