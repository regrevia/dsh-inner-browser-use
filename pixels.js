/**
 * The screen without the picture: a page that draws itself — a game, a canvas
 * app, a Flash movie — has nothing a text tree can read, and a screenshot costs
 * image tokens on every step. This turns the screen into a small grid of
 * characters instead: one letter per block of pixels, the same letters for the
 * same colours, so a caller can see what changed by reading text.
 *
 * Everything here is pure: decode, average, quantise, diff. No browser, no
 * files, so it can be tested without one.
 */

import { inflateSync } from 'node:zlib'

/** Colours a screen block can be called, most common things first. */
export const PALETTE = [
  { char: '.', name: 'black', rgb: [16, 16, 16] },
  { char: ':', name: 'dark', rgb: [64, 64, 64] },
  { char: '-', name: 'gray', rgb: [112, 112, 112] },
  { char: '+', name: 'light', rgb: [168, 168, 168] },
  { char: '*', name: 'bright', rgb: [216, 216, 216] },
  { char: '#', name: 'white', rgb: [248, 248, 248] },
  { char: 'r', name: 'red', rgb: [208, 48, 48] },
  { char: 'g', name: 'green', rgb: [64, 176, 72] },
  { char: 'b', name: 'blue', rgb: [56, 104, 216] },
  { char: 'y', name: 'yellow', rgb: [232, 208, 72] },
  { char: 'c', name: 'cyan', rgb: [64, 200, 208] },
  { char: 'm', name: 'magenta', rgb: [200, 72, 200] },
  { char: 'o', name: 'orange', rgb: [224, 136, 48] },
  { char: 'p', name: 'purple', rgb: [112, 56, 168] },
  { char: 'n', name: 'brown', rgb: [136, 88, 48] },
]

/**
 * The letter closest to a colour. Grays and bright colours are judged by eye
 * first so a dark sky does not read as blue and a red button does not read as
 * brown.
 * @param {number} r - red 0..255.
 * @param {number} g - green 0..255.
 * @param {number} b - blue 0..255.
 * @returns {string} one character.
 */
export function quantize(r, g, b) {
  /* Red, green and blue are counted more heavily than a plain euclidean
     distance would: two colours a person calls different should not collapse
     into the same letter. */
  const red = r * 1.30
  const green = g * 1.15
  const blue = b * 0.90
  let best = PALETTE[0].char
  let near = Infinity
  for (const entry of PALETTE) {
    const dr = red - entry.rgb[0] * 1.30
    const dg = green - entry.rgb[1] * 1.15
    const db = blue - entry.rgb[2] * 0.90
    const d = dr * dr + dg * dg + db * db
    if (d < near) {
      near = d
      best = entry.char
    }
  }
  return best
}

/**
 * Read a PNG made by Chrome into plain pixels. Chrome writes 8-bit
 * non-interlaced images, RGB or RGBA; anything else is refused with a reason
 * rather than a guess.
 * @param {Buffer} file - the PNG bytes.
 * @returns {{width: number, height: number, data: Uint8Array, channels: number}} pixels, row-major.
 */
export function decodePng(file) {
  const bytes = new Uint8Array(file.buffer !== undefined && file.byteOffset === 0 && file.byteLength === file.buffer.byteLength ? file.buffer : file)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error('pixels: not a PNG')
  }
  let width = 0
  let height = 0
  let depth = 0
  let type = 0
  let interlace = 0
  const chunks = []
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const name = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (name === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      depth = body[8]
      type = body[9]
      interlace = body[12]
    } else if (name === 'IDAT') chunks.push(body)
    else if (name === 'IEND') break
    at += 12 + length
  }
  if (depth !== 8) throw new Error(`pixels: PNG depth ${depth} is not 8`)
  const channels = type === 6 ? 4 : type === 2 ? 3 : type === 0 ? 1 : 0
  if (channels === 0) throw new Error(`pixels: PNG colour type ${type} is not RGB`)
  if (interlace !== 0) throw new Error('pixels: interlaced PNG is not supported')
  const packed = inflateSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
  const stride = width * channels
  const out = new Uint8Array(width * height * channels)
  let raw = 0
  for (let y = 0; y < height; y += 1) {
    const filter = packed[raw]
    raw += 1
    const row = out.subarray(y * stride, (y + 1) * stride)
    const up = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const value = packed[raw + x]
      const left = x >= channels ? row[x - channels] : 0
      const above = up === null ? 0 : up[x]
      const corner = up !== null && x >= channels ? up[x - channels] : 0
      let said = value
      if (filter === 1) said = value + left
      else if (filter === 2) said = value + above
      else if (filter === 3) said = value + ((left + above) >> 1)
      else if (filter === 4) {
        const guess = left + above - corner
        const dl = Math.abs(guess - left)
        const du = Math.abs(guess - above)
        const dc = Math.abs(guess - corner)
        said = value + (dl <= du && dl <= dc ? left : du <= dc ? above : corner)
      } else if (filter !== 0) throw new Error(`pixels: PNG filter ${filter} is not known`)
      row[x] = said & 0xff
    }
    raw += stride
  }
  return { width, height, data: out, channels }
}

/**
 * Average each block of the picture into one character.
 * @param {{width: number, height: number, data: Uint8Array, channels: number}} png - decoded picture.
 * @param {number} cols - cells across.
 * @returns {{rows: string[], cols: number, rowCount: number, blockW: number, blockH: number}} the grid.
 */
export function gridOf(png, cols) {
  const across = Math.min(64, Math.max(4, Math.round(cols)))
  const rows = Math.min(64, Math.max(2, Math.round((across * png.height) / Math.max(1, png.width))))
  const blockW = png.width / across
  const blockH = png.height / rows
  const lines = []
  let seen = ''
  for (let ry = 0; ry < rows; ry += 1) {
    let line = ''
    for (let rx = 0; rx < across; rx += 1) {
      const x0 = Math.floor(rx * blockW)
      const x1 = Math.max(x0 + 1, Math.min(png.width, Math.floor((rx + 1) * blockW)))
      const y0 = Math.floor(ry * blockH)
      const y1 = Math.max(y0 + 1, Math.min(png.height, Math.floor((ry + 1) * blockH)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * png.width + x) * png.channels
          r += png.data[at]
          g += png.data[at + 1] ?? png.data[at]
          b += png.data[at + 2] ?? png.data[at]
          n += 1
        }
      }
      line += quantize(r / n, g / n, b / n)
    }
    lines.push(line)
    seen += line
  }
  return { rows: lines, cols: across, rowCount: rows, blockW, blockH }
}

/**
 * What changed between two grids of the same screen.
 * @param {string[]} before - earlier rows.
 * @param {string[]} after - later rows.
 * @returns {{cells: number, box: {x: number, y: number, w: number, h: number} | null}} the change.
 */
export function diffGrid(before, after) {
  if (before.length !== after.length || before.some((row, i) => row.length !== after[i].length)) {
    return { cells: Number.POSITIVE_INFINITY, box: null }
  }
  let cells = 0
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < after.length; y += 1) {
    for (let x = 0; x < after[y].length; x += 1) {
      if (before[y][x] === after[y][x]) continue
      cells += 1
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  if (cells === 0) return { cells: 0, box: null }
  return { cells, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } }
}

/**
 * Cut one box out of a grid, with a cell of margin around it.
 * @param {string[]} rows - the whole grid.
 * @param {{x: number, y: number, w: number, h: number}} box - changed cells.
 * @returns {{rows: string[], x: number, y: number}} the cut grid and where it starts.
 */
export function around(rows, box) {
  const x = Math.max(0, box.x - 1)
  const y = Math.max(0, box.y - 1)
  const to = Math.min(rows[0].length, box.x + box.w + 1)
  const down = Math.min(rows.length, box.y + box.h + 1)
  return { rows: rows.slice(y, down).map((row) => row.slice(x, to)), x, y }
}

/**
 * Where the picture sits inside the pane, and where a point on the pane falls on
 * the page. A point travels as a fraction of the picture rather than as a pixel:
 * a fraction still names the same spot after the page has changed size, a pixel
 * does not, and a click that slides is worse than one that refuses.
 *
 * @param {number} viewW - the page's width in its own pixels.
 * @param {number} viewH - the page's height in its own pixels.
 * @param {number} areaW - the pane's width on screen.
 * @param {number} areaH - the pane's height on screen.
 * @returns {{scale: number, x: number, y: number, w: number, h: number}|null} the drawn box, or null when nothing can be drawn.
 */
export function pictureBox(viewW, viewH, areaW, areaH) {
  if (!(viewW > 0) || !(viewH > 0) || !(areaW > 1) || !(areaH > 1)) return null
  const scale = Math.min(areaW / viewW, areaH / viewH)
  if (!(scale > 0) || Number.isFinite(scale) === false) return null
  const w = viewW * scale
  const h = viewH * scale
  return { scale, x: (areaW - w) / 2, y: (areaH - h) / 2, w, h }
}

/**
 * A point on the pane as a fraction of the picture. A point on the bar beside a
 * letterboxed picture is not on the page, so it answers null instead of
 * pretending to be the picture's nearest edge.
 * @param {number} px - across, from the pane's own left edge.
 * @param {number} py - down, from the pane's own top edge.
 * @param {{x: number, y: number, w: number, h: number}|null} box - from pictureBox.
 * @returns {{fx: number, fy: number}|null} 0..1 across and down.
 */
export function fractionAt(px, py, box) {
  if (box === null || box === undefined) return null
  if (Number.isFinite(px) === false || Number.isFinite(py) === false) return null
  if (!(box.w > 0) || !(box.h > 0)) return null
  const fx = (px - box.x) / box.w
  const fy = (py - box.y) / box.h
  if (!(fx >= -1 / box.w) || !(fx <= 1 + 1 / box.w)) return null
  if (!(fy >= -1 / box.h) || !(fy <= 1 + 1 / box.h)) return null
  return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) }
}

/**
 * The page point a pane's fraction names, choosing the size it is a fraction of.
 * A picture capped in pixels (a screencast is capped) is smaller than the page
 * it shows, so the picture's own width would shrink every point toward the
 * corner. The page size the pane saw with that picture wins; the size this side
 * believes comes next; the picture is the last resort.
 * @param {{fx?: number, fy?: number, pw?: number, ph?: number, fw?: number, fh?: number}} body - one input event.
 * @param {{width?: number, height?: number}|null} view - the size this side believes.
 * @returns {{x: number, y: number}|null} the point, or null when no size is known.
 */
export function aimAt(body, view) {
  const pick = (named, believed, drawn) => {
    const numbers = [named, believed, drawn].map((value) => Number(value ?? 0))
    return numbers.find((value) => value > 0) ?? 0
  }
  return pointAt(
    Number(body?.fx ?? NaN),
    Number(body?.fy ?? NaN),
    pick(body?.pw, view?.width, body?.fw),
    pick(body?.ph, view?.height, body?.fh),
  )
}

/**
 * The page point a fraction names, inside the page's own viewport.
 * @param {number} fx - 0..1 across.
 * @param {number} fy - 0..1 down.
 * @param {number} width - the page's width in CSS pixels.
 * @param {number} height - the page's height in CSS pixels.
 * @returns {{x: number, y: number}|null} the point, or null when the page has no size.
 */
export function pointAt(fx, fy, width, height) {
  const w = Math.round(Number(width))
  const h = Math.round(Number(height))
  if (!(w > 0) || !(h > 0)) return null
  if (Number.isFinite(fx) === false || Number.isFinite(fy) === false) return null
  const across = Math.min(1, Math.max(0, fx))
  const down = Math.min(1, Math.max(0, fy))
  return { x: Math.round(across * (w - 1)), y: Math.round(down * (h - 1)) }
}
