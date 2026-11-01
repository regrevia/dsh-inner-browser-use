/* When to put the browser down.
 *
 * A fixed fifteen minutes is either too long (a chat that asks one question
 * and walks away leaves a whole Chrome standing for a quarter of an hour) or
 * too short (a long task that thinks for a minute between reads) — and the
 * number that tells the two apart is already in the chat, in the gaps between
 * one call and the next. So the browser learns its own rhythm: the 95th
 * percentile of recent gaps says how long this chat pauses while it is still
 * working, and the rest window is a multiple of that, floored and capped so a
 * fast chat still gets a minute of grace and a slow one is not kept forever.
 *
 * Only the last few dozen gaps count. A stale rhythm from an hour ago is not
 * evidence about now, and a sliding window forgets it without a decay constant
 * to tune. The percentile is exact over that window: cheap at this size, and
 * not an estimate that can drift.
 */

/** Shortest rest window: a chat that works in two-second steps still gets grace. */
export const MIN_REST_MS = 90_000
/** Longest rest window: nothing learned may keep a browser up for longer than this. */
export const MAX_REST_MS = 15 * 60_000
/** Shortest quiet window: how soon an idle chat stops paying for a picture nobody sees. */
export const MIN_QUIET_MS = 20_000
/** Longest quiet window. */
export const MAX_QUIET_MS = 2 * 60_000
/** How many recent gaps make up the learned rhythm. */
const WINDOW = 64
/** Rest at this multiple of the learned p95: long enough to sit through a pause. */
const REST_FACTOR = 6
/** Quiet at this multiple: two slow steps in a row is a pause, not a break. */
const QUIET_FACTOR = 2

/**
 * @param {number} value - what to keep in range.
 * @param {number} low - smallest allowed.
 * @param {number} high - largest allowed.
 * @returns {number} `value` inside `[low, high]`.
 */
function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low
  return Math.min(high, Math.max(low, value))
}

/**
 * The recent gaps between one use of this browser and the next, and what they
 * say about how long a pause is still "working" rather than "gone".
 */
export class GapClock {
  /** @param {{window?: number}} [options] - how many gaps to keep. */
  constructor(options = {}) {
    /** @type {number} when the browser was last used, in ms. */
    this.last = 0
    /** @type {number[]} the recent gaps, oldest first. */
    this.gaps = []
    this.window = Math.max(4, Number(options.window ?? WINDOW) || WINDOW)
    /** @type {number} how many gaps were seen at all, for reporting. */
    this.seen = 0
  }

  /**
   * Notes a use now and returns the gap it closed.
   * @param {number} [now] - the moment of this use.
   * @returns {number} the gap in ms, or 0 when there is no rhythm yet.
   */
  record(now = Date.now()) {
    const at = Number(now)
    const was = Number(this.last)
    this.last = at
    if (!Number.isFinite(was) || was <= 0 || !Number.isFinite(at) || at <= was) return 0
    const gap = at - was
    /* A gap longer than the longest rest window is a new sitting, not a step:
       folding it in would teach the browser that hours are normal. */
    if (gap > MAX_REST_MS) return 0
    this.gaps.push(gap)
    if (this.gaps.length > this.window) this.gaps.shift()
    this.seen += 1
    return gap
  }

  /**
   * @param {number} q - a fraction in (0, 1].
   * @returns {number} that percentile of the kept gaps, or 0 with no rhythm.
   */
  quantile(q = 0.95) {
    const size = this.gaps.length
    if (size === 0) return 0
    const sorted = [...this.gaps].sort((a, b) => a - b)
    const at = clamp(Math.ceil(q * size) - 1, 0, size - 1)
    return sorted[at]
  }

  /** @returns {number} ms of silence after which the browser may be put down. */
  restAfter() {
    if (this.gaps.length === 0) return MIN_REST_MS
    return clamp(this.quantile(0.95) * REST_FACTOR, MIN_REST_MS, MAX_REST_MS)
  }

  /** @returns {number} ms of silence after which an unwatched page may stop painting. */
  quietAfter() {
    if (this.gaps.length === 0) return MIN_QUIET_MS
    return clamp(this.quantile(0.95) * QUIET_FACTOR, MIN_QUIET_MS, MAX_QUIET_MS)
  }

  /** @returns {number} the middle gap, for a report that has to be readable. */
  typical() {
    return this.quantile(0.5)
  }
}

/**
 * What the browser should do about time passing right now.
 * @param {{now: number, lastUse: number, restAt: number, watched: number, quietAfter: number}} state - clocks and viewers.
 * @returns {'awake'|'quiet'|'rest'} `rest` means nobody is watching and the window ran out.
 */
export function decide(state) {
  const now = Number(state.now ?? 0)
  const watched = Number(state.watched ?? 0)
  const lastUse = Number(state.lastUse ?? 0)
  const restAt = Number(state.restAt ?? 0)
  if (watched > 0) return lastUse > 0 && now - lastUse >= Number(state.quietAfter ?? MIN_QUIET_MS) ? 'quiet' : 'awake'
  if (restAt > 0 && now >= restAt) return 'rest'
  if (lastUse > 0 && now - lastUse >= Number(state.quietAfter ?? MIN_QUIET_MS)) return 'quiet'
  return 'awake'
}
