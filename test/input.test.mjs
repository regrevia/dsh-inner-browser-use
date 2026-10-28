import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KEYS, pressChord, pressKey } from '../tools.js'

/** A page that only records the key events it is given. */
function recorder() {
  const seen = []
  return {
    seen,
    key: async (type, one) => {
      seen.push({ type, key: one.key, code: one.code, at: Date.now() })
    },
  }
}

test('a letter is a key a game can hold', async () => {
  assert.equal(KEYS.d.code, 'KeyD')
  assert.equal(KEYS.D.keyCode, 68)
  assert.equal(KEYS['7'].code, 'Digit7')
  const page = recorder()
  await pressKey(page, 'd', 0, 40)
  assert.deepEqual(page.seen.map((row) => row.type), ['keyDown', 'keyUp'])
  assert.ok(page.seen[1].at - page.seen[0].at >= 35)
})

test('a chord goes down together and comes up in reverse', async () => {
  const page = recorder()
  await pressChord(page, ['ArrowLeft', 'ArrowUp'], 0, 20)
  assert.deepEqual(page.seen.map((row) => `${row.type}:${row.key}`), [
    'keyDown:ArrowLeft',
    'keyDown:ArrowUp',
    'keyUp:ArrowUp',
    'keyUp:ArrowLeft',
  ])
  assert.ok(page.seen[2].at - page.seen[0].at >= 15)
})

test('an unknown key still says so instead of pressing nothing', async () => {
  await assert.rejects(() => pressChord(recorder(), ['NotAKey'], 0, 0), /no such key/)
})

test('holding is a documented argument, not something the model has to guess', () => {
  const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(source, /hold_ms: \{ type: 'integer'/)
  assert.equal(source.includes('hold_ms: { type: \'integer\''), true)
  assert.equal(source.includes('if (hold === 0) await settle(page, 3000)'), true)
})
