import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-files-'))
const projects = mkdtempSync(join(tmpdir(), 'dsh-projects-'))
process.env.DSH_INNER_BROWSER_ARTIFACTS = root
const { ARTIFACT_HOME, ARTIFACT_KEEP, artifactDir, saveArtifact, sessionScope, workScope } = await import('../tools.js')

/* And a second copy of the module that never saw the override, which is how a
   normal call reaches it: the project is the place. */
delete process.env.DSH_INNER_BROWSER_ARTIFACTS
const plain = await import('../tools.js?project-local=1')

/* Each import has scopes of its own, so a call is wrapped in the scopes of the
   module it is calling. */
const inChat = (cwd, chat, body) => plain.sessionScope.run(chat, () => plain.workScope.run(cwd, body))
const flat = (path) => path.replaceAll('\\', '/')
const projectOne = join(projects, 'one')
const projectTwo = join(projects, 'two')
const chatA = 'session-72557d6e-7be0-451a-88f6-09ec5f0ec1c5'
const chatB = 'session-bbbbbbbb-2'

test('a file lands inside the project, under its chat and its kind', async () => {
  const file = await inChat(projectOne, chatA, () => plain.saveArtifact('shots', Buffer.from('x').toString('base64'), { name: 'landing' }))
  assert.equal(flat(file), flat(join(projectOne, '.dsh', 'browser', '72557d6e', 'shots', 'landing.png')))
})

test('the project folder says it is not part of the product', async () => {
  const ignore = join(projectOne, '.dsh', 'browser', '.gitignore')
  assert.equal(existsSync(ignore), true)
  assert.match(readFileSync(ignore, 'utf8'), /^\*/m)
})

test('two projects and two chats do not share a folder', async () => {
  const one = await inChat(projectOne, chatA, () => plain.artifactDir('shots'))
  const two = await inChat(projectTwo, chatB, () => plain.artifactDir('shots'))
  const same = await inChat(projectOne, chatA, () => plain.artifactDir('shots'))
  assert.notEqual(one, two)
  assert.equal(one, same)
  assert.notEqual(one, await inChat(join(projects, 'one-other'), chatA, () => plain.artifactDir('shots')))
})

test('a call outside a known project and chat still gets a folder', async () => {
  const dir = await plain.artifactDir('pdf')
  assert.equal(flat(dir), flat(join(ARTIFACT_HOME, 'no-project', 'no-chat', 'pdf')))
})

test('the fallback folder writes no ignore file of its own', async () => {
  /* The user home is real here (the module is the normal one), so start from
     the state a fresh machine has and leave it that way. */
  rmSync(join(plain.ARTIFACT_HOME, 'no-project', '.gitignore'), { force: true })
  const loose = await plain.saveArtifact('shots', Buffer.from('x').toString('base64'), { name: 'loose' })
  assert.equal(flat(dirname(dirname(dirname(loose)))), flat(join(plain.ARTIFACT_HOME, 'no-project')))
  assert.equal(existsSync(join(plain.ARTIFACT_HOME, 'no-project', '.gitignore')), false)
  assert.equal(existsSync(join(plain.ARTIFACT_HOME, 'no-project', 'no-chat', 'shots', 'loose.png')), true)
  rmSync(join(plain.ARTIFACT_HOME, 'no-project'), { recursive: true, force: true })
})

test('a caller may still send everything somewhere else', async () => {
  const file = await sessionScope.run(chatA, () => workScope.run(projectOne, () => saveArtifact('shots', Buffer.from('x').toString('base64'), { name: 'pinned' })))
  assert.equal(flat(file), flat(join(root, '72557d6e', 'shots', 'pinned.png')))
  assert.equal(flat(file).startsWith(flat(projectOne)), false)
})

test('the folder keeps the newest files and drops the rest', async () => {
  const dir = await inChat(projectOne, 'session-cccccccc-3', () => plain.artifactDir('shots'))
  await inChat(projectOne, 'session-cccccccc-3', async () => {
    for (let i = 0; i < ARTIFACT_KEEP + 5; i += 1) {
      await plain.saveArtifact('shots', Buffer.from('x').toString('base64'), { name: `shot-${i}` })
      await new Promise((settle) => setTimeout(settle, 2))
    }
  })
  assert.equal(readdirSync(dir).length, ARTIFACT_KEEP)
  assert.equal(readdirSync(dir).includes(`shot-${ARTIFACT_KEEP + 4}.png`), true)
  assert.equal(readdirSync(dir).includes('shot-0.png'), false)
})

test('a name cannot walk out of its folder', async () => {
  const file = await inChat(projectOne, chatA, () => plain.saveArtifact('shots', Buffer.from('x').toString('base64'), { name: '../../escape' }))
  assert.equal(dirname(file), await inChat(projectOne, chatA, () => plain.artifactDir('shots')))
  assert.equal(basename(file).includes('/'), false)
  assert.equal(basename(file).includes('..'), false)
})

test.after(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(projects, { recursive: true, force: true })
})
