// Pure unit tests for bench-model.js — the researcher experiment platform
// data model. No DOM, no Electron. Runs under `node --test`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function loadModule() {
  const p = require.resolve('../src/renderer/bench-model.js')
  delete require.cache[p]
  return require('../src/renderer/bench-model.js')
}

// ---------------------------------------------------------------------------
// passAtK — standard HumanEval formula
// ---------------------------------------------------------------------------

test('passAtK: c=0 gives 0 regardless of k', () => {
  const { passAtK } = loadModule()
  assert.equal(passAtK(0, 5, 1), 0)
  assert.equal(passAtK(0, 5, 3), 0)
  assert.equal(passAtK(0, 5, 5), 0)
})

test('passAtK: c=n gives 1', () => {
  const { passAtK } = loadModule()
  assert.equal(passAtK(3, 3, 3), 1)
  assert.equal(passAtK(5, 5, 1), 1)
})

test('passAtK: k >= n reduces to any-of', () => {
  const { passAtK } = loadModule()
  assert.equal(passAtK(1, 3, 5), 1)
  assert.equal(passAtK(0, 3, 5), 0)
})

test('passAtK: HumanEval known value — c=1 n=3 k=1 == 1/3', () => {
  const { passAtK } = loadModule()
  const v = passAtK(1, 3, 1)
  assert.ok(Math.abs(v - (1 / 3)) < 1e-9, `expected 1/3, got ${v}`)
})

test('passAtK: c=2 n=5 k=3 == 1 - C(3,3)/C(5,3) = 1 - 1/10 = 0.9', () => {
  const { passAtK } = loadModule()
  const v = passAtK(2, 5, 3)
  assert.ok(Math.abs(v - 0.9) < 1e-9, `expected 0.9, got ${v}`)
})

test('passAtK: n=0 gives 0', () => {
  const { passAtK } = loadModule()
  assert.equal(passAtK(0, 0, 1), 0)
})

// ---------------------------------------------------------------------------
// quantileBucket — 25/75 tri-state
// ---------------------------------------------------------------------------

test('quantileBucket: latency-shape maps fast quartile → "fast"', () => {
  const { quantileBucket } = loadModule()
  const vs = [10, 20, 30, 40, 50, 60, 70, 80]
  assert.equal(quantileBucket(vs, 5), 'fast')
  assert.equal(quantileBucket(vs, 45), 'normal')
  assert.equal(quantileBucket(vs, 90), 'slow')
})

test('quantileBucket: reversed=true (score-shape) maps top quartile → "fast"', () => {
  const { quantileBucket } = loadModule()
  const vs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
  assert.equal(quantileBucket(vs, 0.9, true), 'fast')
  assert.equal(quantileBucket(vs, 0.45, true), 'normal')
  assert.equal(quantileBucket(vs, 0.05, true), 'slow')
})

test('quantileBucket: fewer than 3 samples → "neutral"', () => {
  const { quantileBucket } = loadModule()
  assert.equal(quantileBucket([1, 2], 1), 'neutral')
  assert.equal(quantileBucket([], 1), 'neutral')
})

// ---------------------------------------------------------------------------
// loadExperiments + projectL0Rows — kind badges, filter, latency tint
// ---------------------------------------------------------------------------

test('loadExperiments: order + kind normalisation across a mixed batch', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [
      { id: 'e1', name: 'matrix-one',  kind: 'matrix', matrix: { prompts: [], models: [], cells: {} } },
      { id: 'e2', name: 'ab-one',      kind: 'A/B',    ab:     { rows: [], variantA: { label: 'A' }, variantB: { label: 'B' } } },
      { id: 'e3', name: 'rep-one',     kind: 'repetition', rep: { input: 'x', dims: [], repetitions: [] } },
    ],
  })
  assert.deepEqual(state.order, ['e1', 'e2', 'e3'])
  assert.equal(state.experiments.get('e1').kind, 'matrix')
  assert.equal(state.experiments.get('e2').kind, 'ab')
  assert.equal(state.experiments.get('e3').kind, 'rep')
})

test('projectL0Rows: subTab filter narrows to one kind', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [
      { id: 'e1', kind: 'matrix', matrix: { prompts: [], models: [], cells: {} } },
      { id: 'e2', kind: 'ab',     ab: { rows: [] } },
      { id: 'e3', kind: 'rep',    rep: { repetitions: [] } },
    ],
  })
  assert.equal(M.projectL0Rows(state, { subTab: 'all' }).length, 3)
  assert.equal(M.projectL0Rows(state, { subTab: 'matrix' }).length, 1)
  assert.equal(M.projectL0Rows(state, { subTab: 'ab' }).length, 1)
  assert.equal(M.projectL0Rows(state, { subTab: 'rep' }).length, 1)
})

test('projectL0Rows: computes p50Bucket over surviving rows only', () => {
  const M = loadModule()
  const state = M.createBenchState()
  // Fake three matrix experiments with different p50 latencies.
  const mk = (id, lat) => ({
    id, kind: 'matrix', N: 1,
    matrix: {
      prompts: [{ id: 'p1' }],
      models: [{ id: 'm1' }],
      cells: {
        'p1|m1': {
          promptId: 'p1', modelId: 'm1', resolvedCount: 1, N: 1, status: 'ok', score: 0.8,
          runs: [{ resolved: true, score: 0.8, latencyMs: lat }],
        },
      },
    },
  })
  M.loadExperiments(state, {
    experiments: [
      mk('slow', 5000), mk('normal', 2000), mk('fast', 500),
      mk('slow2', 4800), mk('normal2', 2500), mk('fast2', 600),
    ],
  })
  const rows = M.projectL0Rows(state, { subTab: 'all' })
  const bucketOf = (id) => rows.find(r => r.id === id).summary.p50Bucket
  assert.equal(bucketOf('fast'), 'fast')
  assert.equal(bucketOf('slow'), 'slow')
})

// ---------------------------------------------------------------------------
// projectMatrixGrid — DSBench cell shape + column totals + tint
// ---------------------------------------------------------------------------

test('projectMatrixGrid: rows × cols with cells in DSBench shape', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'matrix', N: 3,
      matrix: {
        prompts: [{ id: 'p1', label: 'prompt-01' }, { id: 'p2', label: 'prompt-02' }],
        models:  [{ id: 'ma', label: 'model-A' }, { id: 'mb', label: 'model-B' }],
        cells: {
          'p1|ma': { promptId: 'p1', modelId: 'ma', resolvedCount: 3, N: 3, status: 'ok',
                     score: 0.87, latencyMs: 1500, cost: 0.02,
                     runs: [
                       { resolved: true, score: 0.90, latencyMs: 1400, cost: 0.006 },
                       { resolved: true, score: 0.85, latencyMs: 1500, cost: 0.007 },
                       { resolved: true, score: 0.86, latencyMs: 1600, cost: 0.007 },
                     ] },
          'p1|mb': { promptId: 'p1', modelId: 'mb', resolvedCount: 2, N: 3, status: 'ok',
                     score: 0.62, latencyMs: 2100, cost: 0.04,
                     runs: [
                       { resolved: true,  score: 0.70, latencyMs: 2000, cost: 0.013 },
                       { resolved: true,  score: 0.65, latencyMs: 2100, cost: 0.013 },
                       { resolved: false, score: 0.50, latencyMs: 2200, cost: 0.014 },
                     ] },
          'p2|ma': { promptId: 'p2', modelId: 'ma', resolvedCount: 3, N: 3, status: 'ok',
                     score: 0.91, latencyMs: 1700, cost: 0.02,
                     runs: [
                       { resolved: true, score: 0.91, latencyMs: 1700, cost: 0.007 },
                       { resolved: true, score: 0.90, latencyMs: 1700, cost: 0.007 },
                       { resolved: true, score: 0.92, latencyMs: 1800, cost: 0.007 },
                     ] },
          'p2|mb': { promptId: 'p2', modelId: 'mb', resolvedCount: 3, N: 3, status: 'ok',
                     score: 0.85, latencyMs: 2000, cost: 0.04,
                     runs: [
                       { resolved: true, score: 0.85, latencyMs: 2000, cost: 0.013 },
                       { resolved: true, score: 0.85, latencyMs: 2000, cost: 0.013 },
                       { resolved: true, score: 0.85, latencyMs: 2000, cost: 0.014 },
                     ] },
        },
      },
    }],
  })
  const exp = M.getExperiment(state, 'e')
  const grid = M.projectMatrixGrid(exp)
  assert.equal(grid.prompts.length, 2)
  assert.equal(grid.models.length, 2)
  assert.equal(grid.rows.length, 2)
  assert.equal(grid.rows[0].cells.length, 2)
  const cellA = grid.rows[0].cells[0]
  assert.equal(cellA.resolvedCount, 3)
  assert.equal(cellA.N, 3)
  // Column totals: model-A perfect on both prompts → pass@3 = 1
  const totalA = grid.totals.find(t => t.model.id === 'ma')
  assert.equal(totalA.passAtK, 1, 'model-A pass@3 must be 1')
  const totalB = grid.totals.find(t => t.model.id === 'mb')
  // model-B: pass@3(2,3) = 1 - C(1,3)/C(3,3); C(1,3)=0 → 1; and pass@3(3,3) = 1. Both 1.
  // Mean is 1. Good — the aggregation is honest.
  assert.equal(totalB.passAtK, 1)
})

test('projectMatrixGrid: score tint reverses (high score → fast)', () => {
  const M = loadModule()
  const state = M.createBenchState()
  // Build enough varying-score cells that the quartile edges are meaningful.
  const cells = {}
  const scores = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]
  const prompts = scores.map((_, i) => ({ id: `p${i}`, label: `prompt-${i}` }))
  const models = [{ id: 'm', label: 'model' }]
  scores.forEach((sc, i) => {
    cells[`p${i}|m`] = {
      promptId: `p${i}`, modelId: 'm', resolvedCount: 1, N: 1, status: 'ok', score: sc,
      runs: [{ resolved: true, score: sc, latencyMs: 1000 }],
    }
  })
  M.loadExperiments(state, { experiments: [{ id: 'e', kind: 'matrix', matrix: { prompts, models, cells } }] })
  const grid = M.projectMatrixGrid(M.getExperiment(state, 'e'))
  const topCell = grid.rows.find(r => r.prompt.id === 'p9').cells[0]
  const botCell = grid.rows.find(r => r.prompt.id === 'p0').cells[0]
  assert.equal(topCell.tintBucket, 'fast', 'high score should tint fast/green')
  assert.equal(botCell.tintBucket, 'slow', 'low score should tint slow')
})

// ---------------------------------------------------------------------------
// projectABTable — delta direction with |Δ|<0.02 threshold
// ---------------------------------------------------------------------------

test('projectABTable: |Δ| < 0.02 → flat; else up/down', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'ab',
      ab: {
        variantA: { label: 'v2' }, variantB: { label: 'v1' },
        rows: [
          { promptId: 'p1', a: { resolved: true,  score: 0.87 }, b: { resolved: true, score: 0.79 } },
          { promptId: 'p2', a: { resolved: true,  score: 0.91 }, b: { resolved: true, score: 0.90 } },
          { promptId: 'p3', a: { resolved: false, score: 0.32 }, b: { resolved: true, score: 0.68 } },
        ],
      },
    }],
  })
  const rows = M.projectABTable(M.getExperiment(state, 'e'))
  assert.equal(rows[0].direction, 'up')
  assert.equal(rows[1].direction, 'flat', '|0.01| below threshold should be flat')
  assert.equal(rows[2].direction, 'down')
})

test('projectABTable: derives delta summary on the experiment', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'ab',
      ab: {
        variantA: { label: 'A' }, variantB: { label: 'B' },
        rows: [
          { promptId: 'p1', a: { resolved: true, score: 1.0 }, b: { resolved: false, score: 0.0 } },
          { promptId: 'p2', a: { resolved: true, score: 1.0 }, b: { resolved: false, score: 0.0 } },
        ],
      },
    }],
  })
  const exp = M.getExperiment(state, 'e')
  assert.equal(exp.summary.dPassRate, 1)
  assert.equal(exp.summary.dScore, 1)
})

// ---------------------------------------------------------------------------
// projectRepetitionTable — reference tracing UI Average|1..N shape
// ---------------------------------------------------------------------------

test('projectRepetitionTable: headers 1..N, dims average correctly', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'rep', N: 5,
      rep: {
        input: 'parse-jsonc-edge-cases',
        dims: [
          { id: 'code_correctness', label: 'code_correctness', kind: 'score' },
          { id: 'passes_tests',     label: 'passes_tests',     kind: 'boolean' },
          { id: 'latency',          label: 'latency',          kind: 'latency' },
        ],
        repetitions: [
          { idx: 1, resolved: false, score: 0.62, latencyMs: 1400, dimensions: { code_correctness: 0.62, passes_tests: false, latency: 1400 } },
          { idx: 2, resolved: true,  score: 0.85, latencyMs:  900, dimensions: { code_correctness: 0.85, passes_tests: true,  latency:  900 } },
          { idx: 3, resolved: true,  score: 0.79, latencyMs: 1100, dimensions: { code_correctness: 0.79, passes_tests: true,  latency: 1100 } },
          { idx: 4, resolved: true,  score: 0.91, latencyMs: 1300, dimensions: { code_correctness: 0.91, passes_tests: true,  latency: 1300 } },
          { idx: 5, resolved: true,  score: 0.72, latencyMs: 1200, dimensions: { code_correctness: 0.72, passes_tests: true,  latency: 1200 } },
        ],
      },
    }],
  })
  const tbl = M.projectRepetitionTable(M.getExperiment(state, 'e'))
  assert.deepEqual(tbl.headers, ['1', '2', '3', '4', '5'])
  const dCorr = tbl.dims.find(d => d.id === 'code_correctness')
  assert.equal(dCorr.average, '0.78') // mean(0.62,0.85,0.79,0.91,0.72) = 0.778 → 0.78
  const dPass = tbl.dims.find(d => d.id === 'passes_tests')
  assert.equal(dPass.average, '4/5')
  const dLat = tbl.dims.find(d => d.id === 'latency')
  assert.equal(dLat.average, '1.2s') // mean = 1180ms → 1.2s
  assert.equal(tbl.list.length, 5)
  assert.equal(tbl.list[1].resolved, true)
})

test('deriveRepSummary: sigma across N=5 matches manual', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'rep',
      rep: {
        input: '', dims: [],
        repetitions: [
          { score: 0.62, latencyMs: 1400, resolved: false },
          { score: 0.85, latencyMs:  900, resolved: true },
          { score: 0.79, latencyMs: 1100, resolved: true },
          { score: 0.91, latencyMs: 1300, resolved: true },
          { score: 0.72, latencyMs: 1200, resolved: true },
        ],
      },
    }],
  })
  const exp = M.getExperiment(state, 'e')
  assert.ok(Math.abs(exp.summary.sigma - 0.11) < 0.005,
    `sigma expected ~0.11, got ${exp.summary.sigma}`)
  assert.equal(exp.summary.min, 0.62)
  assert.equal(exp.summary.max, 0.91)
})

// ---------------------------------------------------------------------------
// projectChartStrip — per-kind chart shape sanity
// ---------------------------------------------------------------------------

test('projectChartStrip: matrix yields per-model feedback bars', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'matrix',
      matrix: {
        prompts: [{ id: 'p1' }],
        models:  [{ id: 'ma', label: 'model-A' }, { id: 'mb', label: 'model-B' }],
        cells: {
          'p1|ma': { promptId: 'p1', modelId: 'ma', resolvedCount: 3, N: 3, status: 'ok', score: 0.9,
                     runs: [{ resolved: true, score: 0.9, latencyMs: 1200, tokens: { in: 1000, out: 400 } }] },
          'p1|mb': { promptId: 'p1', modelId: 'mb', resolvedCount: 1, N: 3, status: 'fail', score: 0.4,
                     runs: [{ resolved: false, score: 0.4, latencyMs: 2200, tokens: { in: 1100, out: 500 } }] },
        },
      },
    }],
  })
  const charts = M.projectChartStrip(M.getExperiment(state, 'e'))
  assert.equal(charts.feedback.length, 2)
  assert.equal(charts.feedback[0].key, 'ma')
  assert.equal(charts.latency.length, 2)
  assert.equal(charts.tokens.length, 2)
})

test('projectChartStrip: ab yields two-series bars', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'ab',
      ab: {
        variantA: { label: 'v2' }, variantB: { label: 'v1' },
        rows: [
          { promptId: 'p1', a: { resolved: true, score: 0.9, latencyMs: 1000, tokens: { in: 500, out: 200 } },
                            b: { resolved: true, score: 0.8, latencyMs: 1200, tokens: { in: 550, out: 220 } } },
        ],
      },
    }],
  })
  const charts = M.projectChartStrip(M.getExperiment(state, 'e'))
  assert.equal(charts.feedback.length, 2)
  assert.equal(charts.feedback[0].key, 'a')
  assert.equal(charts.feedback[1].key, 'b')
})

test('projectChartStrip: rep yields histogram + boxplot + resolvedStack', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.loadExperiments(state, {
    experiments: [{
      id: 'e', kind: 'rep',
      rep: {
        input: '', dims: [],
        repetitions: [
          { score: 0.62, latencyMs: 1400, resolved: false },
          { score: 0.85, latencyMs:  900, resolved: true },
          { score: 0.79, latencyMs: 1100, resolved: true },
        ],
      },
    }],
  })
  const charts = M.projectChartStrip(M.getExperiment(state, 'e'))
  assert.equal(charts.histogram.length, 5)
  assert.ok(charts.boxplot && Number.isFinite(charts.boxplot.median))
  assert.deepEqual(charts.resolvedStack, { resolved: 2, unresolved: 1 })
})

// ---------------------------------------------------------------------------
// makeCodeResult — DSBenchV2 escalation-path contract
// ---------------------------------------------------------------------------

test('makeCodeResult: emits {resolved, score, reason} bit-identical to DSBench', () => {
  const M = loadModule()
  const cr = M.makeCodeResult({ resolved: true, score: 0.87, reason: 'passes' })
  assert.deepEqual(cr, { resolved: true, score: 0.87, reason: 'passes' })
  assert.deepEqual(M.makeCodeResult({}), { resolved: false, score: 0, reason: '' })
})

// ---------------------------------------------------------------------------
// selection + subtab plumbing
// ---------------------------------------------------------------------------

test('setSubTab: rejects unknown values', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.setSubTab(state, 'garbage')
  assert.equal(state.subTab, 'all')
  M.setSubTab(state, 'matrix')
  assert.equal(state.subTab, 'matrix')
})

test('selectExperiment: sets state.selectedId', () => {
  const M = loadModule()
  const state = M.createBenchState()
  M.selectExperiment(state, 'e42')
  assert.equal(state.selectedId, 'e42')
})
