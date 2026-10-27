#!/usr/bin/env node
/**
 * Ask a running DSH whether the mirror is only ever served to the session that
 * opened it. Read-only: it never opens, navigates or closes anything.
 *
 *   node scripts/live-safety.mjs [http://127.0.0.1:PORT]
 *
 * The bar is three answers on one line each: a foreign session is refused a
 * frame stream and refused a navigation, and the owning session still gets its
 * stream. No owner means nothing is open, which is not a failure.
 */
const base = String(process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:49552').replace(/\/+$/, '')
const route = `${base}/dsh-inner-browser-use`

const status = async (path, init) => {
  const reply = await fetch(`${route}${path}`, { ...init, signal: AbortSignal.timeout(5000) })
  await reply.arrayBuffer()
  return reply.status
}

const stateReply = await fetch(`${route}/state`, { signal: AbortSignal.timeout(5000) })
const state = await stateReply.json()
const owner = String(state.owner ?? '')
console.log(`${state.alive === true ? 'open' : 'closed'} · owner ${owner === '' ? 'none' : 'one session'}`)

const checks = []
checks.push(['foreign stream refused', await status('/sidecar/frames?session=not-the-owner') === 403])
checks.push([
  'foreign navigation refused',
  await status('/sidecar/nav', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'not-the-owner', url: 'https://example.com/' }),
  }) === 403,
])
if (owner !== '') {
  checks.push([`owner stream served`, await status(`/sidecar/frames?session=${encodeURIComponent(owner)}`) === 200])
}

let bad = 0
for (const [what, ok] of checks) {
  if (ok !== true) bad += 1
  console.log(`${ok === true ? 'true' : 'FALSE'} ${what}`)
}
process.exitCode = bad === 0 ? 0 : 1
