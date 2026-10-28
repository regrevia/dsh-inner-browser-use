import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readStateFor, SHOT_OUTPUT } from '../tools.js'
import { readFileSync } from 'node:fs'
import { blindSpots, differs, renderPage } from '../read.js'

test('a number whose control says the same words is still good', () => {
  assert.equal(differs({ name: 'Send' }, { name: 'Send' }), '')
  assert.equal(differs({ name: 'Send message' }, { name: 'Send message ' }), '')
})

test('a number whose control now says something else is refused', () => {
  const said = differs({ name: 'Send' }, { name: 'Stop' })
  assert.match(said, /Stop/)
  assert.match(said, /Send/)
})

test('a control that grew a suffix is the same control', () => {
  assert.equal(differs({ name: 'Add to cart' }, { name: 'Add to cart (2)' }), '')
})

test('a control with no words is never refused on drift', () => {
  assert.equal(differs({ name: '' }, { name: 'Anything' }), '')
  assert.equal(differs({ name: 'Anything' }, { name: '' }), '')
})

test('the host half imports every name it borrows from the tool surface', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  const exported = [...tools.matchAll(/export (?:const|function|class) ([A-Za-z_$][\w$]*)/g)].map((m) => m[1])
  for (const name of exported) {
    const used = new RegExp(`\\b${name}\\b`).test(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, ''))
    if (!used) continue
    const imported = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from './tools.js`).test(source)
    assert.ok(imported, `index.js uses ${name} but does not import it from tools.js`)
  }
})

test('two chats never share the baseline a diff is taken against', () => {
  const store = new Map()
  const fallback = { refs: [], at: 0 }
  const a = readStateFor(store, 'session-a', fallback)
  const b = readStateFor(store, 'session-b', fallback)
  assert.notEqual(a, b, 'one chat cannot replace the other read')
  assert.equal(readStateFor(store, 'session-a', fallback), a, 'a chat keeps its own')
  assert.equal(readStateFor(store, '', fallback), fallback, 'a call with no chat uses the host object')
  a.last = { url: 'https://a.example/' }
  assert.equal(b.last, undefined)
})

test('a screenshot carries the picture only when the model can look at it', () => {
  const plain = SHOT_OUTPUT.render({}, { text: '/tmp/a.png' })
  assert.equal(plain.length, 1, 'a path alone stays one text block')
  const seen = SHOT_OUTPUT.render({}, {
    text: '/tmp/a.png',
    image: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 2048, width: 640, height: 400 },
  })
  assert.equal(seen.length, 2)
  assert.equal(seen[1].type, 'image')
  assert.equal(seen[1].attachment.attachmentId, 'att-1')
})

test('a read says what its text could not show', () => {
  const read = { url: 'https://x.test/', title: '', text: '', textChars: 0, controls: [], blind: blindSpots({ pictures: 2, canvases: 1, videos: 0, frames: 1 }) }
  const said = renderPage(read)
  assert.match(said, /text cannot show: 2 picture\(s\) with no words, 1 drawing surface\(s\), 1 embedded frame\(s\)/)
  assert.match(said, /sidecar_grab/)
})

test('a read with nothing out of reach adds no line about it', () => {
  const read = { url: 'https://x.test/', title: '', text: 'hello', textChars: 5, controls: [], blind: blindSpots({}, 0) }
  assert.doesNotMatch(renderPage(read), /text cannot show/)
})

test('frames the frame reader reached count even when the page cannot say', () => {
  assert.deepEqual(blindSpots(undefined, 3), { pictures: 0, canvases: 0, videos: 0, frames: 3, flash: 0 })
  assert.deepEqual(blindSpots({ frames: 1 }, 2), { pictures: 0, canvases: 0, videos: 0, frames: 1, flash: 0 })
})

test('a page that needs Flash says so instead of looking blank', () => {
  const read = { url: 'https://x.test/', title: '', text: 'hello', textChars: 5, controls: [], blind: blindSpots({ flash: 1 }, 0) }
  assert.match(renderPage(read), /Flash movie\(s\) this browser cannot play/)
})

test('a browser error page reads as a page that never arrived', () => {
  const read = { url: 'chrome-error://chromewebdata/', title: '', text: '', textChars: 0, controls: [] }
  assert.match(renderPage(read), /the page did not load — sidecar_nav/)
})

test('every read that changes a baseline changes this chat\'s own baseline', () => {
  /* A tool that hands the shared `refs` object to `remember` writes another
     chat's baseline: its numbers then point at controls this chat never read.
     The one place that did it answered with a ReferenceError the first time it
     was used, which is how this test came about. */
  const source = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.equal(source.includes('await remember(page, refs,'), false)
  assert.ok(source.includes('remember(page, state, options)'))
  assert.ok(source.includes('remember(page, refsFor(), options)'))
})
