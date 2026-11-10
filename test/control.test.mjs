/**
 * The mirror has an owner, and the person can say so with one click. The words
 * the agent gets back must say which of the two states it is in: a six-second
 * hold is waited out, a takeover is waited for.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { holdText } from '../tools.js'

test('a takeover reads as control held, not as seconds to wait out', () => {
  const said = holdText({ taken: true, holding: () => 6000 })
  assert.match(said, /took control/)
  assert.doesNotMatch(said, /s more/, 'a takeover has no countdown to quote')
})

test('a short hold still says how long the person needs', () => {
  const said = holdText({ taken: false, holding: () => 4000 })
  assert.match(said, /4 s more/)
})

test('a free page has nothing to say', () => {
  assert.equal(holdText({ taken: false, holding: () => 0 }), '')
})
