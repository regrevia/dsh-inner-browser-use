/**
 * Read a SWF far enough to talk about it: what it is, how long it plays, which
 * ActionScript it needs, and what it is made of.
 *
 * This is the front half of the Flash-compatible runtime: the movie is a tag
 * stream, and everything a renderer, an agent or a replay needs can be read off
 * that stream without decoding a single shape. It does not draw.
 */
import { inflateSync } from 'node:zlib'

/** Every tag this reader names; anything else is reported by number. */
export const TAG_NAMES = {
  0: 'End',
  1: 'ShowFrame',
  2: 'DefineShape',
  4: 'PlaceObject',
  5: 'RemoveObject',
  6: 'DefineBits',
  7: 'DefineButton',
  8: 'JPEGTables',
  9: 'SetBackgroundColor',
  10: 'DefineFont',
  11: 'DefineText',
  12: 'DoAction',
  13: 'DefineFontInfo',
  14: 'DefineSound',
  15: 'StartSound',
  17: 'DefineButtonSound',
  18: 'SoundStreamHead',
  19: 'SoundStreamBlock',
  20: 'DefineBitsLossless',
  21: 'DefineBitsJPEG2',
  22: 'DefineShape2',
  24: 'Protect',
  26: 'PlaceObject2',
  28: 'RemoveObject2',
  32: 'DefineShape3',
  33: 'DefineText2',
  34: 'DefineButton2',
  35: 'DefineBitsJPEG3',
  36: 'DefineBitsLossless2',
  37: 'DefineEditText',
  39: 'DefineSprite',
  43: 'FrameLabel',
  45: 'SoundStreamHead2',
  46: 'DefineMorphShape',
  48: 'DefineFont2',
  56: 'ExportAssets',
  57: 'ImportAssets',
  58: 'EnableDebugger',
  59: 'DoInitAction',
  60: 'DefineVideoStream',
  61: 'VideoFrame',
  62: 'DefineFontInfo2',
  65: 'ScriptLimits',
  69: 'FileAttributes',
  70: 'PlaceObject3',
  73: 'DefineFontAlignZones',
  74: 'CSMTextSettings',
  75: 'DefineFont3',
  76: 'SymbolClass',
  77: 'Metadata',
  78: 'DefineScalingGrid',
  82: 'DoABC',
  83: 'DefineShape4',
  84: 'DefineMorphShape2',
  86: 'DefineSceneAndFrameLabelData',
  87: 'DefineBinaryData',
  88: 'DefineFontName',
  89: 'StartSound2',
  90: 'DefineBitsJPEG4',
  91: 'DefineFont4',
}

const SHAPES = new Set([2, 22, 32, 83])
const BITMAPS = new Set([6, 20, 21, 35, 36, 90])
const FONTS = new Set([10, 48, 75])
const SOUNDS = new Set([14])
const SPRITES = new Set([39])
const AVM1 = new Set([12, 59, 26]) // DoAction, DoInitAction, PlaceObject2 actions
const AVM2 = new Set([76, 72, 82]) // SymbolClass, DoABC2, DoABC

/** Bit reader over the movie header, which is packed rather than byte aligned. */
class Bits {
  /** @param {Buffer} body - the bytes after the 8 byte file header. */
  constructor(body) {
    this.body = body
    this.bit = 0
  }

  /** @param {number} n - how many bits, at most 32. @returns {number} unsigned value. */
  read(n) {
    let value = 0
    for (let i = 0; i < n; i += 1) {
      const byte = this.body[(this.bit / 8) | 0]
      if (byte === undefined) throw new Error('the movie header ends in the middle of a rectangle')
      value = value * 2 + ((byte >> (7 - (this.bit % 8))) & 1)
      this.bit += 1
    }
    return value
  }

  /** @param {number} n - how many bits. @returns {number} signed value. */
  readSigned(n) {
    if (n === 0) return 0
    const raw = this.read(n)
    return raw >= 2 ** (n - 1) ? raw - 2 ** n : raw
  }

  /** @returns {number} the byte offset after the bits just read. */
  get offset() {
    return Math.ceil(this.bit / 8)
  }
}

/**
 * Read one tag stream.
 * @param {Buffer} body - the movie, or the body of a sprite.
 * @param {number} start - byte offset of the first tag.
 * @param {() => number} budget - how many tags outside sprites to record.
 * @returns {{tags: Array<{code: number, name: string, offset: number, length: number}>, counts: Record<string, number>}} the tags found.
 */
function readTags(body, start, budget) {
  const tags = []
  const histogram = {}
  const counts = { shapes: 0, sprites: 0, bitmaps: 0, fonts: 0, sounds: 0, scripts: 0 }
  let at = start
  while (at + 2 <= body.length) {
    const head = body.readUInt16LE(at)
    let code = head >> 6
    let length = head & 0x3f
    let header = 2
    if (length === 0x3f) {
      if (at + 6 > body.length) break
      length = body.readUInt32LE(at + 2)
      header = 6
    }
    if (at + header + length > body.length) {
      throw new Error(`tag ${code} at ${at} claims ${length} bytes past the end of the movie`)
    }
    if (code === 0) break
    const payload = at + header
    if (SHAPES.has(code)) counts.shapes += 1
    if (SPRITES.has(code)) counts.sprites += 1
    if (BITMAPS.has(code)) counts.bitmaps += 1
    if (FONTS.has(code)) counts.fonts += 1
    if (SOUNDS.has(code)) counts.sounds += 1
    if (code === 82 || code === 72) counts.scripts += 1
    const name = TAG_NAMES[code] ?? `tag ${code}`
    histogram[name] = (histogram[name] ?? 0) + 1
    if (budget() > 0) tags.push({ code, name, offset: at, length })
    if (code === 39 && length >= 4) {
      /* A sprite carries its own small tag stream; read it for the counts only. */
      try {
        const inner = readTags(body.subarray(payload + 4, payload + length), 0, () => 0)
        for (const key of Object.keys(counts)) counts[key] += inner.counts[key] ?? 0
      } catch {
        /* a sprite this reader cannot walk still counts as a sprite */
      }
    }
    at = payload + length
  }
  return { tags, counts, histogram }
}

/**
 * Read a movie.
 * @param {Buffer|Uint8Array} input - the file.
 * @returns {object} header, whether it plays ActionScript 3, tag histogram and the first tags.
 */
export function parseSwf(input) {
  const file = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (file.length < 8) throw new Error('too short to be a SWF: 8 bytes of header are the minimum')
  const signature = file.subarray(0, 3).toString('latin1')
  if (signature !== 'FWS' && signature !== 'CWS' && signature !== 'ZWS') {
    throw new Error(`not a SWF: it starts with ${JSON.stringify(signature)}`)
  }
  const version = file[3]
  const declared = file.readUInt32LE(4)
  let body
  if (signature === 'FWS') body = file.subarray(8)
  else if (signature === 'CWS') body = inflateSync(file.subarray(8))
  else throw new Error('a ZWS movie is LZMA compressed, which this reader cannot open yet')
  const bits = new Bits(body)
  const nbits = bits.read(5)
  const box = [bits.readSigned(nbits), bits.readSigned(nbits), bits.readSigned(nbits), bits.readSigned(nbits)]
  const afterBox = bits.offset
  const rate = body.readUInt16LE(afterBox)
  const frames = body.readUInt16LE(afterBox + 2)
  const frameRate = Number(((rate & 0xff) / 256 + (rate >>> 8)).toFixed(2))
  let left = 40
  const tags = readTags(body, afterBox + 4, () => (left-- > 0 ? 1 : 0))
  const histogram = tags.histogram
  const names = new Set(Object.keys(histogram))
  const avm2ByTag = ['SymbolClass', 'DoABC', 'DoABC2'].some((name) => names.has(name))
  const avm1ByTag = ['DoAction', 'DoInitAction', 'PlaceObject2'].some((name) => names.has(name))
  const avm = avm2ByTag ? 'avm2' : avm1ByTag ? 'avm1' : 'none'
  return {
    signature,
    version,
    declaredBytes: declared,
    bytes: file.length,
    compressed: signature !== 'FWS',
    width: Math.round((box[1] - box[0]) / 20),
    height: Math.round((box[3] - box[2]) / 20),
    frameRate,
    frames,
    avm,
    counts: tags.counts,
    histogram,
    tags: tags.tags,
  }
}

/**
 * The report as lines a person or a model can read without the raw tag dump.
 * @param {object} report - from parseSwf.
 * @param {{tags?: number}} [options] - how many leading tags to list.
 * @returns {string[]} lines.
 */
export function describeSwf(report, options = {}) {
  const lines = [
    `a ${report.signature} movie, version ${report.version}, ${report.bytes} bytes${report.compressed ? ` (${report.declaredBytes} uncompressed)` : ''}`,
    `${report.width}x${report.height} at ${report.frameRate} frames a second, ${report.frames} frames (${(report.frames / Math.max(report.frameRate, 0.01)).toFixed(1)} s)`,
    report.avm === 'none' ? 'no ActionScript' : `needs ${report.avm === 'avm2' ? 'ActionScript 3 (AVM2)' : 'ActionScript 1/2 (AVM1)'}`,
    `made of ${report.counts.shapes} shape(s), ${report.counts.sprites} sprite(s), ${report.counts.bitmaps} bitmap(s), ${report.counts.fonts} font(s), ${report.counts.sounds} sound(s), ${report.counts.scripts} script block(s)`,
  ]
  const listed = report.tags.slice(0, options.tags ?? 12)
  if (listed.length > 0) {
    lines.push(`first tags ${listed.map((tag) => `${tag.name}@${tag.offset}+${tag.length}`).join(' ')}`)
  }
  return lines
}
