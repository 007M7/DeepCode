// Growth v2 — pure model. The renderer (growth-v2.js) uses these helpers
// so we can unit-test the merge/format math without a DOM. Everything here
// takes a `payload` = { compactWindows, installedAt, logPath } as returned
// by the `growth:v2Read` IPC, plus a `userWrites` = { rubrics: {cwId: [entries]},
// errors: {cwId: [entries]} } so tests can drive it without disk I/O.
//
// shape lock:
//   - unit of display = one compact window (time / trigger / compression ratio /
//     shadowed window). Rubrics + errors are child collections merged from
//     BOTH the fixture (seeded evolution story) and the user's own writes on
//     disk.
//   - novice vs researcher mode: this file surfaces enough tags/counts that
//     the DOM layer can decide what to fold; the model itself doesn't hide.

'use strict'

const KIND_TRIGGER = {
  auto: 'auto compact',
  manual: 'user requested',
  threshold: 'threshold hit',
}

function safeArr(x) { return Array.isArray(x) ? x : [] }
function safeObj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {} }

// Merge one compact window with user-written rubrics/errors keyed by cw id.
// Fixture entries come first (chronology), user entries append; both keep
// their `createdAt` for sort inside the DOM if it wants to.
function mergeCompactWindow(cw, userRubrics, userErrors) {
  if (!cw || typeof cw !== 'object') return null
  const rubrics = safeArr(cw.rubrics).concat(safeArr(userRubrics[cw.id]))
  const errors = safeArr(cw.errors).concat(safeArr(userErrors[cw.id]))
  return { ...cw, rubrics, errors }
}

function mergeAll(payload, userWrites) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const uw = safeObj(userWrites)
  const rubrics = safeObj(uw.rubrics)
  const errors = safeObj(uw.errors)
  const wins = safeArr(p.compactWindows).map((cw) => mergeCompactWindow(cw, rubrics, errors)).filter(Boolean)
  return { compactWindows: wins, installedAt: p.installedAt || null, logPath: p.logPath || null }
}

// Compression ratio: what fraction of the shadowed span survived as summary.
// Fixture only carries `shadowedTokenCount` + `summary` (string). Approximate
// summary tokens by chars/4 — good enough for a demo badge, and clearly a
// heuristic so nobody reads it as a metric.
function compressionRatio(cw) {
  if (!cw || !Number.isFinite(cw.shadowedTokenCount) || cw.shadowedTokenCount <= 0) return null
  const summaryChars = typeof cw.summary === 'string' ? cw.summary.length : 0
  const summaryTokens = Math.max(1, Math.round(summaryChars / 4))
  const ratio = summaryTokens / cw.shadowedTokenCount
  return { summaryTokens, ratio }
}

// "28.5k → 0.6k (2.1% survived)" — DOM layer picks how to render.
function formatCompression(cw) {
  const r = compressionRatio(cw)
  if (!r) return ''
  const shad = cw.shadowedTokenCount
  const sur = r.summaryTokens
  return `${shortTokens(shad)} → ${shortTokens(sur)} (${(r.ratio * 100).toFixed(1)}% survived)`
}

function shortTokens(n) {
  if (!Number.isFinite(n)) return '?'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// Shadowed-range badge: "seq 1–240 · 240 events". Fixture uses inclusive
// start/end; if the range is missing we surface an empty string so the DOM
// can hide the badge instead of showing "seq undefined".
function formatShadowedRange(cw) {
  const r = cw && cw.shadowedRange
  if (!r || !Number.isFinite(r.start) || !Number.isFinite(r.end)) return ''
  const count = r.end - r.start + 1
  return `seq ${r.start}–${r.end} · ${count} events`
}

function triggerLabel(kind) {
  if (kind && typeof kind === 'object' && typeof kind.kind === 'string') return KIND_TRIGGER[kind.kind] || kind.kind
  if (typeof kind === 'string') return KIND_TRIGGER[kind] || kind
  return 'compact'
}

// R×N / E×M badge — the sticky-note count that the dispatch calls out.
function badgeCounts(cw) {
  return { rubrics: safeArr(cw && cw.rubrics).length, errors: safeArr(cw && cw.errors).length }
}

// Eval strip — surfaces the "42% → 94%" arc when the fixture (or later, a
// wire-real payload) attaches one. Returns null when nothing to show so the
// DOM can drop the row entirely.
function evalStrip(cw) {
  const ev = cw && cw.eval
  if (!ev || !Number.isFinite(ev.pass) || !Number.isFinite(ev.total)) return null
  const rate = ev.total > 0 ? ev.pass / ev.total : 0
  const prevRate = Number.isFinite(ev.prevPass) && Number.isFinite(ev.prevTotal) && ev.prevTotal > 0
    ? ev.prevPass / ev.prevTotal
    : null
  return {
    name: typeof ev.name === 'string' ? ev.name : 'eval',
    pass: ev.pass,
    total: ev.total,
    rate,
    prevRate,
    improvedFrom: typeof ev.improvedFrom === 'string' ? ev.improvedFrom : (prevRate != null ? `${Math.round(prevRate * 100)}%` : null),
    improvedTo: typeof ev.improvedTo === 'string' ? ev.improvedTo : `${Math.round(rate * 100)}%`,
  }
}

function fmtTime(ts) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? '0' : '') + n
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const growthV2ModelApi = {
  mergeAll,
  mergeCompactWindow,
  compressionRatio,
  formatCompression,
  formatShadowedRange,
  triggerLabel,
  badgeCounts,
  evalStrip,
  fmtTime,
  shortTokens,
}

if (typeof module !== 'undefined' && module.exports) module.exports = growthV2ModelApi
if (typeof window !== 'undefined') window.__dshGrowthV2Model = growthV2ModelApi
