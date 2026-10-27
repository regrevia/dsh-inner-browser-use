import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname
const FILES = ['index.js', 'sidecar.js', 'tools.js', 'read.js', 'review.js', 'client.js'].map((name) => join(ROOT, name))

/** Top-level names only: a name reused inside a block is scoping, not a clash. */
function topLevelNames(source) {
  const names = []
  let depth = 0
  for (const line of source.split('\n')) {
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
    if (depth === 0) {
      const found = code.match(/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/)
      if (found) names.push(found[1])
    }
    for (const char of code) {
      if (char === '{') depth += 1
      else if (char === '}') depth = Math.max(0, depth - 1)
    }
  }
  return names
}

test('no top-level name is declared twice in a module', () => {
  for (const file of FILES) {
    const names = topLevelNames(readFileSync(file, 'utf8'))
    const seen = new Set()
    for (const name of names) {
      assert.equal(seen.has(name), false, `${file.split('/').pop()} declares ${name} twice`)
      seen.add(name)
    }
  }
})

test('one module is imported once per file', () => {
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8')
    const found = [...source.matchAll(/from\s+'(\.[^']+)'/g)].map((row) => row[1].replace(/\?.*$/, ''))
    assert.deepEqual(found.length, new Set(found).size, `${file.split('/').pop()} imports a module twice`)
  }
})

test('every tool has one name', () => {
  const source = readFileSync(join(ROOT, 'tools.js'), 'utf8')
  const names = [...source.matchAll(/^\s*name: '([a-z_]+)'/gm)].map((row) => row[1])
  assert.equal(names.length, new Set(names).size, 'two tools share a name')
  assert.ok(names.length >= 31, `expected the whole surface, got ${names.length}`)
})

test('the tab is registered with one id and one kind', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  for (const constant of ['SIDE_ID', 'SIDE_KIND', 'NS', 'STYLE_ID', 'SLOT', 'TITLE_SLOT']) {
    assert.equal((client.match(new RegExp(`const ${constant} = `, 'g')) ?? []).length, 1, `${constant} is defined once`)
  }
})

test('each half mounts once', () => {
  for (const file of ['index.js', 'client.js']) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const entries = (source.match(/^export function apply\(/gm) ?? []).length + (source.match(/^      apply\(ctx\) \{/gm) ?? []).length
    assert.equal(entries, 1, `${file} has one entry point`)
    assert.ok((source.match(/ctx\.effect\(/g) ?? []).length >= 1, `${file} ties work to the plug-in lifetime`)
  }
})

test('one style sheet per document', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  assert.match(client, /getElementById\?\.\(STYLE_ID\)\?\.remove\(\)/, 'a reload replaces the sheet instead of adding another')
})

test('the package ships every module it imports', () => {
  const { files } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const onDisk = readdirSync(ROOT).filter((name) => name.endsWith('.js') && name !== 'client.js')
  for (const name of onDisk) {
    assert.ok(files.includes(name), `${name} is imported but not packaged`)
  }
})
