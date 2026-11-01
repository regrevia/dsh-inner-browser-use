import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blocks, rank, evidence, trailOf } from '../read.js'

/**
 * A page small enough to build by hand: the block reader only ever asks a
 * document for its tags, its text, its children and the style of each node, so
 * a tree of plain objects is enough to run the real page script under Node.
 * @param {string} tagName - element name.
 * @param {object} [props] - extra fields, such as innerText or hidden.
 * @param {object[]} [kids] - children.
 * @returns {object} the fake element.
 */
function el(tagName, props = {}, kids = []) {
  const node = { tagName, children: kids, hidden: false, innerText: '', attrs: {}, ...props }
  node.getAttribute = (name) => node.attrs[name] ?? null
  node.querySelectorAll = (selector) => (selector === 'a' ? below(node).filter((one) => one.tagName === 'A') : [])
  node.querySelector = (selector) => (selector === 'tr' ? below(node).find((one) => one.tagName === 'TR') ?? null : null)
  node.closest = (selector) => (selector === 'table' ? up(node).find((one) => one.tagName === 'TABLE') ?? null : null)
  for (const kid of kids) kid.parent = node
  return node
}

/** Every element under a node, the way querySelectorAll('*') would list them. */
function below(node) {
  return node.children.flatMap((kid) => [kid, ...below(kid)])
}

/** The node and its ancestors, nearest first. */
function up(node) {
  return node === undefined ? [] : [node, ...up(node.parent)]
}

/** Run the page script the tool would send, against a fake document. */
function readBlocks(budget) {
  const article = el('ARTICLE', {}, [
    el('H1', { innerText: 'Plans' }),
    el('H2', { innerText: 'Trial' }),
    el('P', { innerText: 'The trial lasts 14 days from the day you sign up, and no card is charged before it ends.' }),
    el('H2', { innerText: 'Refunds' }),
    el('P', { innerText: 'Refunds are accepted within 30 days of purchase.' }),
  ])
  const document = { title: 'plans', body: article, querySelector: (selector) => (selector.includes('article') ? article : null) }
  const getComputedStyle = () => ({ display: 'block', visibility: 'visible' })
  return JSON.parse(new Function('document', 'getComputedStyle', `return ${blocks(budget)}`)(document, getComputedStyle))
}

test('a block can say where it sits, not only what it says first', () => {
  const read = readBlocks(4000)
  const trial = read.blocks.find((block) => block.t.startsWith('The trial lasts'))
  assert.equal(trial.p, 'Plans \u203a Trial')
  assert.equal(trial.h, 'Trial')
  const refund = read.blocks.find((block) => block.t.startsWith('Refunds are accepted'))
  assert.equal(refund.p, 'Plans \u203a Refunds')
})

test('the page script rates a paragraph above a list of links', () => {
  const read = readBlocks(4000)
  for (const block of read.blocks) {
    assert.ok(block.q > 0 && block.q <= 1, `quality ${block.q}`)
    assert.equal(block.d, 0)
  }
  const prose = read.blocks.find((block) => block.t.startsWith('The trial lasts'))
  assert.ok(prose.q > 0.6)
})

test('a table row is read with its column names, as one line', () => {
  const head = el('TR', {}, [el('TH', { innerText: 'Plan' }), el('TH', { innerText: 'Price per month' })])
  const row = el('TR', {}, [el('TD', { innerText: 'Pro' }), el('TD', { innerText: '$84' })])
  const table = el('TABLE', {}, [el('THEAD', {}, [head]), el('TBODY', {}, [row])])
  const article = el('ARTICLE', {}, [el('H1', { innerText: 'Pricing' }), table])
  const document = { title: 'pricing', body: article, querySelector: () => article }
  const read = JSON.parse(new Function('document', 'getComputedStyle', `return ${blocks(4000)}`)(document, () => ({ display: 'block', visibility: 'visible' })))
  const cells = read.blocks.filter((block) => block.r === 1)
  assert.equal(cells.length, 2)
  assert.equal(cells[1].t, 'Plan: Pro | Price per month: $84')
  assert.equal(cells[1].q, 0.95)
})

test('a tight budget keeps the prose and drops the menu before it', () => {
  const menu = (n) => el('P', { innerText: Array.from({ length: 12 }, (_, i) => `Section ${i + n}`).join(' \u00b7 ') }, Array.from({ length: 12 }, (_, i) => el('A', { innerText: `Section ${i + n}` })))
  const article = el('ARTICLE', {}, [menu(0), menu(12), menu(24), el('H2', { innerText: 'Trial' }), el('P', { innerText: 'The trial lasts 14 days from the day you sign up, and no card is charged before it ends.' })])
  const document = { title: 'noisy', body: article, querySelector: () => article }
  const read = JSON.parse(new Function('document', 'getComputedStyle', `return ${blocks(160)}`)(document, () => ({ display: 'block', visibility: 'visible' })))
  const said = read.blocks.map((block) => block.t).join('\n')
  assert.match(said, /trial lasts 14 days/)
  assert.ok(read.blocks.length < 4, `kept ${read.blocks.length}`)
})

test('the trail is only printed when it says more than the nearest heading', () => {
  assert.equal(trailOf({ h: 'Trial', p: 'Plans \u203a Trial' }), 'Plans \u203a Trial')
  assert.equal(trailOf({ h: 'Trial', p: 'Trial' }), 'Trial')
  assert.equal(trailOf({ h: 'Trial' }), 'Trial')
  assert.equal(trailOf({ h: 'Trial', p: 'x'.repeat(120) }), 'Trial')
})

test('a menu that repeats the words does not outrank the paragraph that answers', () => {
  const ranked = rank([
    { h: 'Menu', t: 'trial trial trial trial trial', d: 1, q: 0.1 },
    { h: 'Trial', t: 'The trial lasts 14 days from the day you sign up.', d: 0, q: 0.9 },
  ], 'how long does the trial last')
  assert.match(ranked[0].block.t, /14 days/)
})

test('evidence prints the trail above the sentence it took', () => {
  const picked = evidence([
    { h: 'Refunds', p: 'Plans \u203a Refunds', t: 'Refunds are accepted within 30 days of purchase.', d: 0, q: 0.8 },
  ], 'how long do I have to get a refund', { maxChars: 400 })
  assert.equal(picked.rows[0].heading, 'Plans \u203a Refunds')
  assert.match(picked.rows[0].text, /30 days/)
})
