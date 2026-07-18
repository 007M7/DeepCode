// Pure data model for the Bench page — the researcher experiment platform
// described in docs/design-refs/bench-design-pack-160.md. Three kinds share
// the same L0 experiments-list shape and specialise their L1 detail views:
//
//   Kind A — Matrix           (model × prompt-set × N grid, pass@k / avg score)
//   Kind B — Plugin A/B       (same prompt-set × N × 2 plugin variants, Δ)
//   Kind C — Repetition       (one input × N, variance across N)
//
// This module is framework-free and side-effect-free so the smoke test and
// `node --test` suites can exercise the same reducers/projectors the DOM
// controller does. No DOM, no protocol, no timers.
//
// Public surface (see the pack § "one-pager per kind" for column shapes):
//   loadExperiments(state, batch)   — seed / swap experiment records
//   projectL0Rows(state, filter?)   — the experiments-table rows (L0)
//   projectMatrixGrid(exp)          — Kind A grid cells + column totals
//   projectABTable(exp)             — Kind B per-prompt Δ rows
//   projectRepetitionTable(exp)     — Kind C Average|1..N metric rows
//   projectChartStrip(exp)          — three summary charts, per kind
//   passAtK(c, n, k)                — pass@k = 1 - C(n-c,k)/C(n,k) (any-of-first-k
//                                     variant documented in the pack §4)
//   quantileBucket(vs, v)           — 'fast'|'normal'|'slow' by 25/75 quantile
//   makeCodeResult(cell)            — DSBenchV2 {resolved,score,reason} per cell
//
// The reducer is deliberately loader-shaped rather than event-driven: Bench
// today is fed by fixture batches (demo tier, mock-first — see task §187 note
// "G18/G19 pending"). Once `bench/list-experiments` (G19) lands upstream we
// can layer an event applier on top of the same state shape without changing
// projections.

'use strict'

// ---------------------------------------------------------------------------
// state shape
// ---------------------------------------------------------------------------

/**
 * Build an empty bench-model state. The controller keeps one instance for the
 * life of the pane.
 *
 *   experiments  Map<id, Experiment>   the loaded batch of experiment records.
 *   order        string[]              display order (server-authoritative when
 *                                      G19 lands; today it's the loader order).
 *   selectedId   string | null         the L1-drilled experiment id, or null.
 *   subTab       'all'|'matrix'|'ab'|'rep'   filter chip (§Option C).
 *
 * Experiment records mirror the {resolved,score,reason} contract from
 * dsbench-v2-reference.md and add the three-kind-specific detail payloads:
 *
 *   { id, name, kind: 'matrix'|'ab'|'rep', status, progress: {done, total},
 *     createdAt, models, promptSet, N, config,
 *     summary: { passRate, aveScore, passAtK, totalCost, p50, p99, errCount },
 *     matrix?: { prompts:[…], models:[…], cells: {"prompt|model": Cell} },
 *     ab?:     { variantA, variantB, rows: […], delta: {…} },
 *     rep?:    { input, dims: […], repetitions: […], stats: {…} } }
 *
 * Cell shape (matrix):
 *   { promptId, modelId, resolvedCount, N, status,
 *     score, latencyMs, tokens: {in, out, cache?}, cost, runs: [ … ] }
 * A run is one rollout: { runIdx, resolved, score, reason, latencyMs, tokens, cost }.
 */
function createBenchState() {
  return {
    experiments: new Map(),
    order: [],
    selectedId: null,
    subTab: 'all',
  }
}

// ---------------------------------------------------------------------------
// loaders (fixture-driven; G19 will replace with a wire applier)
// ---------------------------------------------------------------------------

/**
 * Replace the experiment catalogue with a batch. Loader-shaped: the demo tier
 * calls this once per fixture load. Idempotent — calling twice with the same
 * batch produces the same state.
 *
 * Returns state (mutated in place) so callers can chain.
 */
function loadExperiments(state, batch) {
  if (!batch || !Array.isArray(batch.experiments)) return state
  state.experiments.clear()
  state.order = []
  for (const raw of batch.experiments) {
    if (!raw || typeof raw.id !== 'string') continue
    const exp = normalizeExperiment(raw)
    state.experiments.set(exp.id, exp)
    state.order.push(exp.id)
  }
  return state
}

/**
 * Fill in derived summary fields on an experiment record (pass@k, aveScore, …).
 * Idempotent; the pack asks for authoritative numbers so we recompute rather
 * than trust whatever the fixture wrote.
 */
function normalizeExperiment(raw) {
  const kind = normaliseKind(raw.kind)
  const exp = {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    kind,
    status: raw.status || 'done',
    progress: { done: 0, total: 0, ...(raw.progress || {}) },
    createdAt: Number(raw.createdAt || 0),
    models: Array.isArray(raw.models) ? raw.models.slice() : [],
    promptSet: raw.promptSet || null,
    N: Number(raw.N || 0),
    config: raw.config || null,
    summary: null,
    matrix: null,
    ab: null,
    rep: null,
  }
  if (kind === 'matrix' && raw.matrix) exp.matrix = normaliseMatrix(raw.matrix)
  if (kind === 'ab' && raw.ab) exp.ab = normaliseAB(raw.ab)
  if (kind === 'rep' && raw.rep) exp.rep = normaliseRep(raw.rep)
  exp.summary = deriveSummary(exp)
  return exp
}

function normaliseKind(k) {
  const s = String(k || '').toLowerCase()
  if (s === 'matrix' || s === 'a') return 'matrix'
  if (s === 'ab' || s === 'a/b' || s === 'plugin-ab' || s === 'b') return 'ab'
  if (s === 'rep' || s === 'repetition' || s === 'c') return 'rep'
  return 'matrix'
}

function normaliseMatrix(m) {
  const prompts = Array.isArray(m.prompts) ? m.prompts.slice() : []
  const models = Array.isArray(m.models) ? m.models.slice() : []
  const cells = {}
  if (m.cells && typeof m.cells === 'object') {
    for (const key of Object.keys(m.cells)) {
      const c = m.cells[key] || {}
      const runs = Array.isArray(c.runs) ? c.runs.slice() : []
      const N = Number(c.N || runs.length || 0)
      const resolvedCount = Number.isFinite(c.resolvedCount)
        ? Number(c.resolvedCount)
        : runs.filter(r => r && r.resolved).length
      const scores = runs.filter(r => r && Number.isFinite(r.score)).map(r => r.score)
      const score = Number.isFinite(c.score)
        ? Number(c.score)
        : (scores.length ? mean(scores) : 0)
      cells[key] = {
        promptId: c.promptId || key.split('|')[0],
        modelId: c.modelId || key.split('|')[1],
        resolvedCount,
        N,
        status: c.status || (N === 0 ? 'queued' : (resolvedCount > 0 ? 'ok' : 'fail')),
        score,
        latencyMs: Number.isFinite(c.latencyMs) ? c.latencyMs : null,
        tokens: c.tokens || null,
        cost: Number.isFinite(c.cost) ? c.cost : null,
        runs,
      }
    }
  }
  return { prompts, models, cells }
}

function normaliseAB(ab) {
  const rows = Array.isArray(ab.rows) ? ab.rows.map(r => ({
    promptId: r.promptId,
    a: r.a || { resolved: false, score: 0 },
    b: r.b || { resolved: false, score: 0 },
  })) : []
  return {
    variantA: ab.variantA || { label: 'A' },
    variantB: ab.variantB || { label: 'B' },
    rows,
    delta: null, // derived
  }
}

function normaliseRep(rep) {
  const repetitions = Array.isArray(rep.repetitions) ? rep.repetitions.slice() : []
  const dims = Array.isArray(rep.dims) ? rep.dims.slice() : []
  return {
    input: rep.input || '',
    dims,
    repetitions,
    stats: null, // derived
  }
}

// ---------------------------------------------------------------------------
// summary derivation
// ---------------------------------------------------------------------------

function deriveSummary(exp) {
  if (exp.kind === 'matrix') return deriveMatrixSummary(exp)
  if (exp.kind === 'ab') return deriveABSummary(exp)
  if (exp.kind === 'rep') return deriveRepSummary(exp)
  return null
}

function deriveMatrixSummary(exp) {
  const m = exp.matrix
  if (!m) return emptySummary()
  const cells = Object.values(m.cells || {})
  let done = 0
  let totalRuns = 0
  let resolvedRuns = 0
  const scores = []
  const lats = []
  const costs = []
  let errCount = 0
  for (const c of cells) {
    totalRuns += c.N
    resolvedRuns += c.resolvedCount
    if (c.status !== 'queued' && c.status !== 'running') done += c.N
    if (c.status === 'error') errCount += 1
    for (const r of c.runs) {
      if (Number.isFinite(r.score)) scores.push(r.score)
      if (Number.isFinite(r.latencyMs)) lats.push(r.latencyMs)
      if (Number.isFinite(r.cost)) costs.push(r.cost)
    }
  }
  const passRate = totalRuns > 0 ? resolvedRuns / totalRuns : 0
  // Per-cell pass@k, aggregated as mean-of-cells. This mirrors DSBenchV2's
  // "pass@k row totaled per model", but here we roll up to a single scalar
  // for the L0 row. The per-model column-total lives on the grid projection.
  const kUsed = Math.min(3, exp.N || 3)
  const cellPassAtK = cells.map(c => passAtK(c.resolvedCount, c.N, kUsed))
  const aggregatePassAtK = cellPassAtK.length ? mean(cellPassAtK) : 0
  const totalCost = costs.reduce((a, b) => a + b, 0)
  return {
    passRate,
    aveScore: scores.length ? mean(scores) : 0,
    passAtK: aggregatePassAtK,
    kUsed,
    totalCost,
    p50: percentile(lats, 50),
    p99: percentile(lats, 99),
    errCount,
    doneRuns: exp.progress.done || done,
    totalRuns: exp.progress.total || totalRuns,
  }
}

function deriveABSummary(exp) {
  const rows = exp.ab ? exp.ab.rows : []
  if (!rows.length) return emptySummary()
  let aPass = 0, bPass = 0, aScore = 0, bScore = 0
  for (const r of rows) {
    if (r.a.resolved) aPass += 1
    if (r.b.resolved) bPass += 1
    aScore += Number(r.a.score || 0)
    bScore += Number(r.b.score || 0)
  }
  const aPassRate = aPass / rows.length
  const bPassRate = bPass / rows.length
  const aScoreAvg = aScore / rows.length
  const bScoreAvg = bScore / rows.length
  const delta = {
    dPassRate: aPassRate - bPassRate,
    dScore: aScoreAvg - bScoreAvg,
    // dCost / dLatency are optional on the fixture; use undefined so the
    // renderer can omit them cleanly rather than showing 0.
  }
  exp.ab.delta = delta
  return {
    aPassRate, bPassRate,
    aScoreAvg, bScoreAvg,
    dPassRate: delta.dPassRate,
    dScore: delta.dScore,
    doneRuns: exp.progress.done || (rows.length * 2),
    totalRuns: exp.progress.total || (rows.length * 2),
  }
}

function deriveRepSummary(exp) {
  const r = exp.rep
  if (!r) return emptySummary()
  const reps = r.repetitions
  const scores = reps.map(x => Number(x.score || 0))
  const lats = reps.map(x => Number(x.latencyMs || 0)).filter(Number.isFinite)
  const resolvedCount = reps.filter(x => x.resolved).length
  const stats = {
    N: reps.length,
    sigma: stdev(scores),
    min: scores.length ? Math.min(...scores) : 0,
    max: scores.length ? Math.max(...scores) : 0,
    median: percentile(scores, 50),
    aveScore: scores.length ? mean(scores) : 0,
    resolvedCount,
    latencyBox: boxplot(lats),
    scoreHist: histogram(scores, 5, 0, 1),
  }
  r.stats = stats
  return {
    N: reps.length,
    sigma: stats.sigma,
    min: stats.min,
    max: stats.max,
    median: stats.median,
    aveScore: stats.aveScore,
    resolvedRate: reps.length ? resolvedCount / reps.length : 0,
    doneRuns: exp.progress.done || reps.length,
    totalRuns: exp.progress.total || reps.length,
  }
}

function emptySummary() {
  return { passRate: 0, aveScore: 0, passAtK: 0, kUsed: 0, totalCost: 0, p50: null, p99: null, errCount: 0, doneRuns: 0, totalRuns: 0 }
}

// ---------------------------------------------------------------------------
// projections — L0 rows
// ---------------------------------------------------------------------------

/**
 * Project the state to L0 rows for the experiments table. Applies the current
 * subTab filter and re-computes latency quantile buckets over the surviving
 * rows (pack §5.4: "distribution is re-computed whenever the list filter
 * changes so the tint stays meaningful").
 */
function projectL0Rows(state, opts) {
  const filter = (opts && opts.subTab) || state.subTab || 'all'
  const rows = []
  for (const id of state.order) {
    const exp = state.experiments.get(id)
    if (!exp) continue
    if (filter !== 'all') {
      if (filter === 'matrix' && exp.kind !== 'matrix') continue
      if (filter === 'ab' && exp.kind !== 'ab') continue
      if (filter === 'rep' && exp.kind !== 'rep') continue
    }
    rows.push({
      id: exp.id,
      name: exp.name,
      kind: exp.kind,
      status: exp.status,
      progress: exp.progress,
      summary: exp.summary,
      createdAt: exp.createdAt,
    })
  }
  // Compute panel-quantile latency buckets for tint.
  const p50s = rows.map(r => r.summary && r.summary.p50).filter(Number.isFinite)
  const quart = quantileEdges(p50s)
  for (const r of rows) {
    if (r.summary && Number.isFinite(r.summary.p50)) {
      r.summary.p50Bucket = quantileBucketFromEdges(r.summary.p50, quart)
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// projections — L1 charts strip
// ---------------------------------------------------------------------------

/**
 * Per-kind three-chart strip. Returns a data shape the DOM renders as SVG.
 *
 * Matrix:   per-model bars (Feedback = passRate/aveScore, Latency = P50/P99,
 *           Tokens = in/out).
 * A/B:      two-series bars (variantA vs variantB) for Feedback/Latency/Tokens.
 * Rep:      score histogram + latency box-plot + resolved/unresolved stack.
 */
function projectChartStrip(exp) {
  if (!exp) return null
  if (exp.kind === 'matrix') return matrixCharts(exp)
  if (exp.kind === 'ab') return abCharts(exp)
  if (exp.kind === 'rep') return repCharts(exp)
  return null
}

function matrixCharts(exp) {
  const m = exp.matrix
  if (!m) return { feedback: [], latency: [], tokens: [] }
  const perModel = {}
  for (const model of m.models) perModel[model.id] = { scores: [], resolved: 0, N: 0, lats: [], tokIn: 0, tokOut: 0 }
  for (const key of Object.keys(m.cells)) {
    const c = m.cells[key]
    const bucket = perModel[c.modelId]
    if (!bucket) continue
    bucket.N += c.N
    bucket.resolved += c.resolvedCount
    for (const r of c.runs) {
      if (Number.isFinite(r.score)) bucket.scores.push(r.score)
      if (Number.isFinite(r.latencyMs)) bucket.lats.push(r.latencyMs)
      if (r.tokens && Number.isFinite(r.tokens.in)) bucket.tokIn += r.tokens.in
      if (r.tokens && Number.isFinite(r.tokens.out)) bucket.tokOut += r.tokens.out
    }
  }
  const feedback = []
  const latency = []
  const tokens = []
  for (const model of m.models) {
    const b = perModel[model.id]
    feedback.push({
      key: model.id,
      label: model.label || model.id,
      passRate: b.N ? b.resolved / b.N : 0,
      aveScore: b.scores.length ? mean(b.scores) : 0,
    })
    latency.push({
      key: model.id,
      label: model.label || model.id,
      p50: percentile(b.lats, 50),
      p99: percentile(b.lats, 99),
    })
    tokens.push({
      key: model.id,
      label: model.label || model.id,
      tokIn: b.tokIn,
      tokOut: b.tokOut,
    })
  }
  return { feedback, latency, tokens }
}

function abCharts(exp) {
  const ab = exp.ab
  if (!ab || !ab.rows.length) return { feedback: [], latency: [], tokens: [] }
  const acc = (side) => {
    let scores = 0, resolved = 0, lats = [], tokIn = 0, tokOut = 0
    for (const r of ab.rows) {
      const v = r[side]
      scores += Number(v.score || 0)
      if (v.resolved) resolved += 1
      if (Number.isFinite(v.latencyMs)) lats.push(v.latencyMs)
      if (v.tokens && Number.isFinite(v.tokens.in)) tokIn += v.tokens.in
      if (v.tokens && Number.isFinite(v.tokens.out)) tokOut += v.tokens.out
    }
    return {
      passRate: resolved / ab.rows.length,
      aveScore: scores / ab.rows.length,
      p50: percentile(lats, 50),
      p99: percentile(lats, 99),
      tokIn, tokOut,
    }
  }
  const a = acc('a'); const b = acc('b')
  return {
    feedback: [
      { key: 'a', label: ab.variantA.label || 'A', passRate: a.passRate, aveScore: a.aveScore },
      { key: 'b', label: ab.variantB.label || 'B', passRate: b.passRate, aveScore: b.aveScore },
    ],
    latency: [
      { key: 'a', label: ab.variantA.label || 'A', p50: a.p50, p99: a.p99 },
      { key: 'b', label: ab.variantB.label || 'B', p50: b.p50, p99: b.p99 },
    ],
    tokens: [
      { key: 'a', label: ab.variantA.label || 'A', tokIn: a.tokIn, tokOut: a.tokOut },
      { key: 'b', label: ab.variantB.label || 'B', tokIn: b.tokIn, tokOut: b.tokOut },
    ],
  }
}

function repCharts(exp) {
  const r = exp.rep
  if (!r || !r.repetitions.length) return { histogram: [], boxplot: null, resolvedStack: null }
  const stats = r.stats || {}
  return {
    histogram: stats.scoreHist || [],
    boxplot: stats.latencyBox || null,
    resolvedStack: {
      resolved: stats.resolvedCount || 0,
      unresolved: r.repetitions.length - (stats.resolvedCount || 0),
    },
  }
}

// ---------------------------------------------------------------------------
// projections — Kind A matrix grid
// ---------------------------------------------------------------------------

/**
 * Project the matrix grid: rows = prompts, cols = models, cells = the L1
 * `[n/N ✓ score]` DSBench-verbatim shape. Also emits column-totals
 * (pass@k / aveScore / totalCost / p50) at the bottom.
 *
 * Cells carry a `tintBucket` computed over the visible cells' score
 * distribution (pack §5.4 rule applied to cells too — the researcher wants
 * to eyeball hot/cold spots within one experiment).
 */
function projectMatrixGrid(exp) {
  if (!exp || exp.kind !== 'matrix' || !exp.matrix) {
    return { prompts: [], models: [], rows: [], totals: [] }
  }
  const m = exp.matrix
  const rows = []
  const scoresForTint = []
  for (const prompt of m.prompts) {
    const rowCells = m.models.map(model => {
      const key = `${prompt.id}|${model.id}`
      const c = m.cells[key]
      if (!c) return null
      if (Number.isFinite(c.score) && c.status !== 'queued' && c.status !== 'running') {
        scoresForTint.push(c.score)
      }
      return c
    })
    rows.push({ prompt, cells: rowCells })
  }
  const edges = quantileEdges(scoresForTint)
  for (const row of rows) {
    for (const c of row.cells) {
      if (c && Number.isFinite(c.score) && c.status !== 'queued' && c.status !== 'running') {
        // score is the reverse of latency: higher = better = green.
        c.tintBucket = quantileBucketFromEdges(c.score, edges, /* reversed */ true)
      } else if (c) {
        c.tintBucket = 'neutral'
      }
    }
  }
  // Column totals per model.
  const totals = m.models.map(model => {
    const modelCells = Object.values(m.cells).filter(c => c.modelId === model.id)
    let resolved = 0, N = 0
    const scores = []
    const lats = []
    const costs = []
    for (const c of modelCells) {
      resolved += c.resolvedCount
      N += c.N
      for (const r of c.runs) {
        if (Number.isFinite(r.score)) scores.push(r.score)
        if (Number.isFinite(r.latencyMs)) lats.push(r.latencyMs)
        if (Number.isFinite(r.cost)) costs.push(r.cost)
      }
    }
    const k = Math.min(3, exp.N || 3)
    const cellPassAtK = modelCells.map(c => passAtK(c.resolvedCount, c.N, k))
    return {
      model,
      passRate: N ? resolved / N : 0,
      passAtK: cellPassAtK.length ? mean(cellPassAtK) : 0,
      kUsed: k,
      aveScore: scores.length ? mean(scores) : 0,
      totalCost: costs.reduce((a, b) => a + b, 0),
      p50: percentile(lats, 50),
    }
  })
  return { prompts: m.prompts, models: m.models, rows, totals }
}

// ---------------------------------------------------------------------------
// projections — Kind B A/B rows
// ---------------------------------------------------------------------------

/**
 * Project the A/B per-prompt comparison table. Each row carries
 * `{promptId, aResolved, aScore, bResolved, bScore, delta, direction}`.
 * `direction` is `up|down|flat` for the arrow (|Δ| < 0.02 → flat).
 */
function projectABTable(exp) {
  if (!exp || exp.kind !== 'ab' || !exp.ab) return []
  const rows = []
  for (const r of exp.ab.rows) {
    const delta = Number(r.a.score || 0) - Number(r.b.score || 0)
    let direction = 'flat'
    if (delta >  0.02) direction = 'up'
    else if (delta < -0.02) direction = 'down'
    rows.push({
      promptId: r.promptId,
      aResolved: !!r.a.resolved,
      aScore: Number(r.a.score || 0),
      bResolved: !!r.b.resolved,
      bScore: Number(r.b.score || 0),
      delta,
      direction,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// projections — Kind C repetition table (LangSmith `Average | 1..N` shape)
// ---------------------------------------------------------------------------

/**
 * Project the LangSmith-Metrics-tab-style `Average | 1..N` table. Rows are
 * rubric dimensions (from `exp.rep.dims`), columns are the N repetitions.
 * Also returns a `list` of per-repetition summary rows for the "open trace"
 * panel below the table.
 */
function projectRepetitionTable(exp) {
  if (!exp || exp.kind !== 'rep' || !exp.rep) return { N: 0, headers: [], dims: [], list: [] }
  const r = exp.rep
  const N = r.repetitions.length
  const headers = []
  for (let i = 1; i <= N; i += 1) headers.push(String(i))
  const dims = []
  for (const dim of r.dims) {
    const values = r.repetitions.map(rep => (rep.dimensions && rep.dimensions[dim.id]))
    // If numeric, average; if boolean, x/N; if latency-shaped, average with unit.
    if (dim.kind === 'boolean') {
      const passes = values.filter(v => v === true).length
      dims.push({
        id: dim.id, label: dim.label, kind: 'boolean',
        average: `${passes}/${N}`,
        cells: values.map(v => ({ text: v === true ? '✓' : v === false ? '✗' : '—', pass: v === true, fail: v === false })),
      })
    } else if (dim.kind === 'latency') {
      const nums = values.filter(Number.isFinite)
      dims.push({
        id: dim.id, label: dim.label, kind: 'latency',
        average: nums.length ? `${(mean(nums) / 1000).toFixed(1)}s` : '—',
        cells: values.map(v => ({ text: Number.isFinite(v) ? `${(v / 1000).toFixed(1)}s` : '—' })),
      })
    } else if (dim.kind === 'tokens') {
      const nums = values.filter(Number.isFinite)
      dims.push({
        id: dim.id, label: dim.label, kind: 'tokens',
        average: nums.length ? String(Math.round(mean(nums))) : '—',
        cells: values.map(v => ({ text: Number.isFinite(v) ? String(v) : '—' })),
      })
    } else {
      // numeric score dimension
      const nums = values.filter(Number.isFinite)
      dims.push({
        id: dim.id, label: dim.label, kind: 'score',
        average: nums.length ? mean(nums).toFixed(2) : '—',
        cells: values.map(v => ({ text: Number.isFinite(v) ? v.toFixed(2) : '—', value: v })),
      })
    }
  }
  const list = r.repetitions.map((rep, i) => ({
    idx: i + 1,
    resolved: !!rep.resolved,
    score: Number(rep.score || 0),
    latencyMs: Number(rep.latencyMs || 0),
    sessionId: rep.sessionId || null,
  }))
  return { N, headers, dims, list }
}

// ---------------------------------------------------------------------------
// DSBench code_result.json export
// ---------------------------------------------------------------------------

/**
 * Emit the DSBenchV2 `code_result.json` shape for one matrix cell (or one
 * repetition, or one A/B side). This is the escalation-path contract from
 * dsbench-v2-reference.md §打分合约 that Bench is bit-identical to.
 */
function makeCodeResult(payload) {
  if (!payload) return null
  return {
    resolved: !!payload.resolved,
    score: Number.isFinite(payload.score) ? Number(payload.score) : 0,
    reason: String(payload.reason || ''),
  }
}

// ---------------------------------------------------------------------------
// math helpers
// ---------------------------------------------------------------------------

/**
 * pass@k = 1 - C(n-c, k) / C(n, k) — the standard OpenAI HumanEval formula.
 * Falls back to `c > 0 ? 1 : 0` when k >= n (any-of variant, honest edge
 * case). Returns 0 when n is 0.
 *
 * See docs/design-refs/bench-design-pack-160.md §"pass@k implementation"
 * note in #187 task description.
 */
function passAtK(c, n, k) {
  const cc = Math.max(0, Math.floor(c))
  const nn = Math.max(0, Math.floor(n))
  const kk = Math.max(1, Math.floor(k))
  if (nn === 0) return 0
  if (kk >= nn) return cc > 0 ? 1 : 0
  if (cc >= nn) return 1
  if (cc === 0) return 0
  // 1 - C(n-c,k)/C(n,k) = 1 - Π_{i=0..k-1} (n-c-i)/(n-i)
  let prod = 1
  for (let i = 0; i < kk; i += 1) {
    prod *= (nn - cc - i) / (nn - i)
  }
  return 1 - prod
}

function mean(xs) {
  if (!xs.length) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

function stdev(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  let acc = 0
  for (const x of xs) acc += (x - m) * (x - m)
  return Math.sqrt(acc / (xs.length - 1))
}

function percentile(xs, p) {
  if (!xs.length) return null
  const sorted = xs.slice().sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const idx = ((p / 100) * (sorted.length - 1))
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const frac = idx - lo
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

function quantileEdges(xs) {
  if (!xs || xs.length < 3) return null
  return { q25: percentile(xs, 25), q75: percentile(xs, 75) }
}

/**
 * Bucket a value into fast/normal/slow given quantile edges. Set `reversed`
 * true for higher-is-better metrics (score) so 75-100%ile → 'fast' (green).
 */
function quantileBucketFromEdges(v, edges, reversed) {
  if (!edges) return 'neutral'
  if (reversed) {
    if (v >= edges.q75) return 'fast'
    if (v <= edges.q25) return 'slow'
    return 'normal'
  }
  if (v <= edges.q25) return 'fast'
  if (v >= edges.q75) return 'slow'
  return 'normal'
}

/**
 * Convenience wrapper — pass a list and a value, get the bucket. Not used
 * internally; exposed for the tint tests.
 */
function quantileBucket(vs, v, reversed) {
  return quantileBucketFromEdges(v, quantileEdges(vs), reversed)
}

function boxplot(xs) {
  if (!xs.length) return null
  return {
    min: Math.min(...xs),
    q1: percentile(xs, 25),
    median: percentile(xs, 50),
    q3: percentile(xs, 75),
    max: Math.max(...xs),
  }
}

function histogram(xs, bins, lo, hi) {
  const buckets = new Array(bins).fill(0)
  if (!xs.length) return buckets.map((c, i) => ({ i, lo: lo + i * (hi - lo) / bins, hi: lo + (i + 1) * (hi - lo) / bins, count: 0 }))
  const range = hi - lo
  for (const x of xs) {
    if (!Number.isFinite(x)) continue
    let idx = Math.floor(((x - lo) / range) * bins)
    if (idx < 0) idx = 0
    if (idx >= bins) idx = bins - 1
    buckets[idx] += 1
  }
  return buckets.map((count, i) => ({
    i,
    lo: lo + i * (range / bins),
    hi: lo + (i + 1) * (range / bins),
    count,
  }))
}

// ---------------------------------------------------------------------------
// selection helpers
// ---------------------------------------------------------------------------

function selectExperiment(state, id) {
  state.selectedId = id
  return state
}

function setSubTab(state, tab) {
  const valid = new Set(['all', 'matrix', 'ab', 'rep'])
  state.subTab = valid.has(tab) ? tab : 'all'
  return state
}

function getExperiment(state, id) {
  return state.experiments.get(id) || null
}

// ---------------------------------------------------------------------------
// module boilerplate — mirror the mission-model / panels-c CommonJS+IIFE dual
// so the same file can be `require()`-d by tests and `<script>`-included by
// the renderer (in which case exports attach to `window.__dshBenchModel`).
// ---------------------------------------------------------------------------

const _exports = {
  createBenchState,
  loadExperiments,
  normalizeExperiment,
  projectL0Rows,
  projectMatrixGrid,
  projectABTable,
  projectRepetitionTable,
  projectChartStrip,
  makeCodeResult,
  passAtK,
  quantileBucket,
  selectExperiment,
  setSubTab,
  getExperiment,
  _internals: { mean, stdev, percentile, boxplot, histogram, quantileEdges, quantileBucketFromEdges },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports
} else if (typeof window !== 'undefined') {
  window.__dshBenchModel = _exports
}
