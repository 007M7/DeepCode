// Pure projection helpers for the Context page (#185, ia-design-pack §3
// "Ledger" surface — renamed to Context per team-lead 2026-07-17).
//
// The Context page is a per-session ledger of context-mutation events —
// injects (context/message), compact/summary, recall tool calls, steering,
// budget usage — grouped by turn boundary. Existing DSH modules already
// classify each of these atoms in isolation (context-rail.js for family
// dots, inject-family.js for the 8-family split, context-meter.js for the
// running budget); this module composes those pieces into the row shape
// the page's L0 stream renders, plus a few page-only rollups (roster,
// compact policy, recall config, budget sparkline, YAML profile export).
//
// Every function here is a pure transform over an event array — no DOM,
// no globals — so test/context-page-model.test.js drives them under
// `node --test` without booting the shell. See src/renderer/context-page.js
// for the DOM controller that consumes these projections.
//
// Design red-lines:
//
//   1. The row shape is deliberately *strict*: only fields the L0 line
//      renders live in `TurnRow`. Anything deeper (per-event summary,
//      injected content preview) is re-derived from the underlying event
//      array on L1/L2 expansion — the row itself never carries payload
//      strings so `JSON.stringify(row)` stays cheap and idempotent.
//
//   2. Budget accounting delegates to context-meter's tracker. The page
//      does NOT invent a second counting scheme — it replays the same
//      tracker per-turn so budgetPct on the Context page always matches
//      the statusbar meter to the token.
//
//   3. `summarizeCompactPolicy` returns null when no compact/summary has
//      landed yet. The UI legend must say "policy not yet observed" in
//      that case; fabricating a policy from event silence is a lie.

'use strict'

// Import the context-meter API when we're under Node (tests + main-process
// tools). Under the renderer these globals are attached via
// `window.__dshContextMeter`; that path is followed at call time via
// `resolveMeter()` so the module works in both shapes.
let nodeMeter = null
if (typeof module !== 'undefined' && module.exports) {
  try { nodeMeter = require('./context-meter.js') } catch (_) { nodeMeter = null }
}

function resolveMeter() {
  if (nodeMeter) return nodeMeter
  if (typeof window !== 'undefined' && window.__dshContextMeter) return window.__dshContextMeter
  return null
}

// Event-type predicates. Kept as small named helpers so the branching in
// projectTurnRows() reads like prose.
function isInjectEvent(ev) {
  return !!(ev && ev.type === 'context/message')
}
function isCompactEvent(ev) {
  return !!(ev && ev.type === 'compact/summary')
}
function isTurnBoundary(ev) {
  return !!(ev && ev.type === 'turn/end')
}
// Recall = a tool/call whose name matches the DSH recall convention. Kept
// synced with context-rail.js RAIL_RECALL_TOOL_NAMES so the two views agree
// on what a "recall" is. Renamed away from the top-level `RECALL_TOOL_NAMES`
// symbol that renderer.js already owns (this file is a dual-exported script
// tag — a duplicate top-level `const` is a load-time SyntaxError, exactly
// the collision test/renderer-collisions.test.js exists to gate).
const CONTEXT_PAGE_RECALL_TOOL_NAMES = new Set(['history_read', 'history_search'])
function isRecallEvent(ev) {
  return !!(ev && ev.type === 'tool/call' && ev.data && CONTEXT_PAGE_RECALL_TOOL_NAMES.has(ev.data.name))
}

/**
 * Extract the plugin name from a context/message event's source map. Falls
 * back to 'user' for user-initiated skill includes and 'other' for anything
 * unclassifiable. Matches classifyEventForRail's plugin-naming so the page
 * and the rail don't rename the same plugin two different ways.
 * @param {object} ev
 * @returns {string}
 */
function pluginOf(ev) {
  const src = ev && ev.data && ev.data.source
  if (!src) return 'other'
  if (typeof src === 'string') return src
  if (src.kind === 'plugin' && typeof src.plugin === 'string') return src.plugin
  if (src.kind === 'user') return 'user'
  if (typeof src.kind === 'string') return src.kind
  return 'other'
}

/**
 * @typedef {Object} InjectSlice
 * @property {string} plugin
 * @property {number} count
 * @property {Array<number>} seqs
 */

/**
 * @typedef {Object} TurnRow
 * @property {number} turn         The `data.turn` value from the turn/end event, or 0 for the pre-first-turn bucket.
 * @property {number} firstSeq     Seq of the first event in this bucket.
 * @property {number} lastSeq      Seq of the last event in this bucket (the turn/end seq, or the last observed seq).
 * @property {Array<InjectSlice>} injects   Per-plugin injection breakdown for this turn (deterministic order — first-seen).
 * @property {number} injectCount  Sum of all injections in this turn.
 * @property {number} compactCount Number of compact/summary events in this turn.
 * @property {number} recallCount  Number of recall tool/call events in this turn.
 * @property {Array<number>} injectSeqs   Every inject seq in order.
 * @property {Array<number>} compactSeqs  Every compact seq in order.
 * @property {Array<number>} recallSeqs   Every recall seq in order.
 * @property {number} tokens       Meter-derived cumulative tokens at the *end* of this turn.
 * @property {number} budget       Meter-derived budget at the end of this turn.
 * @property {'server'|'assumed'} budgetSource
 * @property {number} budgetPct    tokens / budget × 100, clamped [0,999] and rounded to nearest int.
 * @property {number} eventCount   Every wire event that landed in this bucket (for sanity + tests).
 * @property {boolean} closed      True when this bucket ended on a turn/end (as opposed to being the trailing in-flight tail).
 */

/**
 * Build one Context-page row per turn boundary from a session event array.
 *
 * Grouping rule: events land in the "current" bucket, which flips to a new
 * bucket on every `turn/end`. Events before the first turn/end (system
 * seeds, session-start hooks) form turn 0. Events after the final turn/end
 * are kept as an open trailing bucket so an in-flight turn still appears —
 * the row is flagged `closed: false` and the UI renders it with a running
 * pip.
 *
 * Budget: a fresh {@link createTracker} instance ingests every event as we
 * walk them, so `tokens/budget` at each turn boundary reflects "the state
 * of context at the moment the turn closed" — same accounting the
 * statusbar meter shows live.
 *
 * @param {Array<object>} events
 * @param {object} [opts]
 * @param {number} [opts.budgetTokens] Override tracker's default budget.
 * @returns {Array<TurnRow>}
 */
function projectTurnRows(events, opts) {
  const meter = resolveMeter()
  const tracker = meter && meter.createTracker
    ? meter.createTracker({ budgetTokens: (opts && opts.budgetTokens) || undefined })
    : null

  const rows = []
  let current = openBucket(0)
  if (!Array.isArray(events)) return rows

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    // Reject anything without a real wire type — matches the convention in
    // context-rail.js / event-filter.js and prevents `{}` blobs from
    // inflating turn buckets when the caller hands us garbage.
    if (typeof ev.type !== 'string') continue
    if (tracker) tracker.ingest(ev)

    const seq = typeof ev.seq === 'number' ? ev.seq : 0
    if (current.eventCount === 0) current.firstSeq = seq
    current.lastSeq = seq
    current.eventCount++

    // Fold classifier results into the bucket counters. A single event
    // can only be one family — the predicates above are mutually exclusive
    // for the four types we track.
    if (isInjectEvent(ev)) {
      const plugin = pluginOf(ev)
      let slice = current.injectMap.get(plugin)
      if (!slice) {
        slice = { plugin, count: 0, seqs: [] }
        current.injectMap.set(plugin, slice)
      }
      slice.count++
      slice.seqs.push(seq)
      current.injectSeqs.push(seq)
      current.injectCount++
    } else if (isCompactEvent(ev)) {
      current.compactCount++
      current.compactSeqs.push(seq)
    } else if (isRecallEvent(ev)) {
      current.recallCount++
      current.recallSeqs.push(seq)
    }

    if (isTurnBoundary(ev)) {
      current.turn = (ev.data && typeof ev.data.turn === 'number') ? ev.data.turn : current.turn
      current.closed = true
      finalizeBucket(current, tracker)
      // Only push buckets that actually saw context activity OR are past
      // the pre-turn-0 seed noise. We DO include activity-free turns
      // between compact resets because the row's budget number is still
      // meaningful — a researcher wants to see the tokens=0 dip after a
      // compact even without any inject.
      rows.push(freezeBucket(current))
      current = openBucket(current.turn + 1)
    }
  }

  // Trailing bucket — only include if it actually saw events OR we saw a
  // non-zero seq (the session has activity we haven't seen closed yet).
  if (current.eventCount > 0) {
    finalizeBucket(current, tracker)
    rows.push(freezeBucket(current))
  }

  return rows
}

function openBucket(turn) {
  return {
    turn,
    firstSeq: 0,
    lastSeq: 0,
    eventCount: 0,
    injectMap: new Map(), // plugin → InjectSlice
    injectSeqs: [],
    injectCount: 0,
    compactCount: 0,
    compactSeqs: [],
    recallCount: 0,
    recallSeqs: [],
    tokens: 0,
    budget: 0,
    budgetSource: 'assumed',
    budgetPct: 0,
    closed: false,
  }
}

function finalizeBucket(b, tracker) {
  if (tracker && typeof tracker.snapshot === 'function') {
    const snap = tracker.snapshot()
    b.tokens = snap.tokens || 0
    b.budget = snap.budget || 0
    b.budgetSource = snap.budgetSource === 'server' ? 'server' : 'assumed'
    if (b.budget > 0) {
      const pct = Math.round((b.tokens / b.budget) * 100)
      b.budgetPct = Math.max(0, Math.min(pct, 999))
    }
  }
}

function freezeBucket(b) {
  return {
    turn: b.turn,
    firstSeq: b.firstSeq,
    lastSeq: b.lastSeq,
    injects: Array.from(b.injectMap.values()),
    injectCount: b.injectCount,
    compactCount: b.compactCount,
    recallCount: b.recallCount,
    injectSeqs: b.injectSeqs.slice(),
    compactSeqs: b.compactSeqs.slice(),
    recallSeqs: b.recallSeqs.slice(),
    tokens: b.tokens,
    budget: b.budget,
    budgetSource: b.budgetSource,
    budgetPct: b.budgetPct,
    eventCount: b.eventCount,
    closed: b.closed,
  }
}

/**
 * Aggregate the injection roster across the whole session. Returns an
 * array of `{plugin, count, firstSeq, lastSeq, family}` in first-seen
 * order — the roster in L1 sorts by count desc at render time, but
 * first-seen order is what the roster's baseline should be so tests can
 * assert on a stable shape.
 *
 * `family` is filled from inject-family.js when that module is available
 * (via require in Node or window.__dshInjectFamily in the renderer). When
 * neither is around, family stays null and the UI shows a neutral chip —
 * the page keeps working without inject-family loaded first.
 *
 * @param {Array<object>} events
 * @param {object} [ctx] passed through to classifyInjectEvent
 * @returns {Array<{plugin:string, count:number, firstSeq:number, lastSeq:number, family:string|null}>}
 */
function buildInjectionRoster(events, ctx) {
  const classifier = resolveInjectFamily()
  const map = new Map()
  if (!Array.isArray(events)) return []
  for (const ev of events) {
    if (!isInjectEvent(ev)) continue
    const plugin = pluginOf(ev)
    let row = map.get(plugin)
    if (!row) {
      row = { plugin, count: 0, firstSeq: 0, lastSeq: 0, family: null }
      map.set(plugin, row)
    }
    row.count++
    const seq = typeof ev.seq === 'number' ? ev.seq : 0
    if (!row.firstSeq) row.firstSeq = seq
    row.lastSeq = seq
    if (!row.family && classifier && typeof classifier.classifyInjectEvent === 'function') {
      try {
        const cls = classifier.classifyInjectEvent(ev, ctx)
        if (cls && cls.family) row.family = cls.family
      } catch (_) { /* classifier drift — leave family null */ }
    }
  }
  return Array.from(map.values())
}

let nodeInjectFamily = null
if (typeof module !== 'undefined' && module.exports) {
  try { nodeInjectFamily = require('./inject-family.js') } catch (_) { nodeInjectFamily = null }
}
function resolveInjectFamily() {
  if (nodeInjectFamily) return nodeInjectFamily
  if (typeof window !== 'undefined' && window.__dshInjectFamily) return window.__dshInjectFamily
  return null
}

/**
 * Summarise the compact policy from the most recent compact/summary event.
 * Returns null when no compact/summary has landed — the UI's "Compact
 * policy" chip group then reads "policy not yet observed" instead of
 * fabricating a `deepseek-chat` default from silence.
 *
 * The `source` field disambiguates auto vs manual: manual compaction shows
 * up as a compact plugin `user/message` immediately preceding the summary
 * (renderer.js line ≈2318), so this projection scans backwards from each
 * summary to find that hint. When the trigger's unclear (mixed fixtures,
 * legacy sessions) `source` stays 'unknown'.
 *
 * @param {Array<object>} events
 * @returns {{model:string|null, maxTokens:number|null, source:'auto'|'manual'|'unknown', seq:number, shadowedTokens:number|null}|null}
 */
function summarizeCompactPolicy(events) {
  if (!Array.isArray(events)) return null
  let lastIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (isCompactEvent(events[i])) { lastIdx = i; break }
  }
  if (lastIdx < 0) return null
  const ev = events[lastIdx]
  const d = ev.data || {}
  // Manual detection: walk back a few events looking for a user/message
  // whose source is the compact plugin (renderer's own Compact-button seeds
  // that exact shape). Scan is capped at 6 predecessors so a genuinely-auto
  // summary preceded by unrelated user chatter doesn't get misclassified.
  let source = 'unknown'
  for (let j = lastIdx - 1; j >= Math.max(0, lastIdx - 6); j--) {
    const p = events[j]
    if (p && p.type === 'user/message' && p.data && p.data.source) {
      const s = p.data.source
      const isCompactPlugin = s && s.kind === 'plugin' && s.plugin === 'compact'
      source = isCompactPlugin ? 'manual' : 'auto'
      break
    }
  }
  return {
    model: typeof d.model === 'string' ? d.model : null,
    maxTokens: Number.isFinite(d.maxTokens) ? d.maxTokens : null,
    source,
    seq: typeof ev.seq === 'number' ? ev.seq : 0,
    shadowedTokens: Number.isFinite(d.shadowedTokenCount) ? d.shadowedTokenCount : null,
  }
}

/**
 * Summarise the recall configuration surfaced by the session's recall tool
 * calls. There is no wire method today that reports "sliding window size"
 * or "threshold" (gap G3 in the design pack); what we CAN show is which
 * recall tools fired, how often, and against what argument keys. That
 * gives the researcher an honest picture of "recall did happen, N times,
 * on these keys" without inventing knobs the runtime doesn't have.
 *
 * @param {Array<object>} events
 * @returns {{tools: Array<{name:string, count:number, sampleArgs:string|null}>, total:number}}
 */
function summarizeRecallConfig(events) {
  if (!Array.isArray(events)) return { tools: [], total: 0 }
  const map = new Map()
  let total = 0
  for (const ev of events) {
    if (!isRecallEvent(ev)) continue
    total++
    const name = (ev.data && ev.data.name) || 'recall'
    let row = map.get(name)
    if (!row) {
      row = { name, count: 0, sampleArgs: null }
      map.set(name, row)
    }
    row.count++
    if (!row.sampleArgs) {
      const args = ev.data && ev.data.arguments
      if (typeof args === 'string' && args.length > 0) row.sampleArgs = args
      else if (args && typeof args === 'object') {
        try { row.sampleArgs = JSON.stringify(args) } catch (_) { row.sampleArgs = null }
      }
    }
  }
  return { tools: Array.from(map.values()), total }
}

/**
 * Compute the miniature per-turn budget sparkline. Returns an array of
 * `{turn, pct, height}` where `height` is a `0..1` fraction the CSS bar
 * scales its inline `height:` to — the domain is normalised against the
 * max pct in the series so a low-budget session still shows visible
 * variation.
 *
 * When `rows` is empty or every pct is zero the return is an empty array;
 * the UI then renders no sparkline (rather than a flat grey line that
 * pretends to be data).
 *
 * @param {Array<TurnRow>} rows
 * @returns {Array<{turn:number, pct:number, height:number}>}
 */
function computeBudgetSparkline(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  let peak = 0
  for (const r of rows) if (r.budgetPct > peak) peak = r.budgetPct
  if (peak <= 0) return []
  return rows.map((r) => ({
    turn: r.turn,
    pct: r.budgetPct,
    height: Math.max(0.05, Math.min(1, r.budgetPct / peak)),
  }))
}

/**
 * Serialise the current context-policy view to a portable YAML string —
 * the "Save as profile" small button in the L1 area writes this to a
 * download blob. The shape mirrors `.dsh/profiles/<name>.yaml` in the DSH
 * runtime so a saved file drops straight in.
 *
 * The output is *deliberately* hand-written (no `yaml` dep) because the
 * profile shape is tiny and stable — a real YAML lib would be a 200KB
 * addition for two dozen scalar keys. Test coverage locks the format.
 *
 * @param {object} spec
 * @param {string} [spec.name]
 * @param {'auto'|'manual'|'off'} [spec.shadowing]
 * @param {string|null} [spec.compactModel]
 * @param {number|null} [spec.compactMaxTokens]
 * @param {'auto'|'manual'|'unknown'} [spec.compactSource]
 * @param {Array<{plugin:string, allow:boolean}>} [spec.injectionScopes]
 * @param {{windowSeqs:number, threshold:number}} [spec.recall]
 * @returns {string}
 */
function serializeProfileYAML(spec) {
  const s = spec || {}
  const lines = []
  lines.push('# DSH context profile — exported from the Context page.')
  lines.push('# This is a demo-tier snapshot; some fields have no live wire')
  lines.push('# effect yet (see the SDK-support legend on the page).')
  lines.push(`name: ${yamlString(s.name || 'unnamed-profile')}`)
  lines.push(`created: ${yamlString(new Date(0).toISOString().slice(0, 10))}`) // 0-epoch => stable for tests
  lines.push('shadowing:')
  lines.push(`  mode: ${yamlString(s.shadowing || 'auto')}`)
  lines.push('compact:')
  lines.push(`  model: ${yamlString(s.compactModel || 'unknown')}`)
  lines.push(`  maxTokens: ${Number.isFinite(s.compactMaxTokens) ? s.compactMaxTokens : 'null'}`)
  lines.push(`  source: ${yamlString(s.compactSource || 'unknown')}`)
  lines.push('recall:')
  const r = s.recall || {}
  lines.push(`  windowSeqs: ${Number.isFinite(r.windowSeqs) ? r.windowSeqs : 'null'}`)
  lines.push(`  threshold: ${Number.isFinite(r.threshold) ? r.threshold : 'null'}`)
  lines.push('injectionScopes:')
  const scopes = Array.isArray(s.injectionScopes) ? s.injectionScopes : []
  if (scopes.length === 0) {
    lines.push('  []')
  } else {
    for (const sc of scopes) {
      lines.push(`  - plugin: ${yamlString(sc.plugin || 'unknown')}`)
      lines.push(`    allow: ${sc.allow ? 'true' : 'false'}`)
    }
  }
  return lines.join('\n') + '\n'
}

// Minimal YAML string emitter — quote when the value contains anything
// beyond `[A-Za-z0-9._-]`, otherwise emit bare. Handles the empty string
// specially so we never emit `key:` with no value (which YAML parses as
// null and would silently corrupt round-trips).
function yamlString(v) {
  const s = String(v == null ? '' : v)
  if (s === '') return '""'
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s
  return JSON.stringify(s)
}

/**
 * Static registry of which policy knobs are live on the wire today vs
 * gapped upstream. Rendered as the "SDK support" legend at the bottom of
 * the page — the design pack is explicit that we must be honest about
 * demo-vs-real so researchers don't spend an hour hunting a fake knob.
 *
 * `status`:
 *   'live'            — the wire has a method + the shell drives it.
 *   'restart-required'— the field is editable but only takes effect on
 *                        session restart (session/set-* is missing).
 *   'upstream-pending' — no wire method at all; renderer stubs it.
 *
 * @returns {Array<{knob:string, status:'live'|'restart-required'|'upstream-pending', gap:string|null, note:string}>}
 */
function capabilitiesLegend() {
  return [
    {
      knob: 'Compact-now button',
      status: 'live',
      gap: null,
      note: 'session/compact — statusbar Compact button and per-turn compact events already flow through this method.',
    },
    {
      knob: 'Session/list model + contextWindow',
      status: 'live',
      gap: null,
      note: 'Ticket A projection shipped; budget number on this page reads the real model context window when available.',
    },
    {
      knob: 'Shadowing tri-state (auto/manual/off)',
      status: 'restart-required',
      gap: 'G2',
      note: 'Rendered as a live control; the runtime only re-reads the profile YAML on next session restart.',
    },
    {
      knob: 'Compact policy (model / maxTokens)',
      status: 'restart-required',
      gap: 'G2',
      note: 'Editable in the profile YAML; no session/set-compact-policy wire method exists yet.',
    },
    {
      knob: 'Recall config (window size / threshold)',
      status: 'upstream-pending',
      gap: 'G3',
      note: 'No session/set-recall-config method — the shell shows what recall did happen; it cannot adjust the gate.',
    },
    {
      knob: 'Per-plugin injection scope',
      status: 'upstream-pending',
      gap: 'G4',
      note: 'Plugins register statically in the profile; no plugin/set-injection-scope method yet.',
    },
  ]
}

// Dual export shape — mirrors context-rail.js / event-filter.js so tests
// can require() it and the renderer can pick it up off the global.
// The friendly public key is `RECALL_TOOL_NAMES` even though the internal
// binding uses the CONTEXT_PAGE_ prefix; the prefix exists only to avoid
// a top-level `const` collision with renderer.js (same reason context-rail.js
// keeps a `RAIL_` prefix).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    projectTurnRows,
    buildInjectionRoster,
    summarizeCompactPolicy,
    summarizeRecallConfig,
    computeBudgetSparkline,
    serializeProfileYAML,
    capabilitiesLegend,
    pluginOf,
    RECALL_TOOL_NAMES: CONTEXT_PAGE_RECALL_TOOL_NAMES,
  }
}
if (typeof window !== 'undefined') {
  window.__dshContextPageModel = {
    projectTurnRows,
    buildInjectionRoster,
    summarizeCompactPolicy,
    summarizeRecallConfig,
    computeBudgetSparkline,
    serializeProfileYAML,
    capabilitiesLegend,
    pluginOf,
    RECALL_TOOL_NAMES: CONTEXT_PAGE_RECALL_TOOL_NAMES,
  }
}
