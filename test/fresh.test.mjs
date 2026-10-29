import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshRefs } from '../tools.js'

const read = (...refs) => ({ controls: refs.map((ref) => ({ ref, name: `c${ref}`, kind: 'link' })) })

test('the controls an action brought in are the ones that were not there before', () => {
  assert.deepEqual(freshRefs(read(1, 2, 3), read(1, 2, 3, 7, 8)), [7, 8])
})

test('a page that only lost controls has nothing new', () => {
  assert.deepEqual(freshRefs(read(1, 2, 3, 4), read(1, 2)), [])
})

test('the first read of a page claims nothing is new', () => {
  assert.deepEqual(freshRefs(undefined, read(1, 2)), [])
})

test('a ref is listed once even when it moved', () => {
  assert.deepEqual(freshRefs(read(1), { controls: [{ ref: 5 }, { ref: 5 }, { ref: 1 }] }), [5])
})

test('unreadable controls do not become phantom new numbers', () => {
  assert.deepEqual(freshRefs(read(1), { controls: [{ ref: -1 }, {}, { ref: 2 }] }), [2])
})

test('nothing to compare with is not an error', () => {
  assert.deepEqual(freshRefs(read(1), undefined), [])
  assert.deepEqual(freshRefs(null, null), [])
  assert.deepEqual(freshRefs({}, {}), [])
})
