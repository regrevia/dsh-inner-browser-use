import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* A path that only exists on one platform is a feature that only works there.
   These two shapes were shipped: a store read through /usr/bin/sqlite3, and
   scratch files written into /tmp. Both fail on Windows with nothing to show
   for it, so the source is checked rather than trusted. */
const root = fileURLToPath(new URL('..', import.meta.url))
const filesIn = (dir) => readdirSync(join(root, dir)).filter((one) => one.endsWith('.mjs')).map((one) => join(dir, one))

test('no worker script asks for a command line that only one platform has in that folder', () => {
  const guilty = [...filesIn('scripts'), ...filesIn('test')]
    .filter((one) => !one.endsWith('platform-paths.test.mjs'))
    .filter((one) => readFileSync(join(root, one), 'utf8').split('\n')
      /* A line that checks for the bad shape mentions it; only a line that
         would run it counts. */
      .some((line) => !line.includes('.includes(') && /spawnSync\(\s*['"]\/usr\/bin\//u.test(line)))
  assert.deepEqual(guilty, [], 'ask PATH first: a fixed /usr/bin path is missing on Windows')
})

test('no worker script writes into /tmp, which Windows does not have', () => {
  const guilty = filesIn('scripts')
    .filter((one) => /['"]\/tmp\//u.test(readFileSync(join(root, one), 'utf8')))
  assert.deepEqual(guilty, [], 'make the folder with mkdtempSync(join(tmpdir(), …)) instead')
})

test('the product finds its SQLite by asking PATH, and can be told which one', () => {
  const source = readFileSync(join(root, 'chromecookies.js'), 'utf8')
  assert.ok(source.includes("process.env.DSH_INNER_BROWSER_SQLITE3"), 'a host can name its own binary')
  assert.ok(!source.includes("spawnSync('/usr/bin/sqlite3'"), 'no platform is assumed')
})
