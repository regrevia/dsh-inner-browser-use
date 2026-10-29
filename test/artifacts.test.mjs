import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-files-'))
process.env.DSH_INNER_BROWSER_ARTIFACTS = root
const { ARTIFACT_KEEP, artifactDir, pruneArtifacts, saveArtifact, sessionScope, workScope } = await import('../tools.js')

const inChat = (cwd, chat, body) => sessionScope.run(chat, () => workScope.run(cwd, body))

test('a file lands under its project and its chat, never in the project folder', async () => {
  const file = await inChat('/Users/apple/Desktop/DSH/dsh-inner-browser-use', 'session-72557d6e-7be0-451a-88f6-09ec5f0ec1c5', () => saveArtifact('shots', Buffer.from('x').toString('base64'), { name: 'landing' }))
  assert.ok(file.startsWith(root))
  /* A path is compared in one shape so the assertion reads the same on Windows. */
  const flat = file.replaceAll('\\', '/')
  assert.match(flat, /dsh-inner-browser-use-[0-9a-f]{6}\/72557d6e\/shots\/landing\.png$/)
  assert.equal(flat.includes('/dsh-inner-browser-use/dsh-inner-browser-use'), false)
})

test('two projects and two chats do not share a folder', async () => {
  const one = await inChat('/Users/apple/a/one', 'session-aaaaaaaa-1', () => artifactDir('shots'))
  const two = await inChat('/Users/apple/b/two', 'session-bbbbbbbb-2', () => artifactDir('shots'))
  const same = await inChat('/Users/apple/a/one', 'session-aaaaaaaa-1', () => artifactDir('shots'))
  assert.notEqual(one, two)
  assert.equal(one, same)
  assert.notEqual(one, await inChat('/Users/apple/a/one-other', 'session-aaaaaaaa-1', () => artifactDir('shots')))
})

test('a call outside a known project and chat still gets a folder', async () => {
  const dir = await artifactDir('pdf')
  assert.match(dir.replaceAll('\\', '/'), /no-project\/no-chat\/pdf$/)
})

test('the folder keeps the newest files and drops the rest', async () => {
  const dir = await inChat('/Users/apple/a/one', 'session-cccccccc-3', () => artifactDir('shots'))
  await inChat('/Users/apple/a/one', 'session-cccccccc-3', async () => {
    for (let i = 0; i < ARTIFACT_KEEP + 5; i += 1) {
      await saveArtifact('shots', Buffer.from('x').toString('base64'), { name: `shot-${i}` })
      await new Promise((settle) => setTimeout(settle, 2))
    }
  })
  assert.equal(readdirSync(dir).length, ARTIFACT_KEEP)
  assert.equal(readdirSync(dir).includes(`shot-${ARTIFACT_KEEP + 4}.png`), true)
  assert.equal(readdirSync(dir).includes('shot-0.png'), false)
})

test('a name cannot walk out of its folder', async () => {
  const file = await inChat('/Users/apple/a/one', 'session-aaaaaaaa-1', () => saveArtifact('shots', Buffer.from('x').toString('base64'), { name: '../../escape' }))
  assert.equal(file.startsWith(root), true)
  assert.equal(dirname(file).startsWith(join(root, 'one-')), true)
  assert.equal(basename(file).includes('/'), false)
  assert.equal(basename(file).includes('..'), false)
})

test.after(() => rmSync(root, { recursive: true, force: true }))
