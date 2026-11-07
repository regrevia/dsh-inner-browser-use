import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* A browser's cookie store, encrypted the way the browser itself encrypts it,
   in a throwaway home: the import path is exercised for real without reading
   anybody's actual browser. A key that is not in the keychain is handed in
   directly, so the test never asks the system for a password. */
const KEY_PASSWORD = 'test-safe-storage-password'
const home = mkdtempSync(join(tmpdir(), 'dshib-chrome-'))
process.env.DSH_INNER_BROWSER_CHROME_HOME = home
process.env.DSH_INNER_BROWSER_COOKIE_KEY = KEY_PASSWORD
/* Windows reads its browser data from LOCALAPPDATA, not from a home folder. */
if (process.platform === 'win32') process.env.LOCALAPPDATA = home

const { storeKey, unsealCookie, cookiesFor, cookieStores, readBrowserCookies, siteOf, browserRoot, sqliteCli, BROWSERS } =
  await import(new URL('../chromecookies.js', import.meta.url).href)

/* A store is a real SQLite file, so building one needs a SQLite. Node 22+ has
   one built in; older hosts fall back to a command line that is not always
   where a Mac keeps it, so ask the product's own resolver. */
const sqlite = sqliteCli()
const keyPassword = KEY_PASSWORD

const key = storeKey(KEY_PASSWORD)

/** @param {string} host - cookie host_key. @param {string} value - the plaintext. @returns {Buffer} what the browser stores. */
function seal(host, value) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  const hash = createHash('sha256').update(host).digest()
  return Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(Buffer.concat([hash, Buffer.from(value, 'utf8')])), cipher.final()])
}

/** @param {string} rel - profile subpath. @returns {string} a store path that can be read. */
function makeStore(rel) {
  const dir = join(browserRoot('chrome'), rel, 'Network')
  mkdirSync(dir, { recursive: true })
  const db = join(dir, 'Cookies')
  const hex = (blob) => `X'${Buffer.from(blob).toString('hex')}'`
  const sql = 'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);'
    + ` INSERT INTO cookies VALUES ('.example.com','sid','',${hex(seal('.example.com', 'sealed-value'))},'/',13500000000000000,1,1,1);`
    + ` INSERT INTO cookies VALUES ('example.com','plain','readable','','/',13500000000000000,0,0,-1);`
    + ` INSERT INTO cookies VALUES ('.example.com','session','',${hex(seal('.example.com', 'short'))},'/',0,0,0,2);`
    + ` INSERT INTO cookies VALUES ('.example.com','lost','',${hex(Buffer.from('v20not-ours', 'latin1'))},'/',0,0,0,-1);`
    + ` INSERT INTO cookies VALUES ('.elsewhere.test','other','',${hex(seal('.elsewhere.test', 'nope'))},'/',0,0,0,-1);`
  const built = spawnSync(sqlite, [db], { input: sql, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)
  return db
}

test('the site is the host a sign-in belongs to, without the noise around it', () => {
  assert.equal(siteOf('https://www.example.com/a/b?c=1'), 'example.com')
  assert.equal(siteOf('http://127.0.0.1:8080/x'), '127.0.0.1')
  assert.equal(siteOf('not a url'), '')
  assert.equal(siteOf(''), '')
})

test('a value the browser sealed opens, and one it sealed for another site does not', () => {
  const blob = seal('.example.com', 'hello')
  assert.equal(unsealCookie(blob, key, '.example.com'), 'hello')
  assert.notEqual(unsealCookie(blob, key, '.other.test'), 'hello', 'a value is bound to the host it was sealed for: read under another name it does not come back cleanly')
  assert.equal(unsealCookie(Buffer.from('', 'latin1'), key, '.example.com'), '')
  assert.equal(unsealCookie(Buffer.from('plain', 'latin1'), key, '.example.com'), '', 'only the browser scheme is opened')
  assert.equal(unsealCookie(blob.subarray(0, 8), key, '.example.com'), '')
  assert.notEqual(storeKey('one').toString('hex'), storeKey('two').toString('hex'))
})

test('only the cookies of the site asked about come back, decrypted and shaped for a browser', { skip: sqlite === '' ? 'this host has no SQLite to build a store with' : false }, () => {
  const db = makeStore('Default')
  const read = cookiesFor(db, key, 'example.com')
  assert.deepEqual(read.cookies.map((row) => row.name).sort(), ['plain', 'session', 'sid'], 'another site is not imported and an unreadable one is skipped')
  assert.equal(read.sealed, 1, 'what could not be opened is counted rather than guessed')
  const sid = read.cookies.find((row) => row.name === 'sid')
  assert.equal(sid.value, 'sealed-value')
  assert.equal(sid.domain, 'example.com', 'the leading dot is dropped so a browser accepts it')
  assert.equal(sid.secure, true)
  assert.equal(sid.httpOnly, true)
  assert.equal(sid.sameSite, 'Lax')
  assert.equal(sid.session, false)
  assert.ok(sid.expires > Date.now(), 'a kept expiry is a future date, not a raw microsecond count')
  const short = read.cookies.find((row) => row.name === 'session')
  assert.equal(short.session, true, 'an expiry of zero is a session cookie')
  assert.equal(short.sameSite, 'Strict')
  assert.equal(read.cookies.find((row) => row.name === 'plain').value, 'readable')
})

test('a subdomain of the site imports too, and the site itself matches a parent domain', { skip: sqlite === '' ? 'this host has no SQLite to build a store with' : false }, () => {
  const db = makeStore('Profile 1')
  assert.equal(cookiesFor(db, key, 'app.example.com').cookies.length, 3, 'the site sees its parent domain cookies, and the unreadable one is only counted')
  assert.equal(cookiesFor(db, key, 'elsewhere.test').cookies.length, 1)
  assert.deepEqual(cookiesFor(db, key, 'nothing.test').cookies, [])
  assert.deepEqual(cookiesFor(db, key, '').cookies, [])
})

test('profiles are found where the browser keeps them, newest use first, and junk is skipped', { skip: sqlite === '' ? 'this host has no SQLite to build a store with' : false }, () => {
  const rows = cookieStores('chrome')
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((row) => row.db.endsWith('Cookies')))
  assert.ok(!rows.some((row) => row.profile === 'Crashpad'))
  const expected = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Google', 'Chrome')
    : process.platform === 'win32' ? join(home, 'Google', 'Chrome') : join(home, '.config', 'google-chrome')
  assert.equal(browserRoot('chrome'), expected, 'the browser keeps its profiles where this platform keeps them')
  assert.ok(BROWSERS.some((one) => one.id === 'chrome'))
})

test('importing says what it found and refuses with a reason when there is nothing', { skip: sqlite === '' ? 'this host has no SQLite to build a store with' : false }, () => {
  const found = readBrowserCookies({ url: 'https://example.com/account' })
  assert.equal(found.browser, 'chrome')
  assert.equal(found.label, 'Chrome')
  assert.ok(found.profile !== '')
  assert.equal(found.cookies.length >= 3, true)
  assert.equal(typeof found.at, 'number')
  assert.throws(() => readBrowserCookies({ url: 'https://nothing.test/' }), /no Chrome profile is signed in to nothing\.test/u)
  assert.throws(() => readBrowserCookies({ url: 'https://example.com/', browser: 'brave' }), /Brave is not installed|no Brave profile/u)
  assert.throws(() => readBrowserCookies({ url: '' }), /open the page first/u)
})

test('the store is read from a copy, so nothing is left behind and the original is untouched', { skip: sqlite === '' ? 'this host has no SQLite to build a store with' : false }, () => {
  const db = cookieStores('chrome')[0].db
  const before = spawnSync(sqlite, [db, 'SELECT COUNT(*) FROM cookies'], { encoding: 'utf8' }).stdout.trim()
  cookiesFor(db, key, 'example.com')
  const after = spawnSync(sqlite, [db, 'SELECT COUNT(*) FROM cookies'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(after, before)
})

test.after(() => {
  delete process.env.DSH_INNER_BROWSER_CHROME_HOME
  delete process.env.DSH_INNER_BROWSER_COOKIE_KEY
  rmSync(home, { recursive: true, force: true })
})

test('the store is read by whatever SQLite this host has, not by a Mac-only path', () => {
  /* `/usr/bin/sqlite3` does not exist on Windows, so a store could not be read
     there at all. The path asks PATH first and accepts a named binary. */
  const source = readFileSync(new URL('../chromecookies.js', import.meta.url), 'utf8')
  assert.ok(!source.includes("spawnSync('/usr/bin/sqlite3'"), 'no command line is named in full')
  assert.ok(source.includes("spawnSync(cli,"), 'the resolver decides which one runs')
  assert.ok(source.includes("'sqlite3', ...SQLITE_PLACES"), 'PATH is asked before the usual folders')
})
