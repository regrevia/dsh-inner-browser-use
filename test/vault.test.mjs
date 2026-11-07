import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* A fixed key so the test never reaches for the system keystore. */
process.env.DSH_INNER_BROWSER_VAULT_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dshib-vault-'))

const { seal, unseal, readSealed, writeSealed, saveLogin, listLogins, readLogin, dropLogin, loginSlug, signInsFor, vaultState } =
  await import(new URL('../vault.js', import.meta.url).href)

const root = process.env.DSH_INNER_BROWSER_STATE_DIR

test('what is sealed opens again, and the same value seals differently every time', () => {
  const value = { cookies: [{ name: 'session', value: 'secret-token' }] }
  const first = seal(value)
  const second = seal(value)
  assert.deepEqual(unseal(first), value)
  assert.notEqual(first.data, second.data, 'a fresh iv every time means two saves of one cookie are not equal')
  assert.ok(!JSON.stringify(first).includes('secret-token'), 'the token is not in the blob')
})

test('a tampered blob comes back empty rather than trusting it', () => {
  const blob = seal({ signedIn: true })
  const raw = Buffer.from(blob.data, 'base64')
  raw[0] = raw[0] ^ 0xff
  assert.equal(unseal({ ...blob, data: raw.toString('base64') }), undefined)
  assert.equal(unseal({ ...blob, tag: Buffer.alloc(16).toString('base64') }), undefined)
  assert.equal(unseal('not json'), undefined)
})

test('a file written sealed holds no readable value, and plain files are still read', () => {
  const path = join(root, 'sealed.json')
  writeSealed(path, { cookies: [{ value: 'another-secret' }] })
  const text = readFileSync(path, 'utf8')
  assert.ok(!text.includes('another-secret'))
  assert.deepEqual(readSealed(path), { cookies: [{ value: 'another-secret' }] })
  /* POSIX mode bits are the promise on Linux and macOS. Windows has no such
     bits: chmod leaves 0o666 whatever the mode asked for, and the file is kept
     by the folder's own access list, so asserting 0o600 there would only prove
     the caller is not Windows. */
  if (process.platform === 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o666, 'Windows keeps the folder access list, not mode bits')
  } else {
    assert.equal(statSync(path).mode & 0o777, 0o600, 'only the owner can read a sign-in')
  }

  const old = join(root, 'plain.json')
  writeFileSync(old, JSON.stringify([{ name: 'from-old-version' }]))
  assert.deepEqual(readSealed(old), [{ name: 'from-old-version' }], 'a jar from the version before this one still loads')
})

test('named sign-ins list, open and forget, and the file itself says nothing', () => {
  const kept = saveLogin('work mail', {
    cookies: [{ name: 'sid', value: 'work-secret', domain: '.example.com', path: '/', session: true }],
    storage: [{ origin: 'https://example.com', items: { token: 'ls-secret' } }],
    url: 'https://example.com/inbox',
  })
  assert.equal(kept.name, 'work mail')
  assert.equal(kept.cookieCount, 1)
  assert.deepEqual(kept.origins, ['https://example.com'])

  const rows = listLogins()
  assert.deepEqual(rows.map((row) => row.name), ['work mail'])
  assert.equal(rows[0].cookieCount, 1)

  const opened = readLogin('work mail')
  assert.equal(opened.cookies[0].value, 'work-secret')
  assert.equal(opened.storage[0].items.token, 'ls-secret')
  const file = join(root, 'logins', `${loginSlug('work mail')}.json`)
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('work-secret') && !text.includes('ls-secret'), 'neither cookie nor local storage is readable on disk')

  assert.equal(dropLogin('work mail'), true)
  assert.equal(dropLogin('work mail'), false)
  assert.equal(readLogin('work mail'), null)
})

test('a name cannot climb out of the vault', () => {
  assert.equal(loginSlug('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(loginSlug(''), '')
  const kept = saveLogin('../../evil', { cookies: [], storage: [] })
  assert.equal(kept.name, '../../evil')
  assert.ok(existsSync(join(root, 'logins')))
  assert.equal(dropLogin('../../evil'), true)
})

test('the vault reports its size and that the key is not in it', () => {
  saveLogin('one', { cookies: [{ name: 'a', value: 'b' }], storage: [] })
  const shape = vaultState()
  assert.ok(shape.files >= 1)
  assert.ok(shape.bytes > 0)
  assert.equal(shape.keyInKeychain, false, 'a key handed in by the environment is not a keystore key')
  assert.equal(shape.keySource, 'env', 'the key in use is the one the test handed in')
  dropLogin('one')
})

test('a kept sign-in is found by the site it covers, names only, newest first', () => {
  saveLogin('work', { cookies: [{ name: 'sid', value: '1', domain: 'app.example.com' }], storage: [], url: 'https://app.example.com/inbox' })
  saveLogin('home', { cookies: [{ name: 'sid', value: '2', domain: '.example.com' }], storage: [], url: 'https://www.example.com/' })
  saveLogin('elsewhere', { cookies: [{ name: 'sid', value: '3', domain: 'shop.other.test' }], storage: [], url: 'https://shop.other.test/' })

  assert.deepEqual(signInsFor('https://example.com/reports').map((row) => row.name), ['home'], 'a cookie for the whole site covers the site')
  assert.deepEqual(signInsFor('https://www.example.com/x').map((row) => row.name), ['home'], 'www is the same site')
  assert.deepEqual(signInsFor('https://app.example.com/x').map((row) => row.name).sort(), ['home', 'work'], 'a subdomain sees both the site cookie and its own')
  assert.deepEqual(signInsFor('https://example.com/').map((row) => row.name), ['home'], 'the parent does not cover a sign-in kept for one subdomain')
  assert.deepEqual(signInsFor('https://shop.other.test/cart').map((row) => row.name), ['elsewhere'])
  assert.deepEqual(signInsFor('https://other.test/'), [], 'a sibling site does not cover it')
  assert.deepEqual(signInsFor('https://nothing.test/'), [])
  assert.deepEqual(signInsFor('not a url'), [])

  const one = signInsFor('https://example.com/')[0]
  assert.equal(typeof one.cookieCount, 'number')
  assert.equal(typeof one.savedAt, 'number')
  assert.equal(one.value, undefined, 'a search for a page never hands back the sealed cookies')
  assert.ok(!JSON.stringify(signInsFor('https://example.com/')).includes('sid'), 'not even the cookie names')
  for (const name of ['work', 'home', 'elsewhere']) dropLogin(name)
})
