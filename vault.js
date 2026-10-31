/**
 * Sign-in material at rest.
 *
 * A cookie jar is a password: whoever reads the file is signed in as the person.
 * Chrome keeps its own store encrypted, but the copy this plugin makes when a
 * session cookie would otherwise be dropped is a plain file, and a plain file in
 * a home directory is one backup or one shared folder away from being someone
 * else's session. Everything this plugin writes about a sign-in is therefore
 * sealed with AES-256-GCM, and the key lives in the system Keychain — not next
 * to the ciphertext, not in the profile, not in an environment variable by
 * default.
 *
 * What stays unsealed is a name and a timestamp, so the list of accounts can be
 * shown without opening the vault.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const KEYCHAIN_SERVICE = 'dsh-inner-browser-use-vault'
const KEY_BYTES = 32
const IV_BYTES = 12

/** @returns {string} where the browser state, and so the vault, lives. */
export function vaultRoot() {
  return process.env.DSH_INNER_BROWSER_STATE_DIR || join(homedir(), '.dsh', 'inner-browser-use')
}

/**
 * The key, in order of preference: the one this run was handed (tests, or a
 * person who keeps it in their own secret store), the one in the Keychain, the
 * one on disk with owner-only permissions. A missing key is created once and
 * then never rotated silently, because rotating it would sign everyone out.
 * @returns {Buffer} 32 bytes.
 */
export function vaultKey() {
  const given = String(process.env.DSH_INNER_BROWSER_VAULT_KEY ?? '')
  if (given !== '') {
    const raw = Buffer.from(given, 'base64')
    if (raw.length === KEY_BYTES) return raw
  }
  const fromKeychain = readKeychain()
  if (fromKeychain !== null) return fromKeychain
  const file = join(vaultRoot(), 'vault.key')
  if (existsSync(file)) {
    const raw = Buffer.from(String(readFileSync(file, 'utf8')).trim(), 'base64')
    if (raw.length === KEY_BYTES) return raw
  }
  const made = randomBytes(KEY_BYTES)
  const written = writeKeychain(made)
  if (written === true) return made
  mkdirSync(vaultRoot(), { recursive: true })
  writeFileSync(file, `${made.toString('base64')}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return made
}

/** @returns {Buffer|null} the Keychain copy, if this platform has one. */
function readKeychain() {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'vault', '-w'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const raw = Buffer.from(out.trim(), 'base64')
    return raw.length === KEY_BYTES ? raw : null
  } catch {
    return null
  }
}

/** @param {Buffer} key - the material. @returns {boolean} whether the Keychain took it. */
function writeKeychain(key) {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'vault', '-w', key.toString('base64')], {
      timeout: 4000,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/** @returns {'env'|'keychain'|'file'|'none'} which of the three the key in use came from. */
function keySource() {
  const given = String(process.env.DSH_INNER_BROWSER_VAULT_KEY ?? '')
  if (given !== '' && Buffer.from(given, 'base64').length === KEY_BYTES) return 'env'
  if (readKeychain() !== null) return 'keychain'
  const file = join(vaultRoot(), 'vault.key')
  if (existsSync(file)) {
    const raw = Buffer.from(String(readFileSync(file, 'utf8')).trim(), 'base64')
    if (raw.length === KEY_BYTES) return 'file'
  }
  return 'none'
}

/**
 * @param {unknown} value - anything JSON can hold.
 * @returns {{v: number, alg: string, iv: string, tag: string, data: string}} the sealed blob.
 */
export function seal(value) {
  const key = vaultKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()])
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/**
 * Opens a sealed blob. A tampered blob, a different key, or a plain array all
 * come back as `undefined` rather than as data that might be trusted.
 * @param {unknown} blob - what `seal` returned, or its JSON text.
 * @returns {any} the value, or undefined.
 */
export function unseal(blob) {
  let held = blob
  if (typeof held === 'string') {
    try {
      held = JSON.parse(held)
    } catch {
      return undefined
    }
  }
  if (held === null || typeof held !== 'object') return undefined
  const row = /** @type {any} */ (held)
  if (row.v !== 1 || row.alg !== 'aes-256-gcm') return undefined
  try {
    const key = vaultKey()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(row.iv), 'base64'))
    decipher.setAuthTag(Buffer.from(String(row.tag), 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(String(row.data), 'base64')), decipher.final()])
    return JSON.parse(text.toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reads a file that is either sealed or, from an older version, plain JSON.
 * @param {string} path - the file.
 * @returns {any} its value, or undefined.
 */
export function readSealed(path) {
  let text = ''
  try {
    text = String(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  const opened = unseal(text)
  if (opened !== undefined) return opened
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Writes a sealed file and makes sure nobody but the owner can read it, even if
 * it was created earlier with looser permissions.
 * @param {string} path - where.
 * @param {unknown} value - what.
 * @returns {void}
 */
export function writeSealed(path, value) {
  writeFileSync(path, `${JSON.stringify(seal(value))}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* a file system without permissions is not a reason to fail the save */
  }
}

/** @param {string} path - a directory. @returns {void} owner-only, best effort. */
export function tightenDir(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ logins */

/**
 * A name becomes a file name. Anything that could climb out of the directory or
 * collide on a case-insensitive file system is folded to a safe character.
 * @param {string} name - what the person called the account.
 * @returns {string} the file stem.
 */
export function loginSlug(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') return ''
  return raw
    .replace(/[^\w. -]/gu, '_')
    .replace(/\s+/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, 48)
}

/** @returns {string} where named accounts live. */
export function loginDir() {
  const dir = join(vaultRoot(), 'logins')
  tightenDir(dir)
  return dir
}

/**
 * @param {string} name - account name.
 * @returns {string} the file for it.
 */
function loginFile(name) {
  const slug = loginSlug(name)
  return slug === '' ? '' : join(loginDir(), `${slug}.json`)
}

/**
 * Keeps one account: cookies plus the local storage of the sites it was saved
 * on. Sealed as a whole, so even the list of sites is not readable off disk.
 * @param {string} name - account name.
 * @param {{cookies: object[], storage: Array<{origin: string, items: Record<string, string>}>, url?: string}} payload - what to keep.
 * @returns {{name: string, savedAt: number, cookieCount: number, origins: string[]}} what was written.
 */
export function saveLogin(name, payload) {
  const file = loginFile(name)
  if (file === '') throw new Error('a login needs a name')
  const cookies = Array.isArray(payload?.cookies) ? payload.cookies.slice(0, 400) : []
  const storage = Array.isArray(payload?.storage) ? payload.storage.slice(0, 40) : []
  const savedAt = Date.now()
  writeSealed(file, {
    name: String(name).trim().slice(0, 80),
    savedAt,
    url: String(payload?.url ?? ''),
    cookies,
    storage,
  })
  return {
    name: String(name).trim().slice(0, 80),
    savedAt,
    cookieCount: cookies.length,
    origins: storage.map((row) => String(row?.origin ?? '')).filter(Boolean),
  }
}

/**
 * @param {string} name - account name.
 * @returns {any|null} the kept account, or null.
 */
export function readLogin(name) {
  const file = loginFile(name)
  if (file === '' || !existsSync(file)) return null
  const held = readSealed(file)
  return held === undefined ? null : held
}

/**
 * Everything in the vault, newest first. Only the envelope is needed for the
 * list, but the envelope is sealed too, so this opens each file.
 * @returns {Array<{name: string, savedAt: number, cookieCount: number, origins: string[]}>} the accounts.
 */
export function listLogins() {
  const dir = loginDir()
  const rows = []
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return rows
  }
  for (const name of names) {
    const held = readSealed(join(dir, name))
    if (held === null || typeof held !== 'object') continue
    rows.push({
      name: String(held.name ?? name.replace(/\.json$/u, '')),
      savedAt: Number(held.savedAt ?? 0),
      cookieCount: Array.isArray(held.cookies) ? held.cookies.length : 0,
      origins: Array.isArray(held.storage) ? held.storage.map((row) => String(row?.origin ?? '')).filter(Boolean) : [],
    })
  }
  return rows.sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * @param {string} name - account name.
 * @returns {boolean} whether something was there to remove.
 */
export function dropLogin(name) {
  const file = loginFile(name)
  if (file === '' || !existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

/**
 * How big the vault is, and whether the key is outside it: the two facts a
 * person wants when deciding whether a sign-in is safe to leave here.
 * @returns {{files: number, bytes: number, keyInKeychain: boolean, keySource: string}} the shape.
 */
export function vaultState() {
  const dir = loginDir()
  let files = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      files += 1
      bytes += statSync(join(dir, name)).size
    }
  } catch {
    /* an empty vault is a valid vault */
  }
  const source = keySource()
  return { files, bytes, keyInKeychain: source === 'keychain', keySource: source }
}

/** @param {string} path - two files. @param {Buffer} a - one. @param {Buffer} b - the other. @returns {boolean} same bytes. */
export function sameKey(a, b) {
  return a.length === b.length && timingSafeEqual(a, b)
}
