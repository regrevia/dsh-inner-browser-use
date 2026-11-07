/**
 * A sign-in that is already on this Mac, brought into the vault without an
 * extension, a pairing code, or a copy of anybody's profile: the cookie store
 * the browser itself keeps, opened, filtered to the one site being asked about
 * and sealed again by the vault. Nothing here talks to the network.
 *
 * The store is read from a copy, never from the live file: the browser holds a
 * lock on it, and a lock is not a reason to ask somebody to quit their browser.
 *
 * @module dsh-inner-browser-use/chromecookies
 */

import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { existsSync, mkdtempSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** The browsers this can read, most likely first. */
export const BROWSERS = [
  { id: 'chrome', label: 'Chrome', root: 'Google/Chrome' },
  { id: 'brave', label: 'Brave', root: 'BraveSoftware/Brave-Browser' },
  { id: 'edge', label: 'Edge', root: 'Microsoft Edge' },
  { id: 'chromium', label: 'Chromium', root: 'Chromium' },
]

/**
 * @param {any} error - a failed file operation.
 * @returns {boolean} whether the system refused a directory the app exists beside.
 */
function denied(error) {
  const code = String(error?.code ?? '')
  return code === 'EPERM' || code === 'EACCES'
}

/** Profile directories that are not a person's browser. */
const NOT_A_PROFILE = new Set(['System Profile', 'Guest Profile', 'Crashpad', 'ShaderCache', 'GrShaderCache', 'BrowserMetrics', 'component_crx_cache', 'extensions_crx_cache', 'Snapshots'])

/**
 * @param {string} id - a browser id.
 * @returns {string} where its profiles live, or '' on a platform this cannot read.
 */
export function browserRoot(id = 'chrome') {
  const one = BROWSERS.find((row) => row.id === id)
  if (one === undefined) return ''
  /* A profile root other than the standard one is only ever set by someone
     testing this, or by a person who moved their browser data. */
  const home = String(process.env.DSH_INNER_BROWSER_CHROME_HOME ?? process.env.HOME ?? '')
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', one.root)
  if (process.platform === 'win32') return join(String(process.env.LOCALAPPDATA ?? ''), one.root.replace(/\//gu, '\\'))
  return join(home, '.config', one.root.replace('Google/', 'google-').replace('BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser'))
}

/**
 * Every profile of a browser that keeps cookies, newest use first.
 * @param {string} id - a browser id.
 * @returns {Array<{profile: string, db: string, at: number}>} what can be read.
 */
export function cookieStores(id = 'chrome') {
  const root = browserRoot(id)
  if (root === '' || !existsSync(root)) return []
  let names = []
  try {
    names = readdirSync(root)
  } catch (error) {
    if (denied(error)) throw new Error('macOS will not let this app read the browser’s cookies: System Settings → Privacy & Security → Full Disk Access → turn on DSH, then try again')
    return []
  }
  const rows = []
  for (const name of names) {
    if (NOT_A_PROFILE.has(name) || name.startsWith('.')) continue
    const dir = join(root, name)
    /* Chrome 96 moved the store under Network/; older ones kept it beside the profile. */
    for (const rel of ['Network/Cookies', 'Cookies']) {
      const db = join(dir, rel)
      try {
        const stat = statSync(db)
        rows.push({ profile: name, db, at: Number(stat.mtimeMs) })
        break
      } catch {
        /* this profile does not keep its cookies here */
      }
    }
  }
  return rows.sort((a, b) => b.at - a.at)
}

/**
 * The password the browser used for its cookie encryption, from the macOS
 * keychain. Linux and Windows keep theirs elsewhere; this refuses rather than
 * guessing.
 * @returns {string} the password, or '' when it cannot be had.
 */
export function safeStorageKey() {
  if (process.platform !== 'darwin') return ''
  for (const args of [['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], ['find-generic-password', '-w', '-s', 'Chrome Safe Storage']]) {
    const out = spawnSync('security', args, { encoding: 'utf8', timeout: 5000 })
    const password = String(out.stdout ?? '').trim()
    if (out.status === 0 && password !== '') return password
  }
  return ''
}

/**
 * @param {string} password - the browser's safe-storage password.
 * @returns {Buffer} the AES key it derives.
 */
export function storeKey(password) {
  return pbkdf2Sync(String(password), 'saltysalt', 1003, 16, 'sha1')
}

/**
 * One stored cookie value, decrypted. Chrome prefixes the ciphertext with the
 * scheme; from v24 the plaintext also starts with the site's host hash. // ui-copy-ignore
 * @param {Buffer} blob - the encrypted_value bytes.
 * @param {Buffer} key - from storeKey.
 * @param {string} host - the cookie's host_key. // ui-copy-ignore
 * @returns {string} the value, or '' when this browser sealed it beyond reach.
 */
export function unsealCookie(blob, key, host) { // ui-copy-ignore
  if (!Buffer.isBuffer(blob) || blob.length === 0) return ''
  const scheme = String(blob.subarray(0, 3).toString('latin1'))
  if (scheme !== 'v10' && scheme !== 'v11') return ''
  const iv = Buffer.alloc(16, ' ')
  let plain = Buffer.alloc(0)
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv)
    plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()])
  } catch {
    return ''
  }
  const printed = createHash('sha256').update(String(host)).digest() // ui-copy-ignore
  if (plain.length > 32 && plain.subarray(0, 32).equals(printed)) plain = plain.subarray(32)
  return plain.toString('utf8')
}

/**
 * Copies a store somewhere it can be read while the browser is running, and
 * takes the copy away again even when the read fails.
 * @param {string} db - the live store.
 * @param {(copy: string) => any} work - what to do with the copy.
 * @returns {any} whatever work returned.
 */
function onCopy(db, work) {
  const dir = mkdtempSync(join(tmpdir(), 'dshib-cookies-'))
  try {
    const copy = join(dir, 'Cookies')
    copyFileSync(db, copy)
    for (const extra of ['-wal', '-shm']) {
      if (existsSync(`${db}${extra}`)) copyFileSync(`${db}${extra}`, `${copy}${extra}`)
    }
    return work(copy)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* Where a SQLite command line lives. It is not always /usr/bin/sqlite3: a
   Windows machine has no such folder, and a Mac with Homebrew may only have
   the one under /opt. Ask PATH first, then the usual places, and let the
   caller name its own binary. */
const SQLITE_PLACES = ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3', '/usr/local/bin/sqlite3']
let sqliteFound

/**
 * @returns {string} a SQLite command line that answers, or '' when there is none.
 */
export function sqliteCli() {
  if (sqliteFound !== undefined) return sqliteFound
  const asked = String(process.env.DSH_INNER_BROWSER_SQLITE3 ?? '')
  if (asked !== '') {
    sqliteFound = asked
    return asked
  }
  for (const one of ['sqlite3', ...SQLITE_PLACES]) {
    const probe = spawnSync(one, ['-version'], { encoding: 'utf8', timeout: 4000 })
    if (probe.status === 0) {
      sqliteFound = one
      return one
    }
  }
  sqliteFound = ''
  return ''
}

/**
 * @param {string} copy - the store copy.
 * @param {string} sql - one SELECT.
 * @returns {Array<object>} rows.
 */
function query(copy, sql) {
  try {
    /* Node 22+ ships SQLite; the CLI is the fallback so an older host still works. */ // ui-copy-ignore
    const mod = process.getBuiltinModule?.('node:sqlite')
    if (typeof mod?.DatabaseSync === 'function') {
      const db = new mod.DatabaseSync(copy, { readOnly: true })
      try {
        return db.prepare(sql).all()
      } finally {
        db.close()
      }
    }
  } catch {
    /* fall through to the command line */
  }
  const cli = sqliteCli()
  if (cli === '') return []
  const out = spawnSync(cli, ['-readonly', '-json', copy, sql], { encoding: 'utf8', timeout: 8000, maxBuffer: 4_000_000 })
  if (out.status !== 0) return []
  try {
    const rows = JSON.parse(String(out.stdout ?? '[]'))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/**
 * @param {number} micro - Chrome's expiry, microseconds since 1601.
 * @returns {number} milliseconds since 1970, or 0 for a session cookie.
 */
function expiresAt(micro) {
  const value = Number(micro ?? 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value / 1000) - 11644473600000
}

/** @param {number} value - Chrome's samesite column. @returns {string|undefined} the CDP name. */
function sameSite(value) {
  const at = Number(value ?? -1)
  if (at === 0) return 'None'
  if (at === 1) return 'Lax'
  if (at === 2) return 'Strict'
  return undefined
}

/**
 * The cookies of one site, ready for the vault. Values never leave this call.
 * @param {string} db - a store path.
 * @param {Buffer} key - from storeKey.
 * @param {string} host - the site, without a leading www. or a port. // ui-copy-ignore
 * @param {number} [cap] - how many to keep.
 * @returns {{cookies: object[], sealed: number}} the cookies and how many could not be opened.
 */
export function cookiesFor(db, key, host, cap = 80) { // ui-copy-ignore
  const site = String(host).replace(/^\./u, '').toLowerCase() // ui-copy-ignore
  if (site === '') return { cookies: [], sealed: 0 }
  const rows = onCopy(db, (copy) =>
    /* The sealed bytes travel as hex: a command-line driver writes a blob into
       JSON as text and loses bytes that are not valid UTF-8, so a sign-in read
       through it came back unreadable while the same store read through the
       built-in driver worked. Hex is exact through either. */ // ui-copy-ignore
    query(copy, 'SELECT host_key, name, value, hex(encrypted_value) AS enc_hex, path, expires_utc, is_secure, is_httponly, samesite FROM cookies'),
  )
  const cookies = []
  let sealed = 0
  for (const row of rows) {
    const domain = String(row?.host_key ?? '').replace(/^\./u, '').toLowerCase()
    if (domain === '' || !(site === domain || site.endsWith(`.${domain}`) || domain.endsWith(`.${site}`))) continue
    const raw = String(row?.name ?? '')
    if (raw === '') continue
    let value = String(row?.value ?? '')
    if (value === '') {
      const bytes = typeof row?.enc_hex === 'string' ? Buffer.from(row.enc_hex, 'hex') : normalizeBlob(row?.encrypted_value)
      value = unsealCookie(bytes, key, String(row?.host_key ?? ''))
    }
    if (value === '') {
      sealed += 1
      continue
    }
    const expires = expiresAt(row?.expires_utc)
    const cookie = {
      name: raw,
      value,
      domain,
      path: String(row?.path ?? '/'),
      secure: Number(row?.is_secure ?? 0) === 1,
      httpOnly: Number(row?.is_httponly ?? 0) === 1,
      session: expires === 0,
    }
    const same = sameSite(row?.samesite)
    if (same !== undefined) cookie.sameSite = same
    if (expires !== 0) cookie.expires = expires
    cookies.push(cookie)
    if (cookies.length >= cap) break
  }
  return { cookies, sealed }
}

/** @param {any} value - a blob column, from either SQLite driver. @returns {Buffer} its bytes. */
function normalizeBlob(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value, 'latin1')
  if (value !== null && typeof value === 'object' && value?.data !== undefined) return Buffer.from(value.data)
  return Buffer.alloc(0)
}

/**
 * @param {string} url - the page a sign-in is wanted for.
 * @returns {string} its host, without www., or ''. // ui-copy-ignore
 */
export function siteOf(url) {
  try {
    return String(new URL(String(url)).hostname).replace(/^www\./u, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Reads a site's sign-in out of the browser already on this Mac and says what
 * it found. Refuses with a reason when macOS will not let the cookie store be
 * read, which is the one failure a person can actually fix.
 * @param {{browser?: string, url?: string, host?: string, cap?: number}} options - which site, which browser. // ui-copy-ignore
 * @returns {{cookies: object[], browser: string, label: string, profile: string, sealed: number, at: number}} what was read.
 */
export function readBrowserCookies(options = {}) {
  const id = String(options.browser ?? 'chrome')
  const host = String(options.host ?? siteOf(String(options.url ?? ''))).toLowerCase() // ui-copy-ignore
  if (host === '') throw new Error('there is no site to import: open the page first') // ui-copy-ignore
  const stores = cookieStores(id)
  if (stores.length === 0) {
    const one = BROWSERS.find((row) => row.id === id)
    const where = browserRoot(id)
    const blocked = where !== '' && existsSync(where) === false
    throw new Error(blocked ? `${one?.label ?? id} is not installed on this Mac` : `no ${one?.label ?? id} profile keeps cookies here`)
  }
  /* The password the browser derived its key from. It is only ever taken from
     the keychain, or handed in by someone who keeps the key elsewhere. */
  const password = String(process.env.DSH_INNER_BROWSER_COOKIE_KEY ?? '') || safeStorageKey()
  if (password === '') throw new Error('the browser’s key is not in the keychain, so its cookies cannot be opened')
  const key = storeKey(password)
  for (const store of stores) {
    let read = { cookies: [], sealed: 0 }
    try {
      read = cookiesFor(store.db, key, host, Number(options.cap ?? 80)) // ui-copy-ignore
    } catch (error) {
      if (denied(error)) throw new Error('macOS will not let this app read the browser’s cookies: System Settings → Privacy & Security → Full Disk Access → turn on DSH, then try again')
      throw error
    }
    if (read.cookies.length === 0) continue
    const one = BROWSERS.find((row) => row.id === id)
    return { cookies: read.cookies, browser: id, label: one?.label ?? id, profile: store.profile, sealed: read.sealed, at: Date.now() }
  }
  throw new Error(`no ${BROWSERS.find((row) => row.id === id)?.label ?? id} profile is signed in to ${host}`) // ui-copy-ignore
}
