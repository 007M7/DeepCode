// Unit tests for tracing-index-model.js — the pure projection powering the
// Tracing page's L0 project-runs table (#225).
//
// The interesting shape of these tests is that they lock the *algorithms*
// on fabricated event streams, not the DOM. The controller (tracing-page.js)
// wires these to real cachedEvents.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/tracing-index-model.js')

// Cheap fixture factory — one round-trip is (user, step/start, request/header,
// [assistant/message with usage], (tool/call + tool/result)*, assistant/message,
// step/end, turn/end). durationMs and isError are the interesting knobs.
function turn({ dMs = 100, tools = [], model = 'deepseek-chat', usage = null, time = 0 } = {}) {
  const evs = []
  const t = time
  evs.push({ type: 'user/message', time: t, seq: 1, data: { content: [] } })
  evs.push({ type: 'step/start', time: t + 1, seq: 2, data: { step: 0, turn: 0 } })
  if (model) evs.push({ type: 'request/header', time: t + 2, seq: 3, data: { model } })
  const u = usage || { inputTokens: 100, outputTokens: 50 }
  evs.push({
    type: 'assistant/message', time: t + 3, seq: 4,
    data: { content: [{ type: 'text', text: 'ok' }], usage: u },
  })
  for (const tr of tools) {
    evs.push({ type: 'tool/call', time: t + 4, seq: 5, data: { name: 'read', callId: 'c1' } })
    evs.push({
      type: 'tool/result', time: t + 5, seq: 6,
      data: { callId: 'c1', content: [], isError: !!tr.err, meta: { durationMs: 10 } },
    })
  }
  evs.push({ type: 'step/end', time: t + 1 + dMs, seq: 7, data: { step: 0, turn: 0 } })
  evs.push({ type: 'turn/end', time: t + 2 + dMs, seq: 8, data: {} })
  return evs
}

// --- Trace count -----------------------------------------------------------

test('countTraces counts turn/end events, not turn/start', () => {
  const evs = [
    ...turn({ dMs: 50 }),
    ...turn({ dMs: 60, time: 1000 }),
    ...turn({ dMs: 70, time: 2000 }),
  ]
  assert.equal(M.countTraces(evs), 3)
})

test('countTraces returns 0 on empty or non-array', () => {
  assert.equal(M.countTraces([]), 0)
  assert.equal(M.countTraces(null), 0)
  assert.equal(M.countTraces(undefined), 0)
})

// --- Error rate ------------------------------------------------------------

test('errorRate: 1 error out of 4 tool/result -> 0.25', () => {
  const evs = [
    ...turn({ tools: [{ err: true }] }),
    ...turn({ tools: [{ err: false }], time: 1000 }),
    ...turn({ tools: [{ err: false }, { err: false }], time: 2000 }),
  ]
  assert.equal(M.errorRate(evs), 0.25)
})

test('errorRate returns null when no tool/result events (missing data, not 0%)', () => {
  const evs = turn({ tools: [] })
  assert.equal(M.errorRate(evs), null)
})

test('errorRate honours legacy data.meta.isError (older wire)', () => {
  const evs = [
    { type: 'tool/result', data: { isError: false, meta: {} } },
    { type: 'tool/result', data: { meta: { isError: true } } },   // legacy shape
  ]
  assert.equal(M.errorRate(evs), 0.5)
})

// --- Percentiles -----------------------------------------------------------

test('percentile: linear interpolation matches numpy type-7 defaults', () => {
  // sorted [1, 2, 3, 4] -> p50 = 2.5 (midpoint), p99 = 3.97
  const vs = [4, 1, 3, 2]
  assert.equal(M.percentile(vs, 0.5), 2.5)
  assert.ok(Math.abs(M.percentile(vs, 0.99) - 3.97) < 1e-9)
})

test('percentile: single-sample returns that sample verbatim', () => {
  assert.equal(M.percentile([42], 0.5), 42)
  assert.equal(M.percentile([42], 0.99), 42)
})

test('percentile: empty list -> null (never fabricate a 0)', () => {
  assert.equal(M.percentile([], 0.5), null)
  assert.equal(M.percentile(null, 0.5), null)
})

test('percentile: q out of [0,1] -> null', () => {
  assert.equal(M.percentile([1, 2, 3], -0.1), null)
  assert.equal(M.percentile([1, 2, 3], 1.1), null)
})

// --- Step durations --------------------------------------------------------

test('stepDurationsMs pulls durationMs from aggregated step records', () => {
  const evs = [
    ...turn({ dMs: 100 }),
    ...turn({ dMs: 250, time: 1000 }),
    ...turn({ dMs: 40, time: 2000 }),
  ]
  const ds = M.stepDurationsMs(evs)
  ds.sort((a, b) => a - b)
  assert.deepEqual(ds, [40, 100, 250])
})

// --- Total tokens ----------------------------------------------------------

test('totalTokens flattens every usage field across every assistant/message', () => {
  const evs = [
    ...turn({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 } }),
    ...turn({ usage: { inputTokens: 200, outputTokens: 50, reasoningTokens: 15 }, time: 1000 }),
  ]
  // 100+20+30 + 200+50+15 = 415
  assert.equal(M.totalTokens(evs), 415)
})

test('totalTokens returns null when no assistant/message carries usage', () => {
  const evs = [{ type: 'user/message', data: { content: [] } }]
  assert.equal(M.totalTokens(evs), null)
})

// --- Last model ------------------------------------------------------------

test('lastModel prefers the last request/header data.model in wire order', () => {
  const evs = [
    { type: 'request/header', data: { model: 'deepseek-chat' } },
    { type: 'request/header', data: { model: 'claude-fable-5' } },
  ]
  assert.equal(M.lastModel(evs), 'claude-fable-5')
})

test('lastModel returns null if no request/header ships a model', () => {
  const evs = [{ type: 'request/header', data: {} }]
  assert.equal(M.lastModel(evs), null)
})

test('lastModel accepts data.header.model for legacy fixtures', () => {
  const evs = [{ type: 'request/header', data: { header: { model: 'legacy-x' } } }]
  assert.equal(M.lastModel(evs), 'legacy-x')
})

// --- Total cost ------------------------------------------------------------

test('totalCost sums usage and applies priceTable', () => {
  const evs = [
    ...turn({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, model: 'deepseek-chat' }),
  ]
  const pt = { pricing: { 'deepseek-chat': { input: 0.14, output: 0.28 } } }
  // 1M * 0.14 + 1M * 0.28 = 0.14 + 0.28 = 0.42
  assert.ok(Math.abs(M.totalCost(evs, pt) - 0.42) < 1e-9)
})

test('totalCost returns null when model missing from priceTable', () => {
  const evs = turn({ model: 'gpt-x', usage: { inputTokens: 100, outputTokens: 100 } })
  const pt = { pricing: { 'deepseek-chat': { input: 0.14, output: 0.28 } } }
  assert.equal(M.totalCost(evs, pt), null)
})

// --- Most recent time ------------------------------------------------------

test('mostRecentTime takes max event.time', () => {
  const evs = [
    { type: 'user/message', time: 1000 },
    { type: 'assistant/message', time: 3000 },
    { type: 'tool/call', time: 2000 },
  ]
  assert.equal(M.mostRecentTime(evs), 3000)
})

test('mostRecentTime falls back to meta.lastEventTime when events empty', () => {
  assert.equal(M.mostRecentTime([], { lastEventTime: 5000 }), 5000)
  assert.equal(M.mostRecentTime([], {}), null)
})

// --- projectRow / projectSessionRows ---------------------------------------

test('projectRow assembles all columns; missing data resolves to null', () => {
  const s = {
    id: 'sess-1', title: 'exploration',
    events: [
      ...turn({ dMs: 100, tools: [{ err: true }] }),
      ...turn({ dMs: 200, tools: [{ err: false }], time: 1000 }),
    ],
  }
  const pt = { pricing: { 'deepseek-chat': { input: 0.14, output: 0.28 } } }
  const row = M.projectRow(s, { priceTable: pt })
  assert.equal(row.id, 'sess-1')
  assert.equal(row.name, 'exploration')
  assert.equal(row.traceCount, 2)
  assert.equal(row.errorRate, 0.5)
  assert.equal(row.p50Ms, 150)
  assert.equal(row.model, 'deepseek-chat')
  assert.ok(typeof row.totalTokens === 'number' && row.totalTokens > 0)
  assert.ok(typeof row.totalCost === 'number' && row.totalCost > 0)
})

test('projectRow on empty session: everything derivable is null except traceCount:0', () => {
  const row = M.projectRow({ id: 's', title: 'blank', events: [] })
  assert.equal(row.traceCount, 0)
  assert.equal(row.errorRate, null)
  assert.equal(row.p50Ms, null)
  assert.equal(row.p99Ms, null)
  assert.equal(row.totalTokens, null)
  assert.equal(row.totalCost, null)
  assert.equal(row.model, null)
  assert.equal(row.mostRecentTime, null)
})

test('projectSessionRows preserves input order and skips id-less entries', () => {
  const rows = M.projectSessionRows([
    { id: 'a', title: 'A', events: [] },
    { title: 'noid', events: [] },
    { id: 'b', title: 'B', events: [] },
  ])
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b'])
})

// Field §3 P0 #5 (2026-07-17): projectRow picks SessionHeader.cwd for the
// row hover title. Missing header → cwd:null; string cwd is preserved;
// non-string cwd degrades to null so the controller falls back to the
// bare title without throwing.
test('projectRow: SessionHeader.cwd propagates to row.cwd (§3 P0 #5)', () => {
  const withCwd = M.projectRow({
    id: 'sess-cwd', title: 'run 1',
    header: { cwd: '~/harness/dsh-desktop-demo' },
    events: [],
  })
  assert.equal(withCwd.cwd, '~/harness/dsh-desktop-demo')

  const noHeader = M.projectRow({ id: 'sess-none', title: 'run 2', events: [] })
  assert.equal(noHeader.cwd, null)

  const emptyHeader = M.projectRow({ id: 'sess-empty', title: 'run 3', header: {}, events: [] })
  assert.equal(emptyHeader.cwd, null)

  const badCwd = M.projectRow({ id: 'sess-bad', title: 'run 4', header: { cwd: 42 }, events: [] })
  assert.equal(badCwd.cwd, null, 'non-string cwd falls to null, no throw')
})

// --- filterByName ---------------------------------------------------------

test('filterByName: case-insensitive substring; empty query passes through', () => {
  const rows = [{ name: 'foo' }, { name: 'BAR' }, { name: 'FooBar' }]
  assert.deepEqual(M.filterByName(rows, 'foo').map((r) => r.name), ['foo', 'FooBar'])
  assert.deepEqual(M.filterByName(rows, '').length, 3)
  assert.deepEqual(M.filterByName(rows, '   ').length, 3)
})

// --- Column prefs ---------------------------------------------------------

test('loadColumnPrefs: missing storage key -> all default-visible', () => {
  const stub = { getItem: () => null }
  const prefs = M.loadColumnPrefs(stub)
  for (const c of M.COLUMNS) assert.equal(prefs[c.id], c.defaultVisible)
})

test('loadColumnPrefs: partial JSON keeps defaults for missing ids', () => {
  const stub = { getItem: () => JSON.stringify({ traceCount: false }) }
  const prefs = M.loadColumnPrefs(stub)
  assert.equal(prefs.traceCount, false)
  assert.equal(prefs.name, true)   // untouched -> default
})

test('loadColumnPrefs: corrupt JSON falls through to defaults, not throw', () => {
  const stub = { getItem: () => '{not json' }
  const prefs = M.loadColumnPrefs(stub)
  assert.equal(prefs.name, true)
})

test('saveColumnPrefs writes an object with only known column ids', () => {
  let written = null
  const stub = { setItem: (_k, v) => { written = v } }
  M.saveColumnPrefs(stub, { name: false, bogus: true })
  const parsed = JSON.parse(written)
  assert.equal(parsed.name, false)
  assert.equal('bogus' in parsed, false)
})

// --- Formatters -----------------------------------------------------------

test('formatCell: null -> em dash across every column', () => {
  const row = {
    name: null, mostRecentTime: null, traceCount: null,
    errorRate: null, p50Ms: null, p99Ms: null,
    totalTokens: null, totalCost: null,
  }
  for (const c of M.COLUMNS) assert.equal(M.formatCell(row, c.id), '—')
})

test('formatCell: numeric formatting rules', () => {
  const row = {
    name: 'x', mostRecentTime: null,
    traceCount: 42, errorRate: 0.043,
    p50Ms: 48, p99Ms: 1234,
    totalTokens: 12345, totalCost: 0.0142,
  }
  assert.equal(M.formatCell(row, 'traceCount'), '42')
  assert.equal(M.formatCell(row, 'errorRate'), '4.3%')
  assert.equal(M.formatCell(row, 'p50Ms'), '48ms')
  assert.equal(M.formatCell(row, 'p99Ms'), '1.23s')
  assert.equal(M.formatCell(row, 'totalTokens'), '12345')
  assert.equal(M.formatCell(row, 'totalCost'), '$0.0142')
})

test('formatCell: totalCost >= $1 uses 2-decimal shape', () => {
  assert.equal(M.formatCell({ totalCost: 1.4242 }, 'totalCost'), '$1.42')
})

test('formatTime returns em-dash for junk and short local string otherwise', () => {
  assert.equal(M.formatTime(0), '—')
  assert.equal(M.formatTime(NaN), '—')
  // Preflight (2026-07-18): pre-Y2K positives (fixture-relative times like
  // 1000, 1050 in sample-session.json) must render em-dash, not "12/31/1969".
  assert.equal(M.formatTime(1), '—')
  assert.equal(M.formatTime(1000), '—')
  assert.equal(M.formatTime(946684799999), '—') // one ms before Y2K
  // Ceiling: obviously bogus far-future values also render em-dash.
  assert.equal(M.formatTime(9999999999999), '—')
  const s = M.formatTime(new Date('2026-07-17T14:11:00').getTime())
  // Match "7/17/2026, HH:MM" exact date; hours are local so don't lock them.
  assert.match(s, /^7\/17\/2026, \d\d:\d\d$/)
})
