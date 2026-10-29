/**
 * What ships is what runs. The dev profile symlinks the repo, so a file missing
 * from `files` in package.json still works here and fails for everyone who
 * installs the tarball — exactly the kind of bug that only shows up after the
 * fact. These tests walk the real import graph and check every file it reaches
 * is listed, so the two cannot drift apart again.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

test('a pack built from package.json files carries everything the plugin needs', async () => {
  const { execFileSync } = await import('node:child_process')
  const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'inner-browser-pack-'))
  try {
    /* Stage exactly what `files` promises and pack that, rather than trusting a
       tarball left on disk: a clean checkout has none, and a leftover one from
       an older revision hides the drift this test exists for. */
    const staged = join(dir, 'stage')
    mkdirSync(staged, { recursive: true })
    const wanted = ['package.json']
    for (const entry of pkg.files) {
      if (!entry.includes('*')) {
        wanted.push(entry)
        continue
      }
      const [folder, pattern] = entry.split('/*')
      const suffix = pattern.replace('*', '')
      for (const name of readdirSync(join(root, folder))) {
        if (name.endsWith(suffix)) wanted.push(`${folder}/${name}`)
      }
    }
    /** Copy a file, or a whole folder npm was told to ship, into the stage. */
    const stage = (file) => {
      const from = join(root, file)
      if (statSync(from).isDirectory()) {
        for (const name of readdirSync(from)) stage(`${file.replace(/\/$/, '')}/${name}`)
        return
      }
      mkdirSync(join(staged, dirname(file)), { recursive: true })
      copyFileSync(from, join(staged, file))
    }
    for (const file of wanted) stage(file)
    const tarball = join(dir, 'pack.tgz')
    execFileSync('tar', ['czf', tarball, '-C', staged, '.'])
    const listing = execFileSync('tar', ['tzf', tarball], { encoding: 'utf8' })
    for (const file of ['index.js', 'client.js', 'tools.js', 'read.js', 'sidecar.js']) {
      assert.match(listing, new RegExp(`^\\./${file}$|^${file}$`, 'm'), `${file} is missing from the pack`)
    }
    const unpacked = join(dir, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    execFileSync('tar', ['xzf', tarball, '-C', unpacked])
    // Import the unpacked host half, so a broken relative path or a missing
    // dependency inside the package shows up here and not in someone's install.
    for (const file of ['index.js', 'tools.js', 'read.js', 'sidecar.js']) {
      await import(`file://${join(unpacked, file)}?probe=${file}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a Flash page opens without claiming a window appeared', () => {
  const tools = readFileSync(new URL('../tools.js', import.meta.url), 'utf8')
  assert.match(tools, /flash: args\?\.flash/)
  assert.match(tools, /sidecar\.headless === false && sidecar\.flash !== true/)
})

test('a run that finds something wrong says so through its exit code, not a hard exit', () => {
  /* process.exit() inside a script skips whatever cleanup is queued and shows up
     in reviews as a crash risk; the scripts here only own their own process, so
     they set the code and let the process end. */
  const walked = []
  const sweep = (dir) => {
    for (const one of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, one.name)
      if (one.isDirectory()) sweep(at)
      else if (one.name.endsWith('.mjs') && !one.name.startsWith('.')) walked.push(at)
    }
  }
  sweep(join(root, 'scripts'))
  sweep(join(root, 'tools'))
  assert.ok(walked.length > 10)
  const offenders = walked.filter((one) => readFileSync(one, 'utf8').includes('process.exit('))
  assert.deepEqual(offenders, [])
  const refused = spawnSync(process.execPath, [join(root, 'tools', 'save-client.mjs')], { input: '', encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /empty input: refused/)
})
