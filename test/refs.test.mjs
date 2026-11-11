import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readStateFor, SHOT_OUTPUT } from '../tools.js'
import { readFileSync } from 'node:fs'
import { blindSpots, bounds, clickInDom, covering, differs, pictures, renderPage, resolve, seed, snapshot, SELECTOR, writeInDom } from '../read.js'

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
  assert.match(said, /browser_grab/)
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
  assert.match(renderPage(read), /the page did not load — browser_nav/)
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

test('a page of hundred rows does not spend the read on numbers alone', () => {
  const controls = Array.from({ length: 300 }, (_, at) => ({ ref: at + 1, kind: 'link', name: `row ${at + 1}`, view: true, href: '' }))
  const read = { url: 'https://example.com', title: 'rows', controls, text: 'the words that say what this page is' }
  const lean = renderPage(read)
  assert.equal(lean.split('\n').filter((line) => /^\d+ \[/.test(line)).length, 140)
  assert.match(lean, /… 160 more controls on this screen/)
  assert.match(lean, /the words that say what this page is/, 'the words survive the numbers')
  const whole = renderPage(read, { maxControls: 1000 })
  assert.doesNotMatch(whole, /more controls on this screen/)
  assert.ok(whole.split('\n').filter((line) => /^\d+ \[/.test(line)).length > 140, 'more rows when the caller asks for them')
})

test('the page-side scripts the browser runs are valid JavaScript', () => {
  const scripts = {
    seed: seed(SELECTOR, 2),
    read: snapshot('text', 6000, 90),
    resolve: resolve(1),
    click: clickInDom(1, {}),
    write: writeInDom(1, 'x', {}),
    bounds: bounds(1),
    pictures: pictures(1, 2),
    covering: covering(1),
  }
  for (const [name, src] of Object.entries(scripts)) assert.doesNotThrow(() => new Function(src), `${name} parses`)
  const read = scripts.read
  /* A regex written with one backslash inside the template loses it, and the
     page then collapses runs of "s" instead of runs of space. */
  assert.match(read, /\\s\+/, 'whitespace regexes keep their backslash')
  assert.ok(read.includes('application\\/x-swf'), 'a slash inside a regex is escaped')
})


const quiet = { url: 'https://example.com/', title: 'Example', text: '', textChars: 0, controls: [], scroll: { y: 0, height: 100, viewport: 800 }, focused: null }

test('a read that ran out of budget says where it stopped', () => {
  const said = renderPage({ ...quiet, text: 'words '.repeat(900), textChars: 6000, capped: true })
  assert.match(said, /longer than this read/)
  assert.match(said, /6000/)
  assert.match(said, /browser_scroll/)
})

test('a short page says nothing about budgets', () => {
  const said = renderPage({ ...quiet, text: 'A short page.', textChars: 13, capped: false })
  assert.doesNotMatch(said, /longer than this read/)
})

test('a page that paints itself is named as such instead of read as empty', () => {
  const said = renderPage({ ...quiet, blind: { pictures: 0, canvases: 1, videos: 0, frames: 0, flash: 0 } })
  assert.match(said, /paints itself/)
  assert.match(said, /browser_shot/)
})

test('the picture reader hands a drawing surface its own pixels back', () => {
  const code = pictures(undefined, 1)
  assert.match(code, /toDataURL\('image\/png'\)/, 'a canvas is asked for its own pixels')
  assert.match(code, /putImageData|drawImage/, 'and copied through a board when it will not answer')
})

test('every control a read can find is numbered, not just the described ones', () => {
  const source = snapshot('text', 6000, 90)
  /* Numbering has to happen before the describing budget is checked: a control
     past the budget still needs a ref, or a click on it has nothing to name. */
  const numbered = source.indexOf('reg.id(el)')
  const gate = source.indexOf('if (described >= max * 3)')
  assert.ok(numbered !== -1, 'a control is never numbered')
  assert.ok(gate !== -1, 'nothing bounds the describing half')
  assert.ok(numbered < gate, 'numbering happens after the budget, so the rest never gets a ref')
  assert.ok(!/halt\s*=\s*true/.test(source), 'the walk stops instead of skipping the expensive half')
})

test('a page holding more controls than it describes says how many, and that the rest have refs', () => {
  const line = (total, described) => renderPage({ url: 'https://example.com/', title: '', text: '', textChars: 0, controls: [], total, described }, {})
  assert.match(line(400, 90), /holds 400 controls; 90 of them are described here, and every one of them has a ref/)
  assert.doesNotMatch(line(400, 90), /no such button/i)
  assert.doesNotMatch(line(90, 90), /holds \d+ controls/)
})

test('text a person cannot read is not read out, and the page is told why', () => {
  const source = snapshot('text', 6000, 90)
  assert.match(source, /const unreadable = \(el, style\)/)
  assert.match(source, /aria-hidden="true"/)
  assert.match(source, /style\.color === 'rgba\(0, 0, 0, 0\)'/)
  /* Hiding words must never hide an action: the numbering happens before this
     test and the control path never calls it. */
  assert.ok(source.indexOf('reg.id(el)') < source.indexOf('if (unreadable(parent, style))'))
  const read = { url: 'https://example.com/', title: '', text: 'ok', textChars: 2, controls: [], hidden: 4 }
  assert.match(renderPage(read, {}), /4 block\(s\) of text are hidden or transparent on the page and were not read/)
  assert.doesNotMatch(renderPage({ ...read, hidden: 0 }, {}), /hidden or transparent/)
})

test('a picture that was never sampled is not described as if it were', () => {
  /* A drawing surface fed from another site refuses to be read. The read used
     to hand back colours: 0 and be rendered as "a few colours" — a statement
     about content nobody saw. */
  const source = snapshot('text', 6000, 90)
  assert.match(source, /said\.sampled = false/)
  assert.ok(source.indexOf('said.sampled = true') > source.indexOf('said.sampled = false'), 'only a real sample flips it')
  const read = (picture) => ({ url: 'https://example.com/', title: '', text: '', textChars: 0, controls: [], picture })
  const tainted = renderPage(read({ kind: 'canvas', width: 300, height: 200, colors: 0, flat: 0, sampled: false, name: '' }), {})
  assert.match(tainted, /picture 300x200 — its pixels come from another site/)
  assert.doesNotMatch(tainted, /a few colours/)
  const sampled = renderPage(read({ kind: 'canvas', width: 300, height: 200, colors: 1, flat: 1, sampled: true, name: '' }), {})
  assert.match(sampled, /mostly one colour/)
})

test('a surface that hands back nothing says why, and points at the screen', () => {
  const code = pictures(undefined, 1)
  assert.match(code, /let why = ''/)
  assert.match(code, /why = item\.kind === 'canvas' \? 'its pixels come from another site/)
  assert.match(code, /out\.push\(\{ kind: item\.kind, width: item\.w, height: item\.h, type, data, why/)
  const tools = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  /* browser_grab has to repeat the reason: "could not be saved" alone leaves
     the reader trying the same call again. */
  assert.match(tools, /skipped \$\{size\}: \$\{why === '' \? 'that surface holds no picture/)
  assert.match(tools, /browser_shot shows it on screen/)
})
