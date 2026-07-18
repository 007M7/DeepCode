// Tracing index — pure aggregation for the L0 project-runs table (#225).
//
// LangSmith's project detail view shows one row per session ("root run") with
// scanning columns: Name / Most Recent Run / Trace Count / Error Rate /
// P50 Latency / P99 Latency / Total Tokens / Total Cost (langsmith-tracing-
// study.md §11.1). DSH doesn't have a separate server side for this — every
// number is derivable from the same cachedEvents the Chat pane already
// consumes, so the Tracing page is a pure projection over the existing
// session state (no new IPC).
//
// This module is framework-free and side-effect-free so a `node --test`
// suite can drive it against fixture events without booting the shell. The
// DOM controller (tracing-page.js) consumes projectSessionRows() and reads
// the pricing side through trace-aggregator.costForUsage (loaded via the
// window namespace in the renderer, `require()` under Node).
//
// Design red-lines:
//
//   1. Zero fabrication. If a session has zero step/end records, P50/P99
//      resolve to `null` and the DOM controller renders '—'. Never return
//      a made-up number just because a column expects one — same discipline
//      as context-page-model.js.
//
//   2. Percentiles use the "nearest-rank" method with linear interpolation
//      between adjacent samples (identical to numpy's default 'linear' mode
//      and R's type 7). This is the definition LangSmith / Langfuse
//      surface in their tooltips, so a researcher reading two dashboards
//      side-by-side should see the same numbers off the same wire.
//
//   3. Trace count is `turn/end` event count. In LangSmith terms one
//      "trace" is one top-level agent invocation; in DSH that's one
//      user->assistant round-trip, and turn/end fires exactly once per
//      round (see renderer.js:8 "turn/end → system marker + reset").
//      turn/start alone would also work but turn/end is friendlier to
//      counting because it's emitted after the assistant has settled.
//
//   4. Error rate is tool-call-scoped: (tool/result with isError=true) /
//      (all tool/result). Session-level errors (network failures) don't
//      surface as events today, so a session with zero tool calls returns
//      `null` — the column renders '—', not '0%'. Better honest missing
//      than a misleading zero.
//
//   5. Model is read from the last request/header event's `data.model`.
//      One session may span multiple models if the user switched profiles
//      mid-run; we bias toward "the model this session ended up on" so the
//      cost figure lines up with what the researcher would see if they
//      re-ran the last turn. If no request/header has model, cost is `null`
//      even when usage is non-zero — same '—' render as latency.

'use strict'

// ---------------------------------------------------------------------------
// Node vs renderer bootstrap for trace-aggregator (usage + cost helpers).
// Same shape as context-page-model.js: require() under Node, window
// namespace under the browser. resolveAgg() runs at call time so tests can
// pass a mocked aggregator via projectSessionRows(sessions, {agg}).
// ---------------------------------------------------------------------------

let nodeAgg = null
if (typeof module !== 'undefined' && module.exports) {
  try { nodeAgg = require('./trace-aggregator.js') } catch (_) { nodeAgg = null }
}

function resolveAgg() {
  if (nodeAgg) return nodeAgg
  if (typeof window !== 'undefined' && window.__dshTraceAgg) return window.__dshTraceAgg
  return null
}

// ---------------------------------------------------------------------------
// Column algorithms
// ---------------------------------------------------------------------------

/**
 * Trace count = number of turn/end events. See red-line #3 above.
 */
function countTraces(events) {
  if (!Array.isArray(events)) return 0
  let n = 0
  for (const ev of events) {
    if (ev && ev.type === 'turn/end') n += 1
  }
  return n
}

/**
 * Error rate over tool/result events. Returns null when there are no tool
 * calls at all — the DOM controller renders '—' for null. See red-line #4.
 *
 * The wire records the error bit in two shapes on legacy fixtures:
 *   data.isError === true      (canonical, since #159)
 *   data.meta.isError === true (older daemons before the meta split)
 * Both count as errors so a mixed-history session doesn't silently
 * underreport.
 */
function errorRate(events) {
  if (!Array.isArray(events)) return null
  let total = 0
  let errors = 0
  for (const ev of events) {
    if (!ev || ev.type !== 'tool/result') continue
    total += 1
    const d = ev.data || {}
    const flagged = d.isError === true || (d.meta && d.meta.isError === true)
    if (flagged) errors += 1
  }
  if (total === 0) return null
  return errors / total
}

/**
 * Extract every step record's durationMs. Skips records where the wire
 * side didn't ship both a start_time and end_time (durationMs === null).
 * The aggregator already does this bookkeeping — we just filter its
 * output down to the numeric list the percentile helper wants.
 */
function stepDurationsMs(events, agg) {
  const A = agg || resolveAgg()
  if (!A || typeof A.aggregateSteps !== 'function') return []
  const steps = A.aggregateSteps(events)
  const out = []
  for (const step of steps) {
    if (step && typeof step.durationMs === 'number' && step.durationMs >= 0) {
      out.push(step.durationMs)
    }
  }
  return out
}

/**
 * Percentile (0..1) over a numeric list using the linear-interpolation /
 * type-7 method (numpy default, LangSmith / Langfuse tooltips). Returns
 * `null` on empty input. Non-numeric or negative inputs are filtered by
 * the caller (stepDurationsMs guards that upstream).
 *
 * Algorithm (nearest-rank + linear interp):
 *   sort ascending -> take rank = q * (n - 1) -> lerp between floor and
 *   ceil samples. This is the same rule numpy documents and every
 *   LLM-observability vendor I've verified uses.
 *
 * Named `tracingPercentile` so a bare-name top-level function doesn't
 * collide with `bench-model.js`'s own `percentile` at load time — every
 * renderer script tag lands in one shared global scope. Same discipline
 * as event-filter.js's suffix-when-shared convention.
 */
function tracingPercentile(values, q) {
  if (!Array.isArray(values) || values.length === 0) return null
  if (typeof q !== 'number' || q < 0 || q > 1) return null
  if (values.length === 1) return values[0]
  const sorted = values.slice().sort((a, b) => a - b)
  const rank = q * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  if (low === high) return sorted[low]
  const frac = rank - low
  return sorted[low] * (1 - frac) + sorted[high] * frac
}

/**
 * Total tokens = sum of every usage field across every assistant/message.
 * We flatten inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
 * + reasoningTokens into one integer so the L0 row stays scannable — the
 * per-family split is available at L1 via the existing usage badges.
 *
 * Returns `null` when the session has zero assistant messages carrying
 * usage. A zero-count session with usage:{} returns 0 (real signal, not
 * missing data).
 */
function totalTokens(events, agg) {
  const A = agg || resolveAgg()
  if (!A || typeof A.usageFromMessage !== 'function' || !A.USAGE_KEYS) return null
  let seen = false
  let sum = 0
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue
    const u = A.usageFromMessage(ev)
    if (!u) continue
    seen = true
    for (const k of A.USAGE_KEYS) {
      if (typeof u[k] === 'number') sum += u[k]
    }
  }
  return seen ? sum : null
}

/**
 * Last observed model name (see red-line #5). Reads request/header events
 * in wire order; the *last* one whose data.model is a non-empty string
 * wins. Returns null when no such event was seen — cost falls through
 * to null.
 */
function lastModel(events) {
  if (!Array.isArray(events)) return null
  let last = null
  for (const ev of events) {
    if (!ev || ev.type !== 'request/header') continue
    const d = ev.data || {}
    if (typeof d.model === 'string' && d.model) last = d.model
    // Some legacy fixtures nest model under data.header — accept both.
    const h = d.header
    if (h && typeof h.model === 'string' && h.model) last = h.model
  }
  return last
}

/**
 * Aggregate per-session usage record for cost lookup. Uses the aggregator's
 * addUsage() so the summing rule (null == absent, never == 0) matches every
 * other cost surface. Returns null if no assistant messages carried usage.
 */
function aggregateUsage(events, agg) {
  const A = agg || resolveAgg()
  if (!A || typeof A.usageFromMessage !== 'function') return null
  let acc = null
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue
    const u = A.usageFromMessage(ev)
    if (!u) continue
    acc = acc ? A.addUsage(acc, u) : u
  }
  return acc
}

/**
 * Total cost in USD (number) via trace-aggregator.costForUsage. Returns
 * null when either usage is null OR no model is known OR the model isn't
 * in the price table. That's three distinct sources of '—' the controller
 * can't distinguish, and doesn't need to — the researcher's takeaway is
 * "cost unknown", not "which of three reasons blocked it".
 */
function totalCost(events, priceTable, agg) {
  const A = agg || resolveAgg()
  if (!A || typeof A.costForUsage !== 'function') return null
  const usage = aggregateUsage(events, A)
  if (!usage) return null
  const model = lastModel(events)
  if (!model) return null
  const c = A.costForUsage(usage, priceTable, model)
  if (!c || !c.hasPrice || typeof c.value !== 'number') return null
  return c.value
}

/**
 * Most-recent-run timestamp = max event.time across the session's cached
 * events. Falls back to `meta.lastEventTime` when the events array is
 * empty (a persisted session we haven't opened yet has a lastEventTime
 * from session/list but no cached events until selectSession fires).
 * Returns null when neither is available.
 */
function mostRecentTime(events, meta) {
  let latest = null
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev && typeof ev.time === 'number' && (latest === null || ev.time > latest)) {
        latest = ev.time
      }
    }
  }
  if (latest === null && meta && typeof meta.lastEventTime === 'number' && meta.lastEventTime > 0) {
    latest = meta.lastEventTime
  }
  return latest
}

/**
 * Project one session -> one row. `session` shape mirrors the objects
 * __dshChat.getSessions() emits (id + title + meta bits) plus `events`,
 * the cachedEvents array. The controller reads `getEventsForActive()` for
 * the current session and reaches into `state.sessions.get(id).cachedEvents`
 * for the rest — that reach is the shell's, not the model's.
 *
 * Missing-data policy: every metric that can't be computed comes back as
 * `null`. The controller renders '—' for null. Never confuse `0` with
 * missing — `errorRate === 0` means "zero errors observed", `errorRate ===
 * null` means "no tool calls at all".
 */
function projectRow(session, options) {
  const opts = options || {}
  const agg = opts.agg || resolveAgg()
  const priceTable = opts.priceTable || null
  const events = Array.isArray(session && session.events) ? session.events : []
  const meta = (session && session.meta) || {}

  const name = (session && (session.title || session.name)) || (session && session.id) || ''
  const durations = stepDurationsMs(events, agg)
  // Field §3 P0 #5 (2026-07-17): expose SessionHeader.cwd for the row's
  // hover title so a researcher sees "which working directory this session
  // was created in" without opening the drill. `session.header.cwd` comes
  // from SessionHeader; when the
  // session was created via a runtime that didn't set it, cwd is undefined
  // and the row title falls back to a bare label (controller handles the
  // '—' rendering).
  const header = (session && session.header) || null
  const cwd = header && typeof header.cwd === 'string' ? header.cwd : null

  return {
    id: session && session.id,
    name,
    cwd,
    mostRecentTime: mostRecentTime(events, meta),
    traceCount: countTraces(events),
    errorRate: errorRate(events),
    p50Ms: tracingPercentile(durations, 0.5),
    p99Ms: tracingPercentile(durations, 0.99),
    totalTokens: totalTokens(events, agg),
    totalCost: totalCost(events, priceTable, agg),
    model: lastModel(events),
  }
}

/**
 * Project a list of sessions into a rows array. Rows are returned in the
 * caller's input order — the controller sorts / filters. Rows with a
 * missing id are dropped (defensive; shouldn't happen off __dshChat).
 */
function projectSessionRows(sessions, options) {
  if (!Array.isArray(sessions)) return []
  const out = []
  for (const s of sessions) {
    if (!s || !s.id) continue
    out.push(projectRow(s, options))
  }
  return out
}

/**
 * Case-insensitive substring filter over rows by Name column. Empty query
 * -> pass-through. The controller wires this into the header search box
 * with a 100ms debounce (see tracing-page.js).
 */
function filterByName(rows, query) {
  if (!Array.isArray(rows)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return rows.slice()
  return rows.filter((r) => (r.name || '').toLowerCase().includes(q))
}

// ---------------------------------------------------------------------------
// Columns model — visibility state persisted to localStorage (dsh.tracing
// .columns.v1). The list order + labels live here so the DOM controller
// doesn't fork a second copy. `id` matches the row field key exactly so
// renderCell(row, colId) is a one-line lookup.
// ---------------------------------------------------------------------------

const COLUMNS = Object.freeze([
  { id: 'name', label: 'Name', numeric: false, defaultVisible: true },
  { id: 'mostRecentTime', label: 'Most Recent Run', numeric: false, defaultVisible: true },
  { id: 'traceCount', label: 'Trace Count', numeric: true, defaultVisible: true },
  { id: 'errorRate', label: 'Error Rate', numeric: true, defaultVisible: true },
  { id: 'p50Ms', label: 'P50 Latency', numeric: true, defaultVisible: true },
  { id: 'p99Ms', label: 'P99 Latency', numeric: true, defaultVisible: true },
  { id: 'totalTokens', label: 'Total Tokens', numeric: true, defaultVisible: true },
  { id: 'totalCost', label: 'Total Cost', numeric: true, defaultVisible: true },
])

const COLUMNS_STORAGE_KEY = 'dsh.tracing.columns.v1'

/**
 * Load column visibility from a Storage-shaped object. Missing key → all
 * columns visible (the default view). Corrupt / partial JSON → fall back
 * to defaults for any missing id so a new column landing in a later
 * release doesn't come up hidden for existing users.
 */
function loadColumnPrefs(storage) {
  const defaults = {}
  for (const c of COLUMNS) defaults[c.id] = c.defaultVisible
  if (!storage || typeof storage.getItem !== 'function') return defaults
  let raw = null
  try { raw = storage.getItem(COLUMNS_STORAGE_KEY) } catch (_) { raw = null }
  if (!raw) return defaults
  let parsed = null
  try { parsed = JSON.parse(raw) } catch (_) { parsed = null }
  if (!parsed || typeof parsed !== 'object') return defaults
  const out = { ...defaults }
  for (const c of COLUMNS) {
    if (typeof parsed[c.id] === 'boolean') out[c.id] = parsed[c.id]
  }
  return out
}

function saveColumnPrefs(storage, prefs) {
  if (!storage || typeof storage.setItem !== 'function') return
  if (!prefs || typeof prefs !== 'object') return
  const safe = {}
  for (const c of COLUMNS) {
    if (typeof prefs[c.id] === 'boolean') safe[c.id] = prefs[c.id]
  }
  try { storage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(safe)) } catch (_) { /* quota / disabled — degrade silently */ }
}

// ---------------------------------------------------------------------------
// Display formatters. Pure so the DOM controller and its tests exercise
// the same rules.
// ---------------------------------------------------------------------------

/**
 * Format one cell value for a given column. Returns the em-dash '—' for
 * null / undefined. Numbers use tabular-friendly fixed-form:
 *   traceCount   -> integer
 *   errorRate    -> percentage with one decimal ('4.3%')
 *   p50/p99Ms    -> '1.23s' if >= 1000ms else '48ms'
 *   totalTokens  -> integer, no thousands separator (tabular-nums CSS handles alignment)
 *   totalCost    -> '$0.0142' below $1, '$1.42' above (mirrors formatCost)
 *   mostRecentTime -> ISO-derived '7/17/2026, 14:11' short form
 */
function formatCell(row, colId) {
  if (!row) return '—'
  const v = row[colId]
  if (v === null || v === undefined) return '—'
  switch (colId) {
    case 'name':          return String(v)
    case 'mostRecentTime': return formatTime(v)
    case 'traceCount':    return String(v | 0)
    case 'errorRate':     return `${(v * 100).toFixed(1)}%`
    case 'p50Ms':
    case 'p99Ms':         return formatLatencyMs(v)
    case 'totalTokens':   return String(v | 0)
    case 'totalCost':     return formatUsd(v)
    default:              return String(v)
  }
}

function formatLatencyMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function formatUsd(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs < 1) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

/**
 * Short absolute timestamp — 'M/D/YYYY, HH:MM' local. Matches the
 * LangSmith Start Time column (§11.1: '7/17/2026, 2:11…'). We drop the
 * trailing seconds since the row is a scan aid, not a forensic
 * timestamp — the tri-view has the millisecond-precise seq.
 *
 * Preflight (2026-07-18): the earlier `ms <= 0` guard only caught epoch-0
 * itself. Fixtures with relative event.time (e.g. sample-session.json uses
 * `time: 1000, 1050, …` for monotonic ordering) still slipped through and
 * rendered "12/31/1969, 16:00" in PST. Raise the floor to Y2K
 * (2000-01-01 UTC = 946684800000 ms) — anything below that is a
 * fixture-relative timestamp, not a real wall-clock. Ceiling is a
 * defensive upper bound (year 2100) for typos or overflow.
 */
const MIN_REAL_EPOCH_MS = 946684800000 // 2000-01-01T00:00:00Z
const MAX_REAL_EPOCH_MS = 4102444800000 // 2100-01-01T00:00:00Z

function formatTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '—'
  if (ms < MIN_REAL_EPOCH_MS || ms > MAX_REAL_EPOCH_MS) return '—'
  const d = new Date(ms)
  const mo = d.getMonth() + 1
  const day = d.getDate()
  const y = d.getFullYear()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${mo}/${day}/${y}, ${hh}:${mm}`
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    projectRow, projectSessionRows, filterByName,
    countTraces, errorRate, stepDurationsMs, percentile: tracingPercentile,
    totalTokens, totalCost, aggregateUsage, lastModel, mostRecentTime,
    COLUMNS, COLUMNS_STORAGE_KEY, loadColumnPrefs, saveColumnPrefs,
    formatCell, formatLatencyMs, formatUsd, formatTime,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTracingIndexModel = {
    projectRow, projectSessionRows, filterByName,
    countTraces, errorRate, stepDurationsMs, percentile: tracingPercentile,
    totalTokens, totalCost, aggregateUsage, lastModel, mostRecentTime,
    COLUMNS, COLUMNS_STORAGE_KEY, loadColumnPrefs, saveColumnPrefs,
    formatCell, formatLatencyMs, formatUsd, formatTime,
  }
}
