import assert from 'node:assert/strict'
import test from 'node:test'

import { GapClock, MAX_QUIET_MS, MAX_REST_MS, MIN_QUIET_MS, MIN_REST_MS, decide } from '../rest.js'

test('a chat that has never been used is given the floor, not a random window', () => {
  const clock = new GapClock()
  assert.equal(clock.typical(), 0)
  assert.equal(clock.restAfter(), MIN_REST_MS)
  assert.equal(clock.quietAfter(), MIN_QUIET_MS)
})

test('the window follows the rhythm the chat actually keeps', () => {
  const clock = new GapClock()
  let now = 0
  for (let i = 0; i < 20; i += 1) {
    now += 20_000
    clock.record(now)
  }
  /* A chat working every 20 s is thinking, not gone: six gaps of tolerance,
     and the same reasoning on the quiet side at half the factor. */
  assert.equal(clock.typical(), 20_000)
  /* 20 s steps earn 2 minutes: six gaps of tolerance, under the floor's own
     reason — a chat that is still working is not gone. */
  assert.equal(clock.restAfter(), 120_000)
  assert.equal(clock.quietAfter(), 40_000)
})

test('a slow chat that works every few minutes earns a longer rest', () => {
  const clock = new GapClock()
  let now = 0
  for (let i = 0; i < 30; i += 1) {
    now += 90_000
    clock.record(now)
  }
  assert.equal(clock.restAfter(), 6 * 90_000)
})

test('a long gap is a new sitting, not the rhythm', () => {
  const clock = new GapClock()
  let now = 0
  for (let i = 0; i < 10; i += 1) {
    now += 10_000
    clock.record(now)
  }
  /* The person went to lunch: that gap must not teach the clock that this
     chat normally pauses for an hour. */
  clock.record(now + MAX_REST_MS + 60_000)
  assert.equal(clock.typical(), 10_000)
  assert.ok(clock.restAfter() >= MIN_REST_MS)
})

test('the windows are clamped at both ends', () => {
  const slow = new GapClock()
  let now = 0
  for (let i = 0; i < 40; i += 1) {
    now += MAX_REST_MS - 1
    slow.record(now)
  }
  assert.ok(slow.restAfter() <= MAX_REST_MS)
  assert.ok(slow.quietAfter() <= MAX_QUIET_MS)
  assert.ok(slow.restAfter() > MIN_REST_MS)
})

test('the quantile is exact on a small window, not an estimate', () => {
  const clock = new GapClock()
  let now = 0
  for (let i = 0; i < 20; i += 1) {
    now += (i + 1) * 1000
    clock.record(now)
  }
  /* The first record only starts the clock, so the gaps are 2..20 s: the 95th
     percentile of those is 20 s and the middle one is 11 s. */
  assert.equal(clock.quantile(0.95), 20_000)
  assert.equal(clock.quantile(0.5), 11_000)
})

test('a watched browser is never put to sleep, whatever the clock says', () => {
  /* Someone looking at a page is a reason to keep it, never to park it: an
     idle chat with a viewer stays awake until the viewer's own silence is the
     thing being measured. */
  assert.equal(decide({ now: 10_000_000, lastUse: 0, restAt: 1, watched: 1, quietAfter: 20_000 }), 'awake')
  assert.equal(decide({ now: 1000, lastUse: 0, restAt: 10_000, watched: 1, quietAfter: 20_000 }), 'awake')
})

test('the rest starts only when the clock was really armed', () => {
  assert.equal(decide({ now: 100, lastUse: 50, restAt: 0, watched: 1, quietAfter: 20_000 }), 'awake')
  assert.equal(decide({ now: 5000, lastUse: 0, restAt: 4000, watched: 0, quietAfter: 20_000 }), 'rest')
})

test('a chat working right now is awake, and goes quiet on the way to rest', () => {
  assert.equal(decide({ now: 5000, lastUse: 4000, restAt: 90_000, watched: 0, quietAfter: 20_000 }), 'awake')
  assert.equal(decide({ now: 30_000, lastUse: 4000, restAt: 90_000, watched: 0, quietAfter: 20_000 }), 'quiet')
})
