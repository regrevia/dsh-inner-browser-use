import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BRIEF_JS } from '../tools.js'

const run = (activeElement) => {
  const document = { activeElement, body: {}, documentElement: {}, title: 't' }
  const location = { href: 'https://example.com/' }
  return new Function('document', 'location', `return ${BRIEF_JS}`)(document, location)
}

test('a focused password is never echoed back in a tool result', () => {
  const field = { type: 'password', value: 'DUMMY_SECRET_123', tagName: 'INPUT', name: 'pw', innerText: 'Password', getAttribute: () => null }
  assert.equal(run(field).focus.value, '', 'the secret stays in the page')
  const plain = { type: 'text', value: 'hello', tagName: 'INPUT', name: 'q', innerText: 'Search', getAttribute: () => null }
  assert.equal(run(plain).focus.value, 'hello', 'ordinary text still says what it holds')
})
