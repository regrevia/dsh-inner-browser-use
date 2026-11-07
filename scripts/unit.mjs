#!/usr/bin/env node
/**
 * Run every test file under test/, by reading the directory rather than
 * keeping a list. A hand-kept list silently drops files: four suites sat here
 * unrun while `npm test` stayed green. A file that exists is a file that runs.
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(join(root, 'test'))
  .filter((one) => one.endsWith('.test.mjs'))
  .sort()
  .map((one) => join('test', one))

const run = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
process.exitCode = run.status ?? 1
