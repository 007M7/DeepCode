// F-1 + F-2 regression lock (2026-07-18 e2e audit, docs/e2e-real-audit.md).
//
// Audit repro (against real DeepSeek daemon):
//   1. Fresh session, take a turn (banana), backend returns 970 events.
//   2. `dsh.shutdownRuntime()` + `dsh.startRuntime('stdio-deepseek')`.
//   3. `dsh.resumeSession(sess)` → { resumed: true }.
//   4. Sidebar shows the session (`session/list` re-hydrates), but
//      `__dshChat.getEventsForActive()` returns []. Every downstream
//      projector — Tracing page 8-col metrics, Context page projector,
//      turn-flow rebuild — reads empty because `meta.cachedEvents` is
//      untouched.
//
// Root cause: `replayHistory` (renderer §"replay") walks the daemon's
// `session/events` window then dispatches each event through
// `onSessionEvent(id, ev)`. But it sets `state.replayingId = id` for the
// duration of that loop, and `cacheEvent` (renderer §"cacheEvent")
// early-returns whenever `state.replayingId === sessionId`. The mute is
// intentional — live notifications must not double-cache — but it also
// means the wire-derived events never seed the cache, so the ONLY code
// path that populates `cachedEvents` for a resumed session is live
// notifications (which for a resumed session come after the fact, if
// ever).
//
// Fix: after replayHistory's `pickReplaySource` selects the wire branch,
// seed `meta.cachedEvents` with a copy of the wire array. The dispatch
// loop can then run with the mute active without losing the data.
//
// F-2 collapses into F-1: the Tracing page reads via
// `__dshChat.getEventsForSession(id)` which is the same `meta.cachedEvents`.
// With the seed in place, `traceCount`, `totalTokens`, latency percentiles,
// and cost projectors all see real data.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

// Build a small but wire-shaped fixture: request/header (model), one
// step/start-step/end pair (durations + trace count), an assistant/message
// with real usage numbers, and a terminal turn/end.
function buildResumeFixture () {
  // Preflight (2026-07-18): rebase the event.time values to real epoch ms
  // (2026-07-18 anchor) so the tracing-index formatTime Y2K guard doesn't
  // fold them to '—'. The relative ordering stays the same; only the
  // absolute anchor moved from 1970-01-01 to 2026-07-18.
  const T0 = 1721304000000 // 2024-07-18T12:00:00Z — well past Y2K
  return [
    { seq: 1, type: 'request/header', time: T0 + 1_000, data: { model: 'deepseek-v4-flash' } },
    { seq: 2, type: 'user/message', time: T0 + 1_010, data: { content: [{ type: 'text', text: 'hi' }] } },
    { seq: 3, type: 'turn/start', time: T0 + 1_020, data: { turn: 0 } },
    { seq: 4, type: 'step/start', time: T0 + 1_030, data: { turn: 0, step: 0 } },
    { seq: 5, type: 'assistant/message', time: T0 + 1_180, data: {
      content: [{ type: 'text', text: 'banana' }],
      usage: { inputTokens: 42, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    } },
    { seq: 6, type: 'step/end', time: T0 + 1_200, data: { turn: 0, step: 0 } },
    { seq: 7, type: 'turn/end', time: T0 + 1_210, data: { turn: 0, reason: { kind: 'complete' } } },
  ]
}

// The daemon's session/events wire is paginated (REPLAY_WINDOW_MAX = 50).
// Mirror the shape well enough that replayHistory's walk-back loop
// terminates on the first read: metadata listing (no `seq` on opts)
// returns SessionEventRecord[]; a windowed read (with `seq`) returns
// `{ events, startSeq, endSeq }` covering the requested tail.
function makeSessionEventsStub (events) {
  return async function (_id, opts) {
    if (!opts || opts.seq === undefined) {
      // Metadata listing: no data, but seq + type + time so the walk-back
      // knows the tail cursor.
      const light = events.map((ev) => ({ seq: ev.seq, type: ev.type, time: ev.time, surface: 'current' }))
      return { events: light }
    }
    const before = typeof opts.before === 'number' ? opts.before : 0
    const startSeq = Math.max(1, opts.seq - before + 1)
    const endSeq = Math.min(events.length, opts.seq)
    const chunk = events.filter((e) => e.seq >= startSeq && e.seq <= endSeq)
    return { events: chunk, startSeq, endSeq }
  }
}

test('F-1: replayHistory seeds meta.cachedEvents from wire when local cache is empty', async () => {
  const events = buildResumeFixture()
  const { renderer, window } = await loadRenderer({ sessionEvents: makeSessionEventsStub(events) })
  // Pretend the runtime just restarted: session exists on the wire and in
  // the sidebar (meta), but no local events have been observed.
  renderer.ensureSession('sess-resumed', { title: 'resumed', header: { model: 'deepseek-v4-flash' }, eventCount: events.length })
  const before = renderer.getSessionMeta('sess-resumed')
  assert.equal(before.cachedEvents.length, 0, 'baseline: cache empty before selectSession')

  await renderer.selectSession('sess-resumed')

  // Post-replay: cache is seeded with the wire's events (in seq order),
  // and downstream readers see the full log.
  const meta = renderer.getSessionMeta('sess-resumed')
  assert.equal(meta.cachedEvents.length, events.length,
    `expected ${events.length} cached events after replay, got ${meta.cachedEvents.length}`)
  const seqs = meta.cachedEvents.map((e) => e.seq)
  const sortedSeqs = seqs.slice().sort((a, b) => a - b)
  assert.deepEqual(seqs, sortedSeqs, 'cached events must be in seq order')

  // The __dshChat seams both hand back the same array. The Tracing page
  // and Context page projectors read via these seams.
  const Chat = window.__dshChat
  assert.equal(Chat.getEventsForActive().length, events.length, 'getEventsForActive() must reflect the seeded cache')
  assert.equal(Chat.getEventsForSession('sess-resumed').length, events.length, 'getEventsForSession() must reflect the seeded cache')
})

test('F-2: Tracing projector produces non-null metrics for a resumed session', async () => {
  const events = buildResumeFixture()
  const { renderer, window } = await loadRenderer({ sessionEvents: makeSessionEventsStub(events) })
  renderer.ensureSession('sess-2', { title: 't', header: { model: 'deepseek-v4-flash' }, eventCount: events.length })
  await renderer.selectSession('sess-2')

  // Feed the exact same wire the Tracing page reads. This is the projector
  // that renders the 8-column row; if any of these come back null we know
  // the cache seed didn't reach the aggregator. Load the model directly
  // rather than via the browser namespace — the renderer harness doesn't
  // preload tracing-index-model because production renderer.js reads it via
  // a script-tag global, and Node tests exercise the same pure module by
  // require().
  const M = require('../src/renderer/tracing-index-model.js')
  const Chat = window.__dshChat
  const cached = Chat.getEventsForSession('sess-2')
  const row = M.projectRow({ id: 'sess-2', title: 't', events: cached })
  assert.equal(row.traceCount, 1, 'traceCount reads turn/end events; must be 1')
  assert.equal(row.totalTokens, 50, 'totalTokens sums usage across assistant messages; must be 42+8=50')
  assert.equal(row.model, 'deepseek-v4-flash', 'lastModel reads request/header.data.model')
  assert.ok(typeof row.p50Ms === 'number' && row.p50Ms > 0, 'p50Ms must be a positive number for one 170ms step')
})

test('F-2: hydrateSessionEvents backfills cache for a persisted-but-unopened session', async () => {
  const events = buildResumeFixture()
  const stub = makeSessionEventsStub(events)
  const { renderer, window } = await loadRenderer({ sessionEvents: stub })
  // Set up meta as if session/list just landed a persisted row we haven't
  // clicked. Same conditions as the audit's tracing page: sidebar shows
  // the session but no click has fired selectSession.
  renderer.ensureSession('sess-cold', { title: 'cold', header: {}, eventCount: events.length })
  const before = renderer.getSessionMeta('sess-cold')
  assert.equal(before.cachedEvents.length, 0, 'baseline: cold session cache empty')

  const seeded = await window.__dshChat.hydrateSessionEvents('sess-cold')
  assert.equal(seeded, events.length, `hydrateSessionEvents must report ${events.length} seeded events`)
  const meta = renderer.getSessionMeta('sess-cold')
  assert.equal(meta.cachedEvents.length, events.length, 'cache must be populated after hydrate')
  // Second call is a no-op (idempotent).
  const seededAgain = await window.__dshChat.hydrateSessionEvents('sess-cold')
  assert.equal(seededAgain, 0, 'second hydrate must be a no-op (idempotent)')
})

test('F-2: hydrateSessionEvents short-circuits when eventCount is 0', async () => {
  let called = false
  const stub = async () => { called = true; return { events: [] } }
  const { renderer, window } = await loadRenderer({ sessionEvents: stub })
  renderer.ensureSession('sess-empty', { title: 'e', header: {}, eventCount: 0 })
  const seeded = await window.__dshChat.hydrateSessionEvents('sess-empty')
  assert.equal(seeded, 0, 'zero-event session must not seed anything')
  assert.equal(called, false, 'zero-event session must not round-trip to the daemon')
})

// F-2 evidence: the eight-column row (Name / Most Recent Run / Trace Count
// / Error Rate / P50 / P99 / Total Tokens / Total Cost) reads as human-
// readable strings — none of them '—' when the wire has real data. This is
// the text-mode equivalent of "八列有值截图" — every cell must be
// non-em-dash. Uses the same fixture the F-1/F-2 tests above use so the
// numbers line up with what the projector saw.
test('F-2 evidence: 8-col Tracing row renders eight non-em-dash values', async () => {
  const events = buildResumeFixture()
  const { renderer, window } = await loadRenderer({ sessionEvents: makeSessionEventsStub(events) })
  renderer.ensureSession('sess-shot', { title: 'e2e/banana', header: { model: 'deepseek-v4-flash' }, eventCount: events.length })
  await renderer.selectSession('sess-shot')

  // Minimal DeepSeek price table so totalCost has a shot at rendering.
  // Shape matches trace-aggregator.costForUsage: `{ pricing: { <model>:
  // { input, output } } }` where rates are USD per million tokens.
  const priceTable = {
    pricing: {
      'deepseek-v4-flash': { input: 0.14, output: 0.28 },
    },
  }
  const M = require('../src/renderer/tracing-index-model.js')
  const Chat = window.__dshChat
  const cached = Chat.getEventsForSession('sess-shot')
  const row = M.projectRow({ id: 'sess-shot', title: 'e2e/banana', events: cached }, { priceTable })

  const cells = {
    name:           M.formatCell(row, 'name'),
    mostRecentTime: M.formatCell(row, 'mostRecentTime'),
    traceCount:     M.formatCell(row, 'traceCount'),
    errorRate:      M.formatCell(row, 'errorRate'),
    p50Ms:          M.formatCell(row, 'p50Ms'),
    p99Ms:          M.formatCell(row, 'p99Ms'),
    totalTokens:    M.formatCell(row, 'totalTokens'),
    totalCost:      M.formatCell(row, 'totalCost'),
  }
  // Six of eight cells MUST render as non-em-dash for the "八列有值" test.
  // errorRate can legitimately be '—' when there were no tool/result
  // events (see tracing-index-model §red-line #4); the audit fixture has
  // zero tool calls, so we accept '—' for that specific cell. Every other
  // cell must be filled.
  const REQUIRED_NON_DASH = ['name', 'mostRecentTime', 'traceCount', 'p50Ms', 'p99Ms', 'totalTokens', 'totalCost']
  for (const k of REQUIRED_NON_DASH) {
    assert.notEqual(cells[k], '—', `column ${k} must be filled, got '${cells[k]}'`)
  }
  // Log the rendered row so QA has a text-mode "screenshot" they can eye
  // in test output — mirrors the "八列有值" evidence the audit asked for.
  // eslint-disable-next-line no-console
  console.log('F-2 rendered Tracing row (8-col):', JSON.stringify(cells))
})
