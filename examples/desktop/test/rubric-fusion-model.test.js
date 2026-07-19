// Rubric fusion model tests — pure derivations (recent scores, time series,
// rollout grid, similar-session detection).

'use strict'

// Load rubrics-model first — fusion-model depends on it via global fallback.
global.window = global.window || {}
if (!global.window.__dshRubricsModel) {
  global.window.__dshRubricsModel = require('../src/renderer/rubrics-model.js')
}

const test = require('node:test')
const assert = require('node:assert')

// require via a fresh module — the singleton in the fusion model would
// otherwise carry state across tests.
function freshStore() {
  delete require.cache[require.resolve('../src/renderer/rubric-fusion-model.js')]
  const api = require('../src/renderer/rubric-fusion-model.js')
  return api.create()
}

const SAMPLE_RUBRIC = {
  id: 'svg-gen',
  name: 'SVG generation',
  dims: [
    { id: 'shape', label: 'Shape', type: 'continuous', min: 0, max: 1 },
    { id: 'pass', label: 'Pass', type: 'boolean' },
    { id: 'quality', label: 'Quality', type: 'categorical', values: ['bad', 'ok', 'good'] },
  ],
}

test('registerRubric normalizes dims and returns a stable id', () => {
  const s = freshStore()
  const def = s.registerRubric(SAMPLE_RUBRIC)
  assert.equal(def.id, 'svg-gen')
  assert.equal(def.dims.length, 3)
  assert.equal(def.dims[0].type, 'continuous')
  assert.equal(def.dims[0].min, 0)
  assert.equal(def.dims[0].max, 1)
})

test('addEvent derives passed from dim spec', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  const hi = s.addEvent({ ts: 1000, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's1', turnId: 't1', score: 0.9 })
  const lo = s.addEvent({ ts: 2000, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's2', turnId: 't2', score: 0.2 })
  const boolT = s.addEvent({ ts: 3000, rubricId: 'svg-gen', dimId: 'pass', sessionId: 's3', turnId: 't3', score: true })
  const boolF = s.addEvent({ ts: 4000, rubricId: 'svg-gen', dimId: 'pass', sessionId: 's4', turnId: 't4', score: false })
  const catHi = s.addEvent({ ts: 5000, rubricId: 'svg-gen', dimId: 'quality', sessionId: 's5', turnId: 't5', score: 'good' })
  const catLo = s.addEvent({ ts: 6000, rubricId: 'svg-gen', dimId: 'quality', sessionId: 's6', turnId: 't6', score: 'bad' })
  assert.equal(hi.passed, true)
  assert.equal(lo.passed, false)
  assert.equal(boolT.passed, true)
  assert.equal(boolF.passed, false)
  assert.equal(catHi.passed, true)
  assert.equal(catLo.passed, false)
})

test('addEvent rejects unknown rubric or dim', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  assert.equal(s.addEvent({ rubricId: 'nope', dimId: 'shape', score: 0.5 }), null)
  assert.equal(s.addEvent({ rubricId: 'svg-gen', dimId: 'missing', score: 0.5 }), null)
})

test('recentScoresFor computes pass rate + per-dim breakdown', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  s.addEvent({ ts: 1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.9 })
  s.addEvent({ ts: 2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.9 })
  s.addEvent({ ts: 3, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.1 })
  s.addEvent({ ts: 4, rubricId: 'svg-gen', dimId: 'pass', sessionId: 's', turnId: 't', score: true })
  const r = s.recentScoresFor('svg-gen')
  assert.equal(r.total, 4)
  assert.equal(r.passRate, 0.75)  // 3 of 4 passed
  assert.equal(r.byDim.shape.n, 3)
  assert.equal(r.byDim.shape.passRate, Math.round((2 / 3) * 1000) / 1000)
  assert.equal(r.byDim.pass.n, 1)
  assert.equal(r.byDim.pass.passRate, 1)
  assert.equal(r.latest[0].ts, 4)
})

test('timeSeriesFor buckets by day and groups by dim', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  const t1 = new Date('2026-07-15T12:00:00Z').getTime()
  const t2 = new Date('2026-07-16T12:00:00Z').getTime()
  s.addEvent({ ts: t1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'a', turnId: 't', score: 0.5 })
  s.addEvent({ ts: t2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'b', turnId: 't', score: 0.9 })
  s.addEvent({ ts: t2, rubricId: 'svg-gen', dimId: 'pass', sessionId: 'b', turnId: 't', score: true })
  const ts = s.timeSeriesFor({ by: 'day', groupBy: 'dim' })
  assert.deepEqual(ts.xAxis, ['2026-07-15', '2026-07-16'])
  assert.equal(ts.series.length, 2)
  const shapeSeries = ts.series.find(x => x.key.endsWith('::shape'))
  assert.ok(shapeSeries, 'shape series present')
  assert.equal(shapeSeries.points.length, 2)
  assert.equal(shapeSeries.points[0].mean01, 0.5)
  assert.equal(shapeSeries.points[1].mean01, 0.9)
})

test('timeSeriesFor buckets by version', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  s.addEvent({ ts: 1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'a', turnId: 't', score: 0.3, harnessVersion: 'v0.9' })
  s.addEvent({ ts: 2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'b', turnId: 't', score: 0.7, harnessVersion: 'v0.10' })
  s.addEvent({ ts: 3, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'c', turnId: 't', score: 0.9, harnessVersion: 'v0.11' })
  const ts = s.timeSeriesFor({ by: 'version', groupBy: 'dim' })
  assert.deepEqual(ts.xAxis, ['v0.10', 'v0.11', 'v0.9'])  // sorted
})

test('rolloutGridFor produces one cell per (dim, rollout)', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  s.addEvent({ ts: 1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', rolloutIdx: 1, score: 0.9 })
  s.addEvent({ ts: 2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', rolloutIdx: 2, score: 0.3 })
  s.addEvent({ ts: 3, rubricId: 'svg-gen', dimId: 'pass', sessionId: 's', turnId: 't', rolloutIdx: 1, score: true })
  s.addEvent({ ts: 4, rubricId: 'svg-gen', dimId: 'pass', sessionId: 's', turnId: 't', rolloutIdx: 2, score: false })
  const grid = s.rolloutGridFor('svg-gen', 's')
  assert.equal(grid.rubric.id, 'svg-gen')
  assert.deepEqual(grid.rollouts, [1, 2])
  assert.equal(grid.dims.length, 3)
  const cellR1Shape = grid.cells.find(c => c.dimId === 'shape' && c.rolloutIdx === 1)
  assert.equal(cellR1Shape.passed, true)
  const cellR2Shape = grid.cells.find(c => c.dimId === 'shape' && c.rolloutIdx === 2)
  assert.equal(cellR2Shape.passed, false)
})

test('detectSimilarSessions filters by minCount', () => {
  const s = freshStore()
  s.loadFixture({
    rubrics: [SAMPLE_RUBRIC],
    events: [],
    similarClasses: [
      { id: 'a', signature: 'sig-a', count: 5, sessionIds: [], promptSummary: 'a' },
      { id: 'b', signature: 'sig-b', count: 2, sessionIds: [], promptSummary: 'b' },
    ],
  })
  const withDefault = s.detectSimilarSessions()
  assert.equal(withDefault.length, 1)
  assert.equal(withDefault[0].id, 'a')
  const relaxed = s.detectSimilarSessions({ minCount: 1 })
  assert.equal(relaxed.length, 2)
})

test('subscribe fires on every mutation', () => {
  const s = freshStore()
  let fires = 0
  const unsub = s.subscribe(() => { fires++ })
  s.registerRubric(SAMPLE_RUBRIC)
  s.addEvent({ ts: 1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.5 })
  unsub()
  s.addEvent({ ts: 2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.7 })
  assert.equal(fires, 2)  // register + first add; second add is after unsub
})

test('loadFixture returns counts', () => {
  const s = freshStore()
  const res = s.loadFixture({
    rubrics: [SAMPLE_RUBRIC],
    events: [
      { rubricId: 'svg-gen', dimId: 'shape', sessionId: 's', turnId: 't', score: 0.5 },
      { rubricId: 'nope', dimId: 'x', score: 0 },
    ],
    similarClasses: [],
  })
  assert.equal(res.rubrics, 1)
  assert.equal(res.events, 1)
})

test('timeSeriesFor filter chip: harnessVersion', () => {
  const s = freshStore()
  s.registerRubric(SAMPLE_RUBRIC)
  s.addEvent({ ts: 1, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'a', turnId: 't', score: 0.3, harnessVersion: 'v0.9' })
  s.addEvent({ ts: 2, rubricId: 'svg-gen', dimId: 'shape', sessionId: 'b', turnId: 't', score: 0.9, harnessVersion: 'v0.11' })
  const ts = s.timeSeriesFor({ by: 'day', groupBy: 'dim', filter: { harnessVersion: 'v0.11' } })
  const shape = ts.series.find(x => x.key.endsWith('::shape'))
  assert.ok(shape)
  assert.equal(shape.points.length, 1)
  assert.equal(shape.points[0].mean01, 0.9)
})
