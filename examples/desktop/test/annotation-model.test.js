// Pure-model tests for annotation-model. Covers blank init, overall verdict,
// task tag, per-turn 5-dim scoring, completeness, turn enumeration, and both
// export projections (jsonl-to-html row and (state, action, reward) triples).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const A = require('../src/renderer/annotation-model.js')
const R = require('../src/renderer/rubrics-model.js')

function sampleEvents() {
  return [
    { type: 'user/message', content: 'Please write a fibonacci function.' },
    { type: 'assistant/message', content: 'Here is a naive recursive one.', reasoning_content: 'Consider iterative.' },
    { type: 'user/message', content: 'Make it iterative.' },
    { type: 'assistant/message', content: 'def fib(n): ...' },
    { type: 'tool/call', tool: 'shell', arguments: { cmd: 'python fib.py' } },
    { type: 'user/message', content: 'Add a memoized decorator.' },
    { type: 'assistant/message', content: 'from functools import lru_cache...' },
  ]
}

test('blankAnnotation: shape matches contract', () => {
  const ann = A.blankAnnotation('sess-1')
  assert.equal(ann.sessionId, 'sess-1')
  assert.equal(ann.overall, null)
  assert.equal(ann.taskGroup, null)
  assert.equal(ann.taskSubtask, null)
  assert.deepEqual(ann.turnScores, [])
})

test('setOverall: accepts bad/ok/good; rejects garbage; stamps updatedAt', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'good', 100)
  assert.equal(ann.overall, 'good')
  assert.equal(ann.updatedAt, 100)
  const same = A.setOverall(ann, 'terrible', 200)
  assert.equal(same, ann, 'garbage verdict is a no-op that returns the previous record')
  ann = A.setOverall(ann, null, 300)
  assert.equal(ann.overall, null)
})

test('setTaskTag: validates group + subtask against the 28-list', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setTaskTag(ann, 'fix-optimize', 'bug-fix', 100)
  assert.equal(ann.taskGroup, 'fix-optimize')
  assert.equal(ann.taskSubtask, 'bug-fix')
  const bad = A.setTaskTag(ann, 'fix-optimize', 'not-a-subtask', 200)
  assert.equal(bad, ann, 'unknown subtask is a no-op')
  const badGroup = A.setTaskTag(ann, 'no-such', 'bug-fix', 200)
  assert.equal(badGroup, ann, 'unknown group is a no-op')
})

test('setTurnScore: writes per-dim 1-5; clamps out-of-range; ignores unknown dims', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, {
    dims: { 'feedback-understanding': 4, 'fix-effectiveness': 9, 'nope': 3 },
    note: 'first attempt was too naive',
  }, 100)
  const t = ann.turnScores[0]
  assert.equal(t.turnIndex, 0)
  assert.equal(t.dims['feedback-understanding'], 4)
  assert.equal(t.dims['fix-effectiveness'], 5, 'clamps 9 → 5')
  assert.equal(t.dims['nope'], undefined, 'unknown dim not written')
  assert.equal(t.note, 'first attempt was too naive')
})

test('setTurnScore: partial patches merge instead of overwriting', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, { dims: { 'feedback-understanding': 4 } }, 100)
  ann = A.setTurnScore(ann, 0, { dims: { 'no-regression': 5 } }, 200)
  const t = ann.turnScores[0]
  assert.equal(t.dims['feedback-understanding'], 4)
  assert.equal(t.dims['no-regression'], 5)
})

test('setTurnScore: rejects negative turnIndex; ignores fractional inputs by rounding', () => {
  const start = A.blankAnnotation('s')
  const noop = A.setTurnScore(start, -1, { dims: { 'convergence': 3 } })
  assert.equal(noop, start)
  const rounded = A.setTurnScore(start, 0, { dims: { 'convergence': 3.7 } })
  assert.equal(rounded.turnScores[0].dims['convergence'], 4)
})

test('completeness: counts fully-scored turns; complete iff overall+every turn scored', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'ok', 0)
  const dims = {}
  for (const d of R.MULTI_TURN_DIMENSIONS) dims[d.id] = 3
  ann = A.setTurnScore(ann, 0, { dims }, 0)
  ann = A.setTurnScore(ann, 1, { dims: { 'feedback-understanding': 4 } }, 0)  // partial
  const c = A.completeness(ann, 2)
  assert.equal(c.annotatedTurns, 1, 'partial turn does not count as fully annotated')
  assert.equal(c.totalTurns, 2)
  assert.equal(c.hasOverall, true)
  assert.equal(c.complete, false)
  ann = A.setTurnScore(ann, 1, { dims }, 0)
  const c2 = A.completeness(ann, 2)
  assert.equal(c2.complete, true)
})

test('enumerateAssistantTurns: extracts assistant turns with prior-user text', () => {
  const list = A.enumerateAssistantTurns(sampleEvents())
  assert.equal(list.length, 3)
  assert.equal(list[0].turnIndex, 0)
  assert.equal(list[0].priorFeedback, 'Please write a fibonacci function.')
  assert.equal(list[1].priorFeedback, 'Make it iterative.')
  assert.equal(list[2].priorFeedback, 'Add a memoized decorator.')
})

test('projectJsonlRow: maps to jsonl-to-html shape with annotation-fields block', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'good', 0)
  ann = A.setTaskTag(ann, 'fix-optimize', 'bug-fix', 0)
  ann = A.setTurnScore(ann, 0, { dims: { 'feedback-understanding': 5, 'fix-effectiveness': 4 }, priorFeedback: 'Please write...' }, 0)
  const row = A.projectJsonlRow(sampleEvents(), ann, { annotator: 'ziya', now: 42 })
  assert.equal(row.messages.length, 6)  // 3 user + 3 assistant
  assert.equal(row.messages[0].role, 'user')
  assert.equal(row.messages[1].role, 'assistant')
  assert.equal(row.tool_calls.length, 1)
  assert.equal(row.tool_calls[0].name, 'shell')
  const af = row['annotation-fields']
  assert.equal(af.overall, 'good')
  assert.equal(af.task_group, 'fix-optimize')
  assert.equal(af.task_subtask, 'bug-fix')
  assert.equal(af.turn_scores.length, 1)
  assert.equal(af.turn_scores[0].turn_index, 0)
  assert.equal(af.turn_scores[0]['feedback-understanding'], 5)
  assert.equal(af.turn_scores[0].prior_feedback, 'Please write...')
  assert.equal(af.annotator, 'ziya')
  assert.equal(af.exported_at, 42)
})

test('projectJsonlRow: returns null when there are no messages', () => {
  assert.equal(A.projectJsonlRow([], A.blankAnnotation('s')), null)
  assert.equal(A.projectJsonlRow([{ type: 'tool/call', tool: 'x' }], A.blankAnnotation('s')), null)
})

test('projectTripleRows: one row per assistant turn; reward = mean(dims) scaled to 0-1', () => {
  let ann = A.blankAnnotation('s')
  const dims = {}
  for (const d of R.MULTI_TURN_DIMENSIONS) dims[d.id] = 5
  ann = A.setTurnScore(ann, 0, { dims }, 0)
  const dimsMid = {}
  for (const d of R.MULTI_TURN_DIMENSIONS) dimsMid[d.id] = 3
  ann = A.setTurnScore(ann, 1, { dims: dimsMid }, 0)
  // turn 2 not scored
  const rows = A.projectTripleRows(sampleEvents(), ann, 'sess-x')
  assert.equal(rows.length, 3)
  assert.equal(rows[0].turn_index, 0)
  assert.equal(rows[0].session_id, 'sess-x')
  assert.equal(rows[0].reward, 1)          // 5→1.0 normalized
  assert.equal(rows[1].reward, 0.5)        // 3→0.5 normalized
  assert.equal(rows[2].reward, null)       // unscored
  // state grows monotonically
  assert.equal(rows[0].state.length, 1)
  assert.equal(rows[1].state.length, 3)
  assert.equal(rows[2].state.length, 5)
})

test('serializeJsonl + estimateExportSize: sizes match the emitted bytes', () => {
  const rows = [
    { messages: [{ role: 'user', content: 'hi' }] },
    { messages: [{ role: 'user', content: 'bye' }] },
  ]
  const out = A.serializeJsonl(rows)
  assert.ok(out.endsWith('\n'))
  assert.equal(out.split('\n').filter(Boolean).length, 2)
  const est = A.estimateExportSize(rows)
  assert.equal(est, out.length)
})

test('serializeJsonl: empty input yields empty string', () => {
  assert.equal(A.serializeJsonl([]), '')
  assert.equal(A.serializeJsonl(null), '')
})

// #205 Feedback-tab shape append — annotator (session level) + per-turn
// updatedAt. Both fields must survive the projection.
test('blankAnnotation: exposes annotator slot (defaults to null)', () => {
  const ann = A.blankAnnotation('s')
  assert.equal(ann.annotator, null, 'annotator key present so consumers can rely on it')
})

test('setTurnScore: stamps per-turn updatedAt on every write', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, { dims: { 'feedback-understanding': 3 } }, 111)
  assert.equal(ann.turnScores[0].updatedAt, 111, 'first write stamps time')
  ann = A.setTurnScore(ann, 0, { dims: { 'convergence': 5 } }, 222)
  assert.equal(ann.turnScores[0].updatedAt, 222, 'subsequent write refreshes time')
  ann = A.setTurnScore(ann, 1, { dims: { 'no-regression': 4 } }, 333)
  const t0 = ann.turnScores.find(t => t.turnIndex === 0)
  const t1 = ann.turnScores.find(t => t.turnIndex === 1)
  assert.equal(t0.updatedAt, 222, "other turn's stamp is unchanged")
  assert.equal(t1.updatedAt, 333)
})

test('projectJsonlRow: carries per-turn updated_at when present', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'ok', 0)
  ann = A.setTurnScore(ann, 0, { dims: { 'feedback-understanding': 4 } }, 900)
  const row = A.projectJsonlRow(sampleEvents(), ann, { now: 42 })
  assert.equal(row['annotation-fields'].turn_scores[0].updated_at, 900)
})

test('projectJsonlRow: prefers stored annotator when opts.annotator omitted', () => {
  let ann = A.blankAnnotation('s')
  ann.annotator = 'local-user'
  ann = A.setOverall(ann, 'ok', 0)
  const row = A.projectJsonlRow(sampleEvents(), ann, { now: 0 })
  assert.equal(row['annotation-fields'].annotator, 'local-user')
  const overridden = A.projectJsonlRow(sampleEvents(), ann, { annotator: 'reviewer-1', now: 0 })
  assert.equal(overridden['annotation-fields'].annotator, 'reviewer-1', 'opts wins over stored value')
})

// ─── Typed-dim rubric primitives (Continuous/Categorical/Boolean) ───────

test('setTurnScore(opts.dims): validates each typed primitive', () => {
  const dims = [
    { id: 'quality', type: 'continuous', min: 0, max: 10 },
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] },
    { id: 'passes', type: 'boolean' },
  ]
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, {
    dims: {
      quality: 7,
      verdict: 'good',
      passes: true,
      'unknown-dim': 'should-drop',
    },
  }, 100, { dims })
  const t = ann.turnScores[0]
  assert.equal(t.dims.quality, 7)
  assert.equal(t.dims.verdict, 'good')
  assert.equal(t.dims.passes, true)
  assert.equal(t.dims['unknown-dim'], undefined, 'unknown dim dropped')
})

test('setTurnScore(opts.dims): rejects out-of-enum categorical + non-bool boolean', () => {
  const dims = [
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] },
    { id: 'passes', type: 'boolean' },
  ]
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, {
    dims: { verdict: 'stellar', passes: 'maybe' },
  }, 0, { dims })
  const t = ann.turnScores[0]
  assert.equal(t.dims.verdict, undefined, 'non-enum categorical dropped')
  assert.equal(t.dims.passes, undefined, 'unrecognizable boolean dropped')
})

test('setTurnScore(): no opts.dims → legacy 5-fixed-dim clamping unchanged', () => {
  // Regression guard: existing callers pass no opts and expect the 1-5
  // clamp on the fixed dims. This is what the current demo relies on.
  let ann = A.blankAnnotation('s')
  ann = A.setTurnScore(ann, 0, { dims: { 'convergence': 9 } }, 0)
  assert.equal(ann.turnScores[0].dims['convergence'], 5, 'legacy clamp to max=5 kicks in')
})

test('completeness(opts.dims): counts typed rubric dims', () => {
  const dims = [
    { id: 'quality', type: 'continuous', min: 0, max: 1 },
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] },
  ]
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'good', 0)
  ann = A.setTurnScore(ann, 0, { dims: { quality: 0.8 } }, 0, { dims })
  const partial = A.completeness(ann, 1, { dims })
  assert.equal(partial.annotatedTurns, 0, 'quality-only turn is partial')
  ann = A.setTurnScore(ann, 0, { dims: { verdict: 'good' } }, 0, { dims })
  const full = A.completeness(ann, 1, { dims })
  assert.equal(full.annotatedTurns, 1, 'both dims → fully annotated')
  assert.equal(full.complete, true)
})

test('projectJsonlRow(opts.dims): emits dim_types metadata block', () => {
  const dims = [
    { id: 'quality', type: 'continuous', min: 0, max: 10 },
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] },
    { id: 'passes', type: 'boolean', labels: { true: 'pass', false: 'fail' } },
  ]
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'good', 0)
  ann = A.setTurnScore(ann, 0, {
    dims: { quality: 7, verdict: 'good', passes: true },
  }, 0, { dims })
  const row = A.projectJsonlRow(sampleEvents(), ann, { dims, now: 0 })
  const af = row['annotation-fields']
  // Existing turn_scores structure is preserved — values pass through
  // as-is (string for categorical, bool for boolean, number for continuous).
  const t = af.turn_scores[0]
  assert.equal(t.quality, 7)
  assert.equal(t.verdict, 'good')
  assert.equal(t.passes, true)
  // dim_types slice is the reference tracing UI FeedbackSchema parity block.
  assert.ok(af.dim_types, 'dim_types block present when opts.dims passed')
  assert.equal(af.dim_types.quality.type, 'continuous')
  assert.equal(af.dim_types.quality.min, 0)
  assert.equal(af.dim_types.quality.max, 10)
  assert.deepEqual(af.dim_types.verdict.values, ['bad', 'ok', 'good'])
  assert.deepEqual(af.dim_types.passes.labels, { true: 'pass', false: 'fail' })
})

test('projectJsonlRow: no opts.dims → no dim_types (legacy shape untouched)', () => {
  let ann = A.blankAnnotation('s')
  ann = A.setOverall(ann, 'ok', 0)
  const row = A.projectJsonlRow(sampleEvents(), ann, { now: 0 })
  assert.equal(row['annotation-fields'].dim_types, undefined,
    'legacy exports do not carry dim_types — old consumers unaffected')
})

test('projectTripleRows(opts.dims): reward folds all three primitives to 0-1', () => {
  const dims = [
    { id: 'quality', type: 'continuous', min: 0, max: 10 },
    { id: 'verdict', type: 'categorical', values: ['bad', 'ok', 'good'] },
    { id: 'passes', type: 'boolean' },
  ]
  let ann = A.blankAnnotation('s')
  // Turn 0: 10/10 continuous + 'good' cat + true bool = (1 + 1 + 1) / 3 = 1
  ann = A.setTurnScore(ann, 0, {
    dims: { quality: 10, verdict: 'good', passes: true },
  }, 0, { dims })
  // Turn 1: 5/10 + 'ok' + false = (0.5 + 0.5 + 0) / 3 ≈ 0.333
  ann = A.setTurnScore(ann, 1, {
    dims: { quality: 5, verdict: 'ok', passes: false },
  }, 0, { dims })
  const rows = A.projectTripleRows(sampleEvents(), ann, 'sess-typed', { dims })
  assert.equal(rows[0].reward, 1)
  assert.equal(rows[1].reward, 0.333)
  // Turn 2 unscored → null reward.
  assert.equal(rows[2].reward, null)
})
