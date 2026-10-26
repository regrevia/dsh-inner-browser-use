#!/usr/bin/env node
/* Saves client.js the only way that cannot half-land: stage beside it, check
   the syntax, then swap the name in one step. A watcher that reads the file
   meanwhile sees either the old page or the new one, never a torn one. */
import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const target = new URL('../client.js', import.meta.url).pathname
const stage = new URL('../.client.stage.js', import.meta.url).pathname
const body = readFileSync(0, 'utf8')

if (body.trim() === '') {
  console.error('empty input: refused')
  process.exit(1)
}
writeFileSync(stage, body)
try {
  execFileSync(process.execPath, ['--check', stage], { stdio: 'pipe' })
} catch (error) {
  console.error('syntax error, nothing saved:')
  console.error(String(error.stderr ?? error.message).slice(0, 600))
  process.exit(1)
}
/* A copy of what worked, so a bad save is undone with one command. */
copyFileSync(target, new URL('../.client.known-good.js', import.meta.url).pathname)
renameSync(stage, target)
console.log('saved', body.length, 'bytes')
