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
const tags = [
  [9, Buffer.from([0x33, 0x66, 0x99])], // SetBackgroundColor
  [2, Buffer.alloc(8)], // DefineShape
  [26, Buffer.alloc(4)], // PlaceObject2
  [1, Buffer.alloc(0)], // ShowFrame
  [12, Buffer.from([0x07, 0x00, 0x00, 0x00, 0x00])], // DoAction: stop()
  [0, Buffer.alloc(0)], // End
]
const body = Buffer.concat([
  Buffer.from(rect),
  Buffer.from([0x00, 0x18, 0x02, 0x00]), // 24 fps, 2 frames
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
writeFileSync(process.argv[2] ?? 'test/fixtures/tiny.swf', Buffer.concat([file, body]))
