/**
 * A review round: hand a repository address to the chat in the column, take its
 * review back, and remember which commit the review was about. The log is what
 * makes the next round checkable — advice given about a commit that has since
 * moved on is stale, and saying so costs one line instead of a reread.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where rounds are kept when the caller does not say. */
export const ROUND_DIR = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), 'inner-browser-use', 'rounds')

/** How long an answer may be, so a chatty model cannot flood the log. */
const ANSWER_CAP = 6000

/**
 * @param {string} text - one line of configuration.
 * @returns {string} the value, or an empty string.
 */
function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The message to send: enough for a reviewer that has never seen this project,
 * and no more. The address carries the code, so the message does not paste any.
 * @param {{repo?: string, commit?: string, focus?: string}} [what] - what to review.
 * @returns {string} the message.
 */
export function brief(what = {}) {
  const repo = clean(what.repo)
  /* What the reviewer said last time and what the code did about it: a point
     already answered is not raised again, so a round does not re-litigate. */
  const handled = Array.isArray(what.already) ? what.already.filter((mark) => clean(mark?.status) !== 'open') : []
  const commit = clean(what.commit)
  const focus = clean(what.focus)
  const lines = ['Please review the latest code and tell me what to change.']
  if (repo !== '') lines.push(`Repository: ${repo}`)
  if (commit !== '') lines.push(`Look at commit ${commit} (the newest one) and the files it touches.`)
  else lines.push('Look at the newest commit and the files it touches.')
  if (focus !== '') lines.push(`Focus on: ${focus}`)
  /* The reviewer cannot open the repository, so the change travels with the
     request. Capped: a whole diff would bury the question it is attached to. */
  const diff = String(what.diff ?? '').trim()
  if (diff !== '') {
    const cap = 5000
    lines.push('The change under review, inline (a diff):')
    lines.push(diff.length <= cap ? diff : `${diff.slice(0, cap)}\n… (trimmed)`)
  }
  if (handled.length > 0) {
    lines.push('Already handled from your previous review, do not raise these again:')
    for (const mark of handled.slice(0, 12)) {
      const note = clean(mark.evidence) === '' ? '' : ` (${clean(mark.evidence).slice(0, 120)})`
      lines.push(`- ${clean(mark.text).slice(0, 200)} — ${clean(mark.status)}${note}`)
    }
  }
  lines.push('Answer with a short list: what is wrong, and the smallest change that fixes it. Name the file for each point.')
  return lines.join('\n')
}

/**
 * The suggestions in an answer, one line each: reviewers are asked for a list,
 * and the list is what the next round acts on.
 * @param {string} answer - what the reviewer said.
 * @returns {string[]} the points, in the order given.
 */
export function points(answer) {
  /* A page read flattens an answer into one line, so a list arrives as
     "intro - first point - second point". Split on the markers a reviewer uses
     for items, keep only pieces that carry a marker, and drop the echo of the
     question when the page repeats it above the answer. */
  const out = []
  const seen = new Set()
  for (const raw of String(answer ?? '').split(/\r?\n/)) {
    const parts = raw.split(/\s+[-\u2022\u2013\u2014]\s+|\s+(?=\d+[.)]\s)/).map((part) => part.trim()).filter((part) => part !== '')
    if (parts.length === 1 && !/^(?:[-*\u2022]|\d+[.)])\s+/.test(parts[0])) continue
    for (let at = 0; at < parts.length; at += 1) {
      let line = parts[at]
      if (at === 0 && !/^(?:[-*\u2022]|\d+[.)])\s+/.test(line)) continue
      line = line.replace(/^(?:Answer:\s*)/i, '').replace(/^(?:[-*\u2022]|\d+[.)])\s+/, '').trim()
      if (/^(?:Please review|Repository:|Look at commit|Focus on:|Answer with)/i.test(line)) continue
      if (line.length < 8 || line.length > 400) continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
    }
  }
  return out.slice(0, 40)
}

/**
 * Write one round down. Append-only: a round is history, not state to rewrite.
 * @param {{dir?: string, commit?: string, question?: string, answer?: string, tookMs?: number}} entry - the round.
 * @returns {{file: string, round: any}} where it went and what was written.
 */
export function recordRound(entry = {}) {
  const dir = clean(entry.dir) === '' ? ROUND_DIR : clean(entry.dir)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rounds.ndjson')
  const round = {
    at: new Date().toISOString(),
    commit: clean(entry.commit),
    question: clean(entry.question).slice(0, 400),
    answer: String(entry.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, ANSWER_CAP),
    points: points(entry.answer),
    tookMs: Math.max(0, Math.trunc(Number(entry.tookMs ?? 0)) || 0),
  }
  appendFileSync(file, `${JSON.stringify(round)}\n`)
  return { file, round }
}

/**
 * The last round played, for a round that wants to know what it was told before.
 * @param {{dir?: string}} [where] - which log.
 * @returns {any|null} the last round, or null when none was played.
 */
export function lastRound(where = {}) {
  const dir = clean(where.dir) === '' ? ROUND_DIR : clean(where.dir)
  const file = join(dir, 'rounds.ndjson')
  if (!existsSync(file)) return null
  const rows = readFileSync(file, 'utf8').split('\n').filter((row) => row.trim() !== '')
  if (rows.length === 0) return null
  /* Verdicts are separate rows, appended after the round they judge: find the
     newest round, then fold in the marks written since. */
  /** @type {any[]} */
  const rows2 = []
  for (const row of rows) {
    try {
      rows2.push(JSON.parse(row))
    } catch {
      /* a torn line costs its own row, not the log */
    }
  }
  let at = -1
  for (let i = rows2.length - 1; i >= 0; i -= 1) {
    if (rows2[i]?.kind !== 'verdict') {
      at = i
      break
    }
  }
  if (at < 0) return null
  const round = rows2[at]
  const latest = new Map()
  for (const row of rows2.slice(at + 1)) {
    if (row?.kind !== 'verdict' || clean(row.roundAt) !== clean(round.at)) continue
    for (const mark of Array.isArray(row.marks) ? row.marks : []) if (Number.isInteger(mark?.point)) latest.set(mark.point, mark)
  }
  return { ...round, marks: [...latest.values()].sort((a, b) => a.point - b.point) }
}

/** What a point can be, once the code has looked at it. */
export const MARK_STATUS = ['fixed', 'verified', 'invalid', 'open']

/**
 * Say what happened to the points of the last round. The verdict is history
 * too: it is appended, and the next round reads it so a settled point is not
 * raised twice.
 * @param {{dir?: string, marks?: any[]}} entry - point numbers (1-based) and their outcome.
 * @returns {{file: string, round: any, marks: any[]}|null} what was written, or null when there is no round.
 */
export function markRound(entry = {}) {
  const dir = clean(entry.dir) === '' ? ROUND_DIR : clean(entry.dir)
  const round = lastRound({ dir })
  if (round === null) return null
  const said = Array.isArray(round.points) ? round.points : []
  /** @type {any[]} */
  const marks = []
  for (const raw of Array.isArray(entry.marks) ? entry.marks : []) {
    const point = Math.trunc(Number(raw?.point ?? 0))
    if (point < 1 || point > said.length) continue
    const status = MARK_STATUS.includes(clean(raw?.status)) ? clean(raw.status) : 'open'
    marks.push({ point, text: said[point - 1], status, evidence: clean(raw?.evidence).slice(0, 200), at: new Date().toISOString() })
  }
  if (marks.length === 0) return null
  const file = join(dir, 'rounds.ndjson')
  mkdirSync(dir, { recursive: true })
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind: 'verdict', roundAt: round.at, commit: round.commit, marks })}\n`)
  return { file, round, marks }
}

/**
 * One line for the model: what the reviewer said last, and whether the code has
 * moved since. A review of an old commit is worth reading and not worth obeying.
 * @param {{dir?: string, commit?: string}} [now] - the commit the code is at now.
 * @returns {string} the note, or an empty string when no round was played.
 */
export function lastRoundNote(now = {}) {
  const last = lastRound(now)
  if (last === null) return ''
  const commit = clean(now.commit)
  const same = commit === '' || last.commit === '' || last.commit === commit
  const points = Array.isArray(last.points) ? last.points : []
  const head = points.length === 0 ? 'the reviewer gave no list' : `${points.length} point${points.length === 1 ? '' : 's'}`
  const when = same ? 'about this commit' : `about ${String(last.commit).slice(0, 12)}, and the code has moved since`
  return `Last review (${last.at.slice(0, 16).replace('T', ' ')}): ${head}, ${when}.`
}

/**
 * The reviewer's last points as a list to act on.
 * @param {{dir?: string}} [where] - which log.
 * @returns {string[]} the points.
 */
export function lastPoints(where = {}) {
  const last = lastRound(where)
  return last !== null && Array.isArray(last.points) ? last.points : []
}

/** @returns {string} the directory the log lives in. */
export function roundDir() {
  return dirname(join(ROUND_DIR, 'rounds.ndjson'))
}
