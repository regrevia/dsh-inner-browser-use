import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const { parseSwf, describeSwf } = await import('../runtime/swf.mjs')
const tiny = readFileSync(new URL('./fixtures/tiny.swf', import.meta.url))

test('a movie reports its size, its speed and its frames', () => {
  const report = parseSwf(tiny)
  assert.equal(report.signature, 'FWS')
  assert.equal(report.version, 6)
  assert.equal(report.width, 400)
  assert.equal(report.height, 300)
  assert.equal(report.frameRate, 24)
  assert.equal(report.frames, 2)
  assert.equal(report.compressed, false)
  assert.equal(report.bytes, tiny.length)
})

test('the tag stream is walked in order, with offsets that point at the tags', () => {
  const report = parseSwf(tiny)
  assert.deepEqual(
    report.tags.map((tag) => tag.name),
    ['SetBackgroundColor', 'DefineShape', 'PlaceObject2', 'ShowFrame', 'DoAction'],
  )
  for (const tag of report.tags) assert.equal(report.histogram[tag.name] >= 1, true)
  assert.equal(report.counts.shapes, 1)
})

test('ActionScript 3 is told apart from ActionScript 2 by what the movie carries', () => {
  const avm1 = parseSwf(tiny)
  assert.equal(avm1.avm, 'avm1')
  /* DoABC appears once; nothing else in this file says AVM2. */
  const as3 = Buffer.from(tiny)
  const abc = Buffer.alloc(4)
  abc.writeUInt16LE((82 << 6) | 4, 0)
  const grown = Buffer.concat([as3.subarray(0, as3.length - 2), abc, Buffer.from([0x00, 0x00])])
  grown.writeUInt32LE(grown.length, 4)
  const report = parseSwf(grown)
  assert.equal(report.avm, 'avm2')
  assert.equal(report.counts.scripts, 1)
})

test('a compressed movie reads the same as the plain one', () => {
  const body = tiny.subarray(8)
  const head = Buffer.alloc(8)
  head.write('CWS', 0, 'latin1')
  head[3] = tiny[3]
  head.writeUInt32LE(tiny.length, 4)
  const report = parseSwf(Buffer.concat([head, deflateSync(body)]))
  assert.equal(report.compressed, true)
  assert.equal(report.width, 400)
  assert.equal(report.frames, 2)
  assert.equal(report.declaredBytes, tiny.length)
})

test('a file this reader cannot open says why instead of guessing', () => {
  assert.throws(() => parseSwf(Buffer.from('not a movie at all')), /not a SWF/)
  assert.throws(() => parseSwf(Buffer.alloc(4)), /too short/)
  const zws = Buffer.alloc(8)
  zws.write('ZWS', 0, 'latin1')
  assert.throws(() => parseSwf(zws), /LZMA/)
  /* A tag whose length runs past the file is a broken movie, not a short one. */
  const prefix = tiny.subarray(8, 8 + 13)
  const head = Buffer.alloc(2)
  head.writeUInt16LE((2 << 6) | 0x3f, 0)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(9999, 0)
  const broken = Buffer.concat([tiny.subarray(0, 8), prefix, head, size, Buffer.from([0x01, 0x02])])
  broken.writeUInt32LE(broken.length, 4)
  assert.throws(() => parseSwf(broken), /past the end/)
})

test('the readable report says what matters and leaves the dump out', () => {
  const lines = describeSwf(parseSwf(tiny))
  const text = lines.join('\n')
  assert.match(text, /400x300 at 24 frames a second, 2 frames/)
  assert.match(text, /ActionScript 1\/2 \(AVM1\)/)
  assert.match(text, /1 shape\(s\)/)
  assert.doesNotMatch(text, /\{"code"/)
})
