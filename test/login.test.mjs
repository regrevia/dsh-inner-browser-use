import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.DSH_INNER_BROWSER_STATE_DIR = mkdtempSync(join(tmpdir(), 'dshib-login-'))
const { snapshotLogin, restoreLogin, loginBackupDir } = await import('/Users/apple/Desktop/DSH/dsh-inner-browser-use/sidecar.js')

test('a working cookie store is kept and put back when the profile loses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshib-prof-'))
  mkdirSync(join(dir, 'Default'), { recursive: true })
  writeFileSync(join(dir, 'Local State'), '{"os_crypt":{}}')
  writeFileSync(join(dir, 'Default/Cookies'), 'x'.repeat(4096))
  assert.equal(restoreLogin(dir), false, 'nothing to restore while the store is there')
  assert.ok(snapshotLogin(dir) > 0)
  rmSync(join(dir, 'Default/Cookies'))
  assert.equal(restoreLogin(dir), true, 'the copy comes back')
  assert.equal(readFileSync(join(dir, 'Default/Cookies'), 'utf8').length, 4096)
  assert.ok(existsSync(loginBackupDir(dir)))
})
