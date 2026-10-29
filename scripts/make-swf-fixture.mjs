#!/usr/bin/env node
/**
 * Build the tiny SWF the reader tests use: 400x300, 24 frames a second, one shape,
 * one script. Small enough to read by hand, real enough to exercise the tag walk.
 *
 *   node scripts/make-swf-fixture.mjs [out.swf]
 */
import { writeFileSync } from 'node:fs'

const bits = []
const put = (value, count) => {
  for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1)
}
put(15, 5)
for (const edge of [0, 8000, 0, 6000]) put(edge, 15)
const rect = []
for (let i = 0; i < bits.length; i += 8) {
  let byte = 0
  for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0)
  rect.push(byte)
}
/* --loop paints a new colour every frame and never stops, which is what makes
   a movie worth mirroring: a still picture is one paint, not a stream. */
const loop = process.argv.includes('--loop')
const tags = []
if (loop) {
  for (let frame = 0; frame < 12; frame += 1) {
    tags.push([9, Buffer.from([(frame * 40) & 0xff, 0x40 + ((frame * 17) & 0x7f), (255 - frame * 18) & 0xff])]) // SetBackgroundColor
    tags.push([2, Buffer.alloc(8)]) // DefineShape
    tags.push([26, Buffer.alloc(4)]) // PlaceObject2
    tags.push([1, Buffer.alloc(0)]) // ShowFrame
  }
} else {
  tags.push(
    [9, Buffer.from([0x33, 0x66, 0x99])], // SetBackgroundColor
    [2, Buffer.alloc(8)], // DefineShape
    [26, Buffer.alloc(4)], // PlaceObject2
    [1, Buffer.alloc(0)], // ShowFrame
    [12, Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00])], // DoAction: stop()
  )
}
tags.push([0, Buffer.alloc(0)]) // End
const body = Buffer.concat([
  Buffer.from(rect),
  Buffer.from([0x00, 0x18, loop ? 0x0c : 0x02, 0x00]), // 24 fps, frame count
  ...tags.map(([code, payload]) => {
    const head = Buffer.alloc(2)
    head.writeUInt16LE((code << 6) | payload.length)
    return Buffer.concat([head, payload])
  }),
])
const file = Buffer.alloc(8)
file.write('FWS', 0, 'latin1')
file[3] = 6
file.writeUInt32LE(8 + body.length, 4)
const out = process.argv.slice(2).find((one) => one.endsWith('.swf')) ?? (loop ? 'test/fixtures/loop.swf' : 'test/fixtures/tiny.swf')
writeFileSync(out, Buffer.concat([file, body]))
console.log(out)
