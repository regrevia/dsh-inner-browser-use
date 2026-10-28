import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { differs } from '../read.js'

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
