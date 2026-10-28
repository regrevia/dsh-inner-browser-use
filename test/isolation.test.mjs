import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isForeign } from '../sidecar.js'

test('a popup lookup never takes a tab another chat drives', () => {
  assert.equal(isForeign('B', 'A', ['B']), true, 'the other chat keeps its page')
  assert.equal(isForeign('C', 'A', ['B']), false, 'a genuinely new tab is this chat\'s to follow')
  assert.equal(isForeign('A', 'A', []), true, 'a page is not its own popup')
  assert.equal(isForeign('', 'A', []), true, 'no target, nothing to take')
})
