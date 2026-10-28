import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { brief, lastRound, markRound, recordRound } from '../review.js'

const dirFor = () => mkdtempSync(join(tmpdir(), 'dshib-round-'))

test('a mark records what happened to a point, and the next round reads it back', () => {
  const dir = dirFor()
  const { round } = recordRound({ dir, commit: 'abc123', answer: '1. the button is too small to hit\n2. the error text lies about the cause' })
  assert.equal(round.points.length, 2)
  const written = markRound({ dir, marks: [{ point: 1, status: 'fixed', evidence: 'commit 9f2' }, { point: 2, status: 'open' }] })
  assert.equal(written.marks.length, 2)
  const last = lastRound({ dir })
  assert.deepEqual(last.marks.map((mark) => `${mark.point}:${mark.status}`), ['1:fixed', '2:open'])
  assert.equal(last.marks[0].text, round.points[0], 'a mark keeps the words it judges')
  assert.equal(last.commit, 'abc123')
})

test('a settled point is left out of the next question, an open one is not', () => {
  const dir = dirFor()
  const { round } = recordRound({ dir, answer: '1. the button is too small to hit\n2. the error text lies about the cause' })
  markRound({ dir, marks: [{ point: 1, status: 'fixed', evidence: 'commit 9f2' }, { point: 2, status: 'open' }] })
  const asked = brief({ repo: 'example', already: lastRound({ dir }).marks })
  assert.match(asked, /Already handled from your previous review/)
  assert.match(asked, new RegExp(round.points[0].slice(0, 20)))
  assert.match(asked, /fixed/)
  assert.doesNotMatch(asked, new RegExp(round.points[1].slice(0, 20)), 'a point still open stays a question')
})

test('a mark for a point that is not there is dropped, not invented', () => {
  const dir = dirFor()
  recordRound({ dir, answer: '1. only one point worth making here' })
  assert.equal(markRound({ dir, marks: [{ point: 7, status: 'fixed' }] }), null)
  assert.equal(markRound({ dir, marks: [{ point: 1, status: 'nonsense' }] }).marks[0].status, 'open', 'an unknown status reads as open')
  assert.deepEqual(lastRound({ dir }).marks.map((mark) => mark.point), [1])
})

test('marking a log with no round answers nothing to mark', () => {
  assert.equal(markRound({ dir: dirFor(), marks: [{ point: 1, status: 'fixed' }] }), null)
  assert.equal(lastRound({ dir: dirFor() }), null)
})
