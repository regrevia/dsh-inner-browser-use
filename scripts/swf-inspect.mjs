#!/usr/bin/env node
/**
 * What is inside a Flash movie, without a Flash player.
 *
 *   node scripts/swf-inspect.mjs [file.swf] [--json]
 *
 * With no file it reads the test fixture, so the command always answers.
 */
import { readFileSync } from 'node:fs'

const { parseSwf, describeSwf } = await import('../runtime/swf.mjs')

const args = process.argv.slice(2)
const file = args.find((arg) => !arg.startsWith('--')) ?? new URL('../test/fixtures/tiny.swf', import.meta.url)
const bytes = readFileSync(file)
const started = Date.now()
const report = parseSwf(bytes)
const ms = Date.now() - started
if (args.includes('--json')) console.log(JSON.stringify({ file: String(file), ms, ...report }, null, 1))
else console.log([`${String(file)} (read in ${ms} ms)`, ...describeSwf(report)].join('\n'))
