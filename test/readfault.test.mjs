import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readPage, renderPage, article, readArticle, finder, findOnPage } from '../read.js'

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


/** A page that answers the article script with a fixed JSON payload. */
function articlePage(said) {
  return {
    url: 'https://example.com/story',
    title: 'story',
    cdp: { send: async (method, params) => {
      const value = String(params.expression).includes('document.title') ? 'Story' : JSON.stringify(said)
      return { result: { value } }
    } },
  }
}

test('the article script is valid JavaScript even with quotes in the budget', () => {
  for (const budget of [400, 6000, 24000]) {
    assert.doesNotThrow(() => new Function(`return ${article(budget)}`), `budget ${budget}`)
  }
})

test('browser_read says what the page says, in Markdown, and says when it was cut', async () => {
  const said = { text: '## Where\n\nthe words', chars: 18, linkCount: 4, truncated: true }
  const read = await readArticle(articlePage(said), { maxChars: 900 })
  assert.equal(read.url, 'https://example.com/story')
  assert.equal(read.title, 'Story')
  assert.equal(read.text, '## Where\n\nthe words')
  assert.equal(read.truncated, true)
  assert.equal(read.linkCount, 4)
})

test('a page that will not answer is a fault, not an empty page', async () => {
  const read = await readArticle(throwingPage(), { maxChars: 900 })
  assert.equal(read.text, '')
  assert.match(String(read.fault), /hostile page/)
})


test('the finder script is valid JavaScript and quotes its query safely', () => {
  for (const query of ['sign in', "it's", 'a/b\n']) {
    assert.doesNotThrow(() => new Function(`return ${finder(query, false, 8)}`), query)
    assert.doesNotThrow(() => new Function(`return ${finder(query, true, 8)}`), `regex ${query}`)
  }
})

test('finding words returns controls with refs and plain text without one', async () => {
  const said = { matches: [
    { ref: 7, name: 'Sign in', tag: 'a', x: 12, y: 40, view: true },
    { ref: 0, name: 'signed in as a person', tag: 'p', x: 3, y: 500, view: false },
  ] }
  const page = {
    url: 'https://example.com/login',
    title: 'login',
    cdp: { send: async () => ({ result: { value: JSON.stringify(said) } }) },
  }
  const found = await findOnPage(page, 'sign', { limit: 8 })
  assert.deepEqual(found.matches, said.matches)
})

test('a finder that gets no answer is a fault', async () => {
  const found = await findOnPage(throwingPage(), 'sign')
  assert.deepEqual(found.matches, [])
  assert.match(String(found.fault), /hostile page/)
})
