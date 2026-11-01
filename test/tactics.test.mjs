/**
 * A site is not a page: the same read is cheap on a wiki and expensive on an
 * app shell. These cases pin the learning that lets the second read of a site
 * cost less than the first, and the shape of the record it keeps.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const stateDir = mkdtempSync(join(tmpdir(), 'dsh-tactics-'))
process.env.DSH_INNER_BROWSER_STATE_DIR = stateDir

const { bigSite, loadTactics, longRead, noteRead, originOf, saveTactics, tacticsDir, tacticsOf } = await import('../tools.js')

test('a record belongs to the site, not the page', () => {
  assert.equal(originOf('https://Example.com/a?b=1#c'), 'https://example.com')
  assert.equal(originOf('http://example.com:8080/x'), 'http://example.com:8080')
  assert.equal(originOf('about:blank'), '')
  assert.equal(originOf('file:///tmp/a.html'), '')
  assert.equal(originOf(undefined), '')
})

test('big is a shape, not one odd page', () => {
  assert.equal(bigSite(null), false)
  assert.equal(bigSite({ reads: 1, chars: 99_999, controls: 900 }), false)
  assert.equal(bigSite({ reads: 2, chars: 3_500, controls: 10 }), true)
  assert.equal(bigSite({ reads: 2, chars: 100, controls: 60 }), true)
  assert.equal(bigSite({ reads: 2, chars: 100, controls: 59 }), false)
  assert.equal(bigSite({ reads: 4, chars: 900, controls: 12 }), false)
})

test('long text is the other kind of big', () => {
  assert.equal(longRead({ reads: 2, text: 6_000 }), true)
  assert.equal(longRead({ reads: 2, text: 5_999 }), false)
  assert.equal(longRead({ reads: 1, text: 40_000 }), false)
  assert.equal(longRead(null), false)
})

test('two reads teach the second one, and the file keeps it', async () => {
  await loadTactics()
  await noteRead('https://app.example.test/home', { chars: 4_000, controls: 20, ms: 300 })
  const once = tacticsOf('https://app.example.test/other')
  assert.equal(once.reads, 1)
  assert.equal(once.chars, 4_000)
  assert.equal(bigSite(once), false)
  await noteRead('https://app.example.test/home', { chars: 6_000, controls: 300, ms: 500 })
  const twice = tacticsOf('https://app.example.test/home')
  assert.equal(twice.reads, 2)
  /* 0.6 × 4000 + 0.4 × 6000, and the same drift on the controls. */
  assert.equal(twice.chars, 4_800)
  assert.equal(twice.controls, 132)
  assert.equal(bigSite(twice), true)
  /* A read that only measured text leaves the page measures where they were. */
  await noteRead('https://app.example.test/home', { text: 9_000 })
  assert.equal(tacticsOf('https://app.example.test/home').controls, 132)
  await saveTactics()
  const kept = JSON.parse(readFileSync(join(tacticsDir(), 'sites.json'), 'utf8'))
  assert.equal(kept['https://app.example.test'].reads, 3)
  /* Another process (or the next run) reads the same memory back. */
  const cold = await import(`../tools.js?sites=${Date.now()}`)
  await cold.loadTactics()
  assert.equal(cold.tacticsOf('https://app.example.test/anything').reads, 3)
  assert.equal(cold.bigSite(cold.tacticsOf('https://app.example.test/')), true)
})
