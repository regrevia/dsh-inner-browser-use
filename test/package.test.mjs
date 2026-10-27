/**
 * What ships is what runs. The dev profile symlinks the repo, so a file missing
 * from `files` in package.json still works here and fails for everyone who
 * installs the tarball — exactly the kind of bug that only shows up after the
 * fact. These tests walk the real import graph and check every file it reaches
 * is listed, so the two cannot drift apart again.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Expand the small glob subset package.json actually uses: exact paths and `dir/*.ext`. */
function shipped(path) {
  return pkg.files.some((entry) => {
    if (entry.includes('*')) {
      const [dir, pattern] = entry.split('/*')
      const wants = pattern.replace('.', '\\.')
      return new RegExp(`^${dir}/[^/]+${wants}$`).test(path)
    }
    return entry === path || (entry.endsWith('/') && path.startsWith(entry))
  })
}

/** Every local module a file imports, with the cache-busting query removed. */
function importsOf(file) {
  const source = readFileSync(join(root, file), 'utf8')
  const found = []
  for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) found.push(match[1].replace(/\?.*$/, ''))
  return found
}

test('every file the plugin imports is shipped in the tarball', async () => {
  const seen = new Set()
  const queue = ['index.js']
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    assert.ok(shipped(file), `${file} is imported but not listed in package.json files`)
    for (const target of importsOf(file)) {
      const next = relative(root, resolve(root, dirname(file), target))
      queue.push(next)
    }
  }
  // The two the 0.14.0 tarball forgot, named so a regression reads as itself.
  assert.ok(seen.has('tools.js'), 'tools.js is where the tool definitions live')
  assert.ok(seen.has('read.js'), 'read.js is where refs and reads live')
  // The client half runs in a browser window, not in Node, so it is not in the
  // import graph — it still has to be in the tarball.
  assert.ok(shipped('client.js'), 'client.js is the half the Web UI loads')
})

test('the tarball on disk carries every file the plugin needs', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tarball = join(root, `dsh-inner-browser-use-${pkg.version}.tgz`)
  // A tarball left behind from an older revision is the other way this bug
  // ships: the tree is right and the file on disk is stale.
  const listing = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' })
  for (const file of ['index.js', 'client.js', 'tools.js', 'read.js', 'sidecar.js']) {
    assert.match(listing, new RegExp(`^package/${file}$`, 'm'), `${file} is missing from ${tarball}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'inner-browser-pack-'))
  try {
    execFileSync('tar', ['xzf', tarball, '-C', dir])
    // Import the unpacked host half, so a broken relative path or a missing
    // dependency inside the package shows up here and not in someone's install.
    for (const file of ['index.js', 'tools.js', 'read.js', 'sidecar.js']) {
      await import(`file://${join(dir, 'package', file)}?probe=${file}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
