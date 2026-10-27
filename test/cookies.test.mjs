import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Sidecar } from '../sidecar.js'

const dir = join(homedir(), '.dsh', 'inner-browser-use', 'chrome', 'unit-cookie')
const jar = join(dir, 'session-cookies.json')

/** A sidecar whose page answers with the cookies given, and records writes. */
function stub(cookies) {
  const sidecar = new Sidecar({ profile: 'unit-cookie' })
  const written = []
  sidecar.page = {
    cookies: async () => cookies,
    setCookie: async (cookie) => {
      written.push(cookie)
      return { ok: true }
    },
  }
  return { sidecar, written }
}

test('a sign-in cookie is kept, a dated one is left to the browser', async () => {
  rmSync(jar, { force: true })
  const { sidecar } = stub([
    { name: 'session', value: 'a', domain: '.example.com', path: '/', session: true, expires: -1 },
    { name: 'dated', value: 'b', domain: 'example.com', path: '/', session: false, expires: 2_000_000_000 },
  ])
  await sidecar.saveSessionCookies()
  const kept = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(jar, 'utf8')))
  assert.deepEqual(kept.map((c) => c.name), ['session'])
})

test('what was kept comes back on the next launch', async () => {
  const { sidecar, written } = stub([])
  await sidecar.restoreSessionCookies()
  assert.deepEqual(written, [
    { name: 'session', value: 'a', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: undefined },
  ])
  rmSync(dir, { recursive: true, force: true })
})

test('no sign-in cookies means no file to restore', async () => {
  const { sidecar } = stub([{ name: 'dated', value: 'b', domain: 'example.com', session: false, expires: 2_000_000_000 }])
  await sidecar.saveSessionCookies()
  assert.equal(existsSync(jar), false)
  const { sidecar: other, written } = stub([])
  await other.restoreSessionCookies()
  assert.deepEqual(written, [])
  rmSync(dir, { recursive: true, force: true })
})
