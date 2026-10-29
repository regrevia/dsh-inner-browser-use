import assert from 'node:assert/strict'
import test from 'node:test'

import { diffRead, textChange } from '../tools.js'

/** A read of a page with one line of text and the controls a list has. */
function reading(text, controls = []) {
  return { url: 'https://example.test/list', title: 'List', text, controls, focused: null }
}

test('a page that moved one number is one short line, not the whole page', () => {
  const before = `${'row '.repeat(300)}count 7`
  const after = `${'row '.repeat(300)}count 8`
  const said = textChange(before, after)
  assert.ok(said.includes('[7]') && said.includes('[8]'), `both sides: ${said}`)
  assert.ok(said.length < 100, `short: ${said.length}`)
  const diff = diffRead(reading(before), reading(after))
  assert.ok(diff.length < 200, `the diff stays small: ${diff.length}`)
  assert.ok(!diff.includes('text now:'), 'does not resend the page')
})

test('a page replaced with an unrelated one is read in full instead of diffed', () => {
  assert.equal(textChange('aaaa bbbb cccc', 'zzzz yyyy xxxx'), '', 'nothing to compare')
  const diff = diffRead(reading('aaaa bbbb cccc'), reading('zzzz yyyy xxxx'))
  assert.ok(diff.includes('text now:'), 'the whole text, because it is all new')
})

test('the address appears once, changed or not', () => {
  const same = diffRead(reading('one'), reading('one'))
  assert.equal(same.split('https://example.test/list').length - 1, 1, 'the address once')
  const moved = { ...reading('one'), url: 'https://example.test/list#2' }
  const diff = diffRead(reading('one'), moved)
  assert.equal(diff.split('https://example.test/list#2').length - 1, 1, 'the new address once, not twice')
})
