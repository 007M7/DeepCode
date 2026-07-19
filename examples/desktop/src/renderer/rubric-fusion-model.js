// Rubric fusion model — a single event-log store that Rubrics, Growth, and
// Runtime pages all subscribe to. Sits above rubrics-model.js (rubric
// definitions / dim specs) and annotation-model.js (per-session records)
// and exposes derived views so each page reads what it needs without
// re-deriving from raw sessions.
//
// Shape lock:
//
//   rubricDef = {
//     id, name, group?, description?,
//     dims: [ normalizedDimSpec ]         // continuous | categorical | boolean
//   }
//
//   scoreEvent = {
//     ts,                                 // ms epoch
//     rubricId,                           // key into the def registry
//     dimId,                              // one of def.dims[*].id
//     sessionId,                          // the session that produced this score
//     turnId,                             // opaque turn identifier — grounds
//                                         //   back to a trace step
//     rolloutIdx?,                        // 1..N when multiple rollouts of the
//                                         //   same session/turn are scored
//     score,                              // dim-typed value (number for continuous,
//                                         //   enum string for categorical, bool)
//     passed,                             // derived pass/fail (green/red)
//     harnessVersion?, model?, dataMix?   // filter dimensions for Growth
//   }
//
//   similarSessionsClass = {
//     id,                                 // 'similar-svg-gen', etc
//     signature,                          // heuristic tag: prompt-shape / tool-usage
//     count,
//     sessionIds: [ ... ],
//     promptSummary                       // one-line hint used to prefill the form
//   }
//
// The store is a plain in-memory object; a subscribe() callback is fired on
// every mutation so views can re-render. Fixture data is loaded via
// loadFixture(json) — no disk I/O in the model layer.
//
// All derived views (recentScoresFor / timeSeriesFor / rolloutGridFor /
// detectSimilarSessions) are pure over the current state, so tests can
// snapshot them without a DOM.

'use strict'
;(function () {

const R = (typeof window !== 'undefined' && window.__dshRubricsModel)
  ? window.__dshRubricsModel
  : (typeof require === 'function' ? require('./rubrics-model.js') : null)

// Default pass threshold when the caller doesn't specify one — anything
// >= 0.5 on the [0,1] normalization is green. Booleans use their literal
// value; categoricals use "not the lowest value".
const DEFAULT_PASS_THRESHOLD = 0.5

function createStore() {
  const state = {
    rubrics: new Map(),       // id -> rubricDef
    events: [],               // scoreEvent[]
    similarClasses: [],       // similarSessionsClass[]
    subscribers: new Set(),
    loadedFixtures: new WeakSet(), // seed refs already applied — see loadFixture
    eventKeys: new Set(),     // (ts|rubricId|dimId|sessionId|turnId|rolloutIdx)
                              // -> dedupe key for scoreEvents, so seedOnce
                              // getting called twice can't duplicate rows
                              // even if the caller passes a fresh seed
                              // literal each time.
  }

  function notify() {
    for (const cb of state.subscribers) {
      try { cb() } catch (_) { /* subscriber errors don't cascade */ }
    }
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {}
    state.subscribers.add(cb)
    return () => state.subscribers.delete(cb)
  }

  // Register (or replace) a rubric definition. Missing/invalid dims drop.
  function registerRubric(def) {
    if (!def || typeof def !== 'object' || !def.id) return null
    const normalized = {
      id: String(def.id),
      name: String(def.name || def.id),
      group: def.group || null,
      description: def.description || '',
      dims: [],
    }
    const rawDims = Array.isArray(def.dims) ? def.dims : []
    for (const d of rawDims) {
      const spec = R && R.normalizeDimSpec ? R.normalizeDimSpec(d) : d
      if (spec) normalized.dims.push(spec)
    }
    state.rubrics.set(normalized.id, normalized)
    notify()
    return normalized
  }

  function listRubrics() {
    return Array.from(state.rubrics.values())
  }

  function getRubric(id) {
    return state.rubrics.get(String(id || '')) || null
  }

  // Derive pass/fail for a score, given a dim spec. Contract:
  //   continuous: normalize(score) >= threshold
  //   categorical: score !== spec.values[0] (lowest ordinal)
  //   boolean: score === true (or maps to the "positive" label)
  function computePassed(spec, score, threshold) {
    if (!spec || score == null) return false
    const t = Number.isFinite(threshold) ? threshold : DEFAULT_PASS_THRESHOLD
    if (spec.type === 'boolean') return score === true || score === 'true'
    if (spec.type === 'categorical') {
      if (!Array.isArray(spec.values) || !spec.values.length) return false
      // Lowest-value = fail; anything else = pass.
      return String(score) !== String(spec.values[0])
    }
    // continuous
    if (R && R.normalizeReward) {
      const n = R.normalizeReward(spec, score)
      return n != null && n >= t
    }
    const num = Number(score)
    const span = spec.max - spec.min
    if (!Number.isFinite(num) || span <= 0) return false
    return ((num - spec.min) / span) >= t
  }

  // Add a raw score event. `passed` is auto-derived if omitted.
  function addEvent(raw) {
    if (!raw || typeof raw !== 'object') return null
    const rubric = state.rubrics.get(String(raw.rubricId || ''))
    if (!rubric) return null
    const spec = rubric.dims.find(d => d.id === raw.dimId)
    if (!spec) return null
    const ts = Number(raw.ts) || Date.now()
    // Idempotence key: the three fusion pages (Rubrics / Growth / Runtime)
    // each seedOnce() from the same fixture and share this singleton. If
    // the seed's identity flag drifts across pages (or a caller passes a
    // fresh literal each call), the event log would double up rows for
    // the same (ts, rubricId, dimId, sessionId, turnId, rolloutIdx)
    // coordinate. Deduping by that key here makes loadFixture safe to
    // call from any number of pages without event-count inflation.
    const rolloutForKey = Number.isFinite(Number(raw.rolloutIdx)) ? Number(raw.rolloutIdx) : ''
    const key = `${ts}|${rubric.id}|${spec.id}|${raw.sessionId || ''}|${raw.turnId || ''}|${rolloutForKey}`
    if (state.eventKeys.has(key)) return null
    state.eventKeys.add(key)
    const evt = {
      ts,
      rubricId: rubric.id,
      dimId: spec.id,
      sessionId: String(raw.sessionId || ''),
      turnId: String(raw.turnId || ''),
      rolloutIdx: Number.isFinite(Number(raw.rolloutIdx)) ? Number(raw.rolloutIdx) : null,
      score: raw.score,
      passed: raw.passed != null ? !!raw.passed : computePassed(spec, raw.score, raw.threshold),
      harnessVersion: raw.harnessVersion || null,
      model: raw.model || null,
      dataMix: raw.dataMix || null,
    }
    state.events.push(evt)
    notify()
    return evt
  }

  // Bulk load from a fixture JSON blob. Shape:
  //   { rubrics: [rubricDef], events: [scoreEvent], similarClasses: [class] }
  //
  // Called by each of the three pages' seedOnce()s. The per-page flags
  // (rubrics-page fusionSeeded, growth-v2 state.seeded) mean each page
  // fires it at most once, but the pages share this singleton store —
  // so without dedupe here, two-page seeding would double-insert every
  // event. Two-tier guard:
  //   1. WeakSet on the fixture object ref (fast path for the common
  //      case where all pages read window.__dshRubricFusionSeed). Return
  //      shape includes `deduped: true` on this fast-path hit so callers
  //      can distinguish "already seeded" from "empty fixture".
  //   2. Per-event key dedupe inside addEvent() catches the case where a
  //      caller passes a fresh literal (or a deep-cloned copy) that
  //      carries the same rows — the WeakSet won't help there because
  //      the object identity differs.
  function loadFixture(json) {
    if (!json || typeof json !== 'object') return { rubrics: 0, events: 0 }
    if (state.loadedFixtures.has(json)) return { rubrics: 0, events: 0, deduped: true }
    state.loadedFixtures.add(json)
    let rn = 0, en = 0
    for (const r of json.rubrics || []) { if (registerRubric(r)) rn++ }
    for (const e of json.events || []) { if (addEvent(e)) en++ }
    // similarClasses is a projection, not accumulator — last-wins is fine
    // and preserves the "the seed's opinion is authoritative" contract.
    state.similarClasses = Array.isArray(json.similarClasses) ? json.similarClasses.slice() : []
    notify()
    return { rubrics: rn, events: en }
  }

  function clearAll() {
    state.rubrics.clear()
    state.events.length = 0
    state.similarClasses.length = 0
    state.eventKeys.clear()
    // loadedFixtures uses WeakSet — the fixture references outlive the
    // store's memory of them anyway (window globals), but we drop the
    // dedupe cache so a re-seed after clearAll works cleanly.
    state.loadedFixtures = new WeakSet()
    notify()
  }

  // ---------- filters ----------

  function eventsMatching(filter) {
    if (!filter || typeof filter !== 'object') return state.events.slice()
    return state.events.filter(e => {
      if (filter.rubricId && e.rubricId !== filter.rubricId) return false
      if (filter.dimId && e.dimId !== filter.dimId) return false
      if (filter.sessionId && e.sessionId !== filter.sessionId) return false
      if (filter.since != null && e.ts < filter.since) return false
      if (filter.until != null && e.ts > filter.until) return false
      if (filter.harnessVersion && e.harnessVersion !== filter.harnessVersion) return false
      if (filter.model && e.model !== filter.model) return false
      if (filter.dataMix && e.dataMix !== filter.dataMix) return false
      return true
    })
  }

  function listEvents(filter) {
    return eventsMatching(filter)
  }

  // ---------- Rubrics-view derivation: recent scores stats ----------

  // { total, passRate, meanScore01, byDim: { dimId -> {n, passRate, mean01} },
  //   latest: [event...] (N most recent) }.
  function recentScoresFor(rubricId, N = 20) {
    const rubric = state.rubrics.get(String(rubricId || ''))
    if (!rubric) return { total: 0, passRate: 0, meanScore01: 0, byDim: {}, latest: [] }
    const all = eventsMatching({ rubricId: rubric.id })
    const total = all.length
    let passed = 0
    let mean01Sum = 0
    let mean01Count = 0
    const byDim = {}
    for (const d of rubric.dims) byDim[d.id] = { n: 0, passed: 0, sum01: 0, count01: 0 }
    for (const e of all) {
      if (e.passed) passed++
      const spec = rubric.dims.find(d => d.id === e.dimId)
      const norm = spec && R && R.normalizeReward ? R.normalizeReward(spec, e.score) : null
      if (norm != null) { mean01Sum += norm; mean01Count++ }
      const bucket = byDim[e.dimId]
      if (bucket) {
        bucket.n++
        if (e.passed) bucket.passed++
        if (norm != null) { bucket.sum01 += norm; bucket.count01++ }
      }
    }
    // Reshape byDim to final form.
    const byDimOut = {}
    for (const [id, b] of Object.entries(byDim)) {
      byDimOut[id] = {
        n: b.n,
        passRate: b.n ? Math.round((b.passed / b.n) * 1000) / 1000 : 0,
        mean01: b.count01 ? Math.round((b.sum01 / b.count01) * 1000) / 1000 : 0,
      }
    }
    const latest = all.slice().sort((a, b) => b.ts - a.ts).slice(0, N)
    return {
      total,
      passRate: total ? Math.round((passed / total) * 1000) / 1000 : 0,
      meanScore01: mean01Count ? Math.round((mean01Sum / mean01Count) * 1000) / 1000 : 0,
      byDim: byDimOut,
      latest,
    }
  }

  // ---------- Growth-view derivation: time-series curves ----------

  // Group events by { bucketKey, seriesKey } → { pass, total, sum01, cnt01 }.
  // bucketKey is derived from `by`: 'day' (YYYY-MM-DD in UTC), 'version'
  // (harnessVersion), or 'model' (model id). seriesKey is per-dim by default;
  // callers can override with `groupBy: 'rubric' | 'dim' | 'model' | 'version'`.
  //
  // Returns { xAxis: [bucketKey], series: [{ key, label, points: [{x, passRate, mean01, n}] }] }
  function timeSeriesFor(opts) {
    opts = opts || {}
    const by = opts.by || 'day'
    const groupBy = opts.groupBy || 'dim'
    const filter = opts.filter || {}
    const filtered = eventsMatching(filter)
    if (!filtered.length) return { xAxis: [], series: [] }
    const bucketFn = pickBucketFn(by)
    const seriesFn = pickSeriesFn(groupBy)
    const rubricsById = state.rubrics

    // buckets: Map<bucketKey, Map<seriesKey, {pass, total, sum01, cnt01}>>
    const buckets = new Map()
    const bucketOrder = []
    for (const e of filtered) {
      const bk = bucketFn(e)
      if (!bk) continue
      let byBucket = buckets.get(bk)
      if (!byBucket) { byBucket = new Map(); buckets.set(bk, byBucket); bucketOrder.push(bk) }
      const sk = seriesFn(e, rubricsById)
      if (!sk) continue
      let acc = byBucket.get(sk)
      if (!acc) { acc = { pass: 0, total: 0, sum01: 0, cnt01: 0 }; byBucket.set(sk, acc) }
      acc.total++
      if (e.passed) acc.pass++
      const rubric = rubricsById.get(e.rubricId)
      const spec = rubric && rubric.dims.find(d => d.id === e.dimId)
      const norm = spec && R && R.normalizeReward ? R.normalizeReward(spec, e.score) : null
      if (norm != null) { acc.sum01 += norm; acc.cnt01++ }
    }
    bucketOrder.sort()

    // Flatten to series-major shape.
    const seriesKeys = new Set()
    for (const byBucket of buckets.values()) for (const k of byBucket.keys()) seriesKeys.add(k)
    const series = []
    for (const key of Array.from(seriesKeys).sort()) {
      const points = []
      for (const bk of bucketOrder) {
        const acc = buckets.get(bk).get(key)
        if (!acc) continue
        points.push({
          x: bk,
          passRate: acc.total ? Math.round((acc.pass / acc.total) * 1000) / 1000 : 0,
          mean01: acc.cnt01 ? Math.round((acc.sum01 / acc.cnt01) * 1000) / 1000 : 0,
          n: acc.total,
        })
      }
      series.push({ key, label: seriesLabel(key, groupBy, rubricsById), points })
    }
    return { xAxis: bucketOrder, series }
  }

  function pickBucketFn(by) {
    if (by === 'version') return e => e.harnessVersion || 'unknown'
    if (by === 'model') return e => e.model || 'unknown'
    // default: day
    return e => {
      const d = new Date(e.ts || 0)
      if (!Number.isFinite(d.getTime())) return null
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
  }

  function pickSeriesFn(groupBy) {
    if (groupBy === 'rubric') return e => e.rubricId
    if (groupBy === 'model') return e => e.model || 'unknown'
    if (groupBy === 'version') return e => e.harnessVersion || 'unknown'
    // dim (default) — composite so different rubrics with same dim id stay separate
    return e => `${e.rubricId}::${e.dimId}`
  }

  function seriesLabel(key, groupBy, rubricsById) {
    if (groupBy === 'dim') {
      const [rid, did] = String(key).split('::')
      const rubric = rubricsById.get(rid)
      if (!rubric) return key
      const spec = rubric.dims.find(d => d.id === did)
      return spec ? `${rubric.name} · ${spec.label}` : `${rubric.name} · ${did}`
    }
    if (groupBy === 'rubric') {
      const rubric = rubricsById.get(String(key))
      return rubric ? rubric.name : String(key)
    }
    return String(key)
  }

  // ---------- Runtime-view derivation: rollout grid ----------

  // Build a rubric x rollout matrix for a session. If sessionId is null, use
  // the whole event corpus (Runtime "live" view — every session's most
  // recent rollout).
  //
  // Returns { rubric, dims: [{id, label}], rollouts: [1..N],
  //   cells: [{dimId, rolloutIdx, sessionId, turnId, passed, score, ts}] }
  function rolloutGridFor(rubricId, sessionId) {
    const rubric = state.rubrics.get(String(rubricId || ''))
    if (!rubric) return { rubric: null, dims: [], rollouts: [], cells: [] }
    const filter = { rubricId: rubric.id }
    if (sessionId) filter.sessionId = String(sessionId)
    const all = eventsMatching(filter)
    const rolloutSet = new Set()
    for (const e of all) if (e.rolloutIdx != null) rolloutSet.add(e.rolloutIdx)
    const rollouts = Array.from(rolloutSet).sort((a, b) => a - b)
    const dims = rubric.dims.map(d => ({ id: d.id, label: d.label, type: d.type }))
    const cells = []
    for (const dim of dims) {
      for (const r of rollouts) {
        // If multiple events for (dim, rollout), take the most recent.
        let latest = null
        for (const e of all) {
          if (e.dimId !== dim.id) continue
          if (e.rolloutIdx !== r) continue
          if (!latest || e.ts > latest.ts) latest = e
        }
        cells.push({
          dimId: dim.id,
          rolloutIdx: r,
          sessionId: latest ? latest.sessionId : null,
          turnId: latest ? latest.turnId : null,
          passed: latest ? latest.passed : null,
          score: latest ? latest.score : null,
          ts: latest ? latest.ts : null,
        })
      }
    }
    return { rubric, dims, rollouts, cells }
  }

  // ---------- Hint card: similar-session detection ----------

  // Returns the fixture-provided similarClasses for now (TODO: real
  // signature heuristic once the shell has session-index access). Filters to
  // classes with count >= minCount so the hint doesn't fire on singletons.
  function detectSimilarSessions(opts) {
    opts = opts || {}
    const minCount = Number.isFinite(opts.minCount) ? opts.minCount : 3
    return state.similarClasses.filter(c => c && Number(c.count) >= minCount).slice()
  }

  return {
    subscribe,
    registerRubric,
    getRubric,
    listRubrics,
    addEvent,
    loadFixture,
    listEvents,
    clearAll,
    recentScoresFor,
    timeSeriesFor,
    rolloutGridFor,
    detectSimilarSessions,
    computePassed,
    _state: state,   // test hook
  }
}

const singleton = createStore()

const api = {
  create: createStore,
  ...singleton,
}

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof window !== 'undefined') window.__dshRubricFusion = api

})()
