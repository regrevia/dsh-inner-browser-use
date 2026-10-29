#!/usr/bin/env node
/**
 * Fetch and check the Flash-era runtime the `flash` switch uses.
 *
 * The browser half (Chromium 87 as Electron) comes from a public mirror and is
 * downloaded once. The plugin half cannot be shipped: Adobe's player may not be
 * redistributed, so this finds one already on the machine and copies nothing it
 * does not have to. Run with no arguments to see the state; `--dry-run` never
 * touches the network.
 */

import { ensureFlash, flashStatus } from '../runtime/flash-setup.mjs'

const dry = process.argv.includes('--dry-run')
const before = flashStatus()

if (before.ready) {
  console.log('flash ready')
  console.log(`  chromium 87 ${before.electron === true ? 'present' : 'missing'}`)
  console.log(`  plugin      ${before.plugin ?? 'missing'}`)
  process.exitCode = 0
}

console.log('flash not ready yet')
console.log(`  chromium 87 ${before.electron === true ? 'present' : 'missing (about 80 MB, downloaded once)'}`)
console.log(`  plugin      ${before.plugin ?? 'missing (Adobe does not allow redistribution; a local install is required)'}`)
if (dry) {
  process.exitCode = 1
} else {
  try {
    const ready = await ensureFlash({ progress: (line) => console.log(`  ${line}`) })
    console.log('flash ready')
    console.log(`  chromium 87 ${ready.electron}`)
    console.log(`  plugin      ${ready.plugin}`)
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exitCode = 1
  }
}
