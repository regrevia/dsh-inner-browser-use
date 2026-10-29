import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readPage, renderPage } from '../read.js'

/** A page whose Runtime.evaluate answers with a thrown page script. */
function throwingPage(description = 'Error: hostile page broke the DOM reader\n    at <anonymous>:1:1') {
  return {
    url: 'https://example.com/hostile',
    title: 'hostile page',
    cdp: { send: async () => ({ result: {}, exceptionDetails: { exception: { description } } }) },
  }
}

test('a page script that throws is reported, not read as empty', async () => {
  const read = await readPage(throwingPage())
  assert.equal(read.controls.length, 0)
  assert.match(String(read.fault), /page's own script failed/)
  assert.match(String(read.fault), /hostile page broke the DOM reader/)
  assert.equal(read.url, 'https://example.com/hostile')
})

test('the fault reaches the rendered read as one line', async () => {
  const read = await readPage(throwingPage())
  const text = renderPage(read, { mode: 'text', maxChars: 1200 })
  assert.match(text, /did not answer when read/)
  assert.match(text, /hostile page broke the DOM reader/)
})

test('a frame that is gone is reported as not answering', async () => {
  const page = {
    url: 'https://example.com/a',
    title: 'a',
    cdp: { send: async () => { throw new Error('Cannot find context with specified id') } },
  }
  const read = await readPage(page)
  assert.match(String(read.fault), /did not answer/)
  assert.match(String(read.fault), /Cannot find context/)
})

test('only the first line of a page error is kept', async () => {
  const read = await readPage(throwingPage('Error: first line\nsecond line\nthird'))
  assert.match(String(read.fault), /first line/)
  assert.doesNotMatch(String(read.fault), /second line/)
})
