import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { around, decodePng, diffGrid, gridOf, quantize } from '../pixels.js'

/** CRC-32 as PNG wants it, kept here so the test makes its own image. */
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a PNG the way Chrome does: 8-bit, no interlace, filtered rows. */
function png(width, height, channels, pixel) {
  const chunk = (name, body) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    const text = Buffer.from(name, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([text, body])))
    return Buffer.concat([head, text, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  const raw = Buffer.alloc(height * (1 + width * channels))
  let at = 0
  for (let y = 0; y < height; y += 1) {
    raw[at] = 0
    at += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
      if (channels === 4) raw[at + 3] = 255
      at += channels
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('a picture is read back the way it was written', () => {
  const file = png(2, 2, 4, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : x === 1 && y === 0 ? [0, 255, 0] : x === 0 ? [0, 0, 255] : [255, 255, 255]))
  const pngRead = decodePng(file)
  assert.equal(pngRead.width, 2)
  assert.equal(pngRead.height, 2)
  assert.equal(pngRead.channels, 4)
  assert.deepEqual(Array.from(pngRead.data.slice(0, 3)), [255, 0, 0])
  assert.deepEqual(Array.from(pngRead.data.slice(12, 15)), [255, 255, 255])
})

test('a picture with three channels works too', () => {
  const pngRead = decodePng(png(3, 1, 3, (x) => [x * 90, 10, 20]))
  assert.equal(pngRead.channels, 3)
  assert.deepEqual(Array.from(pngRead.data.slice(3, 6)), [90, 10, 20])
})

test('something that is not a PNG is refused, not guessed at', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a')), /not a PNG/)
})

test('colours turn into the letters a person would use', () => {
  assert.equal(quantize(0, 0, 0), '.')
  assert.equal(quantize(255, 255, 255), '#')
  assert.equal(quantize(230, 40, 40), 'r')
  assert.equal(quantize(60, 200, 60), 'g')
  assert.equal(quantize(40, 90, 230), 'b')
  /* A red that leans orange stays a different letter from a deep red. */
  assert.notEqual(quantize(250, 160, 30), quantize(200, 20, 20))
})

test('a black half above a white half reads as two kinds of rows', () => {
  const halves = png(40, 40, 4, (x, y) => (y < 20 ? [8, 8, 8] : [250, 250, 250]))
  const grid = gridOf(decodePng(halves), 10)
  assert.equal(grid.cols, 10)
  assert.equal(grid.rowCount, 10)
  assert.equal(grid.rows[0], '.'.repeat(10))
  assert.equal(grid.rows[9], '#'.repeat(10))
})

test('a change names how much moved and where', () => {
  const before = ['.'.repeat(6), '.'.repeat(6), '.'.repeat(6), '.'.repeat(6)]
  const after = ['.'.repeat(6), `..###${'.'.repeat(1)}`, '.'.repeat(6), '.'.repeat(6)]
  const change = diffGrid(before, after)
  assert.equal(change.cells, 3)
  assert.deepEqual(change.box, { x: 2, y: 1, w: 3, h: 1 })
  assert.equal(diffGrid(before, before).cells, 0)
  assert.deepEqual(around(after, change.box), { rows: ['.....', '.###.', '.....'], x: 1, y: 0 })
})

test('a grid of a different shape is a different screen, not a diff', () => {
  assert.equal(diffGrid(['..'], ['...']).cells, Number.POSITIVE_INFINITY)
})
