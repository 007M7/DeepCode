// End-to-end coverage for the compact-card shadowed-events expander
// (task #103 P0-1).
//
// Intent doc (docs/context-fork-intent.md §2.1) calls this out as the demo
// wow point: DSH keeps shadowed events in the log even after they're
// removed from the surface, and the wire tags each event with
// `surface: current|shadowed|log-only`. This UI opens a compact card and
// fans out `session/events(sessionId, {seq})` for each seq the summary
// references. The tests below drive the whole path — compact/summary
// notification → expander DOM → click open → sessionEvents fanout →
// per-seq rows — through the renderer harness.
//
// Verification standards from the intent doc §2.1 P0:
//   1. Card exposes a `View N shadowed events` toggle.
//   2. Opening it renders one row per seq using the wire's readEvent shape.
//   3. If sessionEvents fails or the daemon has no sessionQuery, the
//      body shows an honest fallback line — no white silent void.
//   4. Rows are read-only ghosts — no fork button, no click-to-copy.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

function makeShadowedEventFixture(seq) {
  // Match the readEvent window response shape (packages/ui/jsonrpc/src/server.ts
  // 479-492): `{ sessionId, header, target, events, startSeq, endSeq }`.
  // We only render `events` so the rest can be minimal.
  return {
    sessionId: 'sid',
    events: [
      {
        seq,
        type: seq % 2 === 0 ? 'user/message' : 'assistant/message',
        time: 100 + seq,
        surface: 'shadowed',
        data: {
          content: [{ type: 'text', text: `shadowed body #${seq}` }],
        },
      },
    ],
  }
}

async function bootWithFakeSessionEvents(sessionEventsImpl) {
  return loadRenderer({
    sessionEvents: sessionEventsImpl,
  })
}

test('compact/summary with shadowedSeqs renders a "View N shadowed events" toggle', async () => {
  const { renderer, document } = await bootWithFakeSessionEvents(async () => ({ events: [] }))
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: {
      summary: [{ type: 'text', text: 'sum' }],
      shadowedTokenCount: 100,
      shadowedSeqs: [10, 11, 12],
    },
  })
  const summary = document.querySelector('.shadowed-expander-summary')
  assert.ok(summary, 'expander summary must render')
  assert.match(summary.textContent, /View 3 shadowed events/)
})

test('opening the expander fans out sessionEvents({seq}) once per shadowed seq', async () => {
  const seen = []
  const impl = async (sid, opts) => {
    seen.push({ sid, opts })
    return makeShadowedEventFixture(opts.seq)
  }
  const { renderer, document } = await bootWithFakeSessionEvents(impl)
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [], shadowedTokenCount: 30, shadowedSeqs: [10, 11] },
  })
  const wrap = document.querySelector('.shadowed-expander')
  wrap.open = true
  // Fire the toggle event so the renderer's listener runs. Give it a tick
  // to complete its Promise.all + DOM writes.
  wrap._fire('toggle')
  await new Promise((r) => setTimeout(r, 20))
  const seqCalls = seen.filter((c) => c.opts && typeof c.opts.seq === 'number').map((c) => c.opts.seq)
  assert.deepEqual(seqCalls.sort(), [10, 11], 'one per-seq read per shadowed seq')
  // One row per seq, seq label present.
  const rows = document.querySelectorAll('.shadowed-event')
  assert.equal(rows.length, 2)
  const seqLabels = document.querySelectorAll('.shadowed-event-seq')
  const labelTexts = Array.from(seqLabels).map((n) => n.textContent).sort()
  assert.deepEqual(labelTexts, ['#10', '#11'])
})

test('a per-seq failure downgrades that row without wiping the whole block', async () => {
  const impl = async (_sid, opts) => {
    if (opts.seq === 11) throw new Error('boom')
    return makeShadowedEventFixture(opts.seq)
  }
  const { renderer, document } = await bootWithFakeSessionEvents(impl)
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [], shadowedTokenCount: 30, shadowedSeqs: [10, 11, 12] },
  })
  const wrap = document.querySelector('.shadowed-expander')
  wrap.open = true
  wrap._fire('toggle')
  await new Promise((r) => setTimeout(r, 20))
  // 3 rows: two real, one error placeholder.
  const rows = document.querySelectorAll('.shadowed-event')
  assert.equal(rows.length, 3)
  const errorRow = Array.from(rows).find((r) => r.textContent.includes('error: boom'))
  assert.ok(errorRow, 'the failing seq shows an error placeholder, not silent drop')
})

test('empty per-seq responses (no daemon sessionQuery) show the fallback line', async () => {
  // A daemon without sessionQuery mounted still answers session/events but
  // returns an empty `events` array — no rows to render. Intent doc §2.1
  // P0 verification 2 asks the fallback to name this gap explicitly.
  const impl = async () => ({ events: [] })
  const { renderer, document } = await bootWithFakeSessionEvents(impl)
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [], shadowedTokenCount: 30, shadowedSeqs: [10, 11] },
  })
  const wrap = document.querySelector('.shadowed-expander')
  wrap.open = true
  wrap._fire('toggle')
  await new Promise((r) => setTimeout(r, 20))
  const body = document.querySelector('.shadowed-expander-body')
  assert.match(body.textContent, /Original events unavailable|sessionQuery/i,
    'when no real events came back, the fallback line explains the gap')
  // Two "not found" rows should also be present (partial-fetch strategy),
  // but the fallback message is what turns a silent void into signal.
  const rows = document.querySelectorAll('.shadowed-event')
  assert.equal(rows.length, 0, 'no rows when nothing real; only the fallback text')
})

test('no shadowedSeqs → no expander (nothing to expand)', async () => {
  const { renderer, document } = await bootWithFakeSessionEvents(async () => ({ events: [] }))
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [{ type: 'text', text: 'sum' }], shadowedTokenCount: 0 },
  })
  assert.equal(document.querySelector('.shadowed-expander'), null,
    'no expander when the summary carries no shadowedSeqs')
})

test('read-only ghost — rows carry no fork button and no click affordance', async () => {
  const impl = async (_sid, opts) => makeShadowedEventFixture(opts.seq)
  const { renderer, document } = await bootWithFakeSessionEvents(impl)
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [], shadowedTokenCount: 10, shadowedSeqs: [10] },
  })
  const wrap = document.querySelector('.shadowed-expander')
  wrap.open = true
  wrap._fire('toggle')
  await new Promise((r) => setTimeout(r, 20))
  const row = document.querySelector('.shadowed-event')
  assert.ok(row, 'row rendered')
  // Intent doc red-line: no fork button, no copy affordance, no click
  // handler that could be mistaken for a live action. The renderer never
  // adds a `.fork-here` inside a shadowed row.
  assert.equal(row.querySelector('.fork-here'), null)
  // The row's registered listeners must be empty (nothing bound).
  assert.equal((row._listeners.click || []).length, 0, 'no click listener bound')
})

test('bridge missing (window.dsh.sessionEvents undefined) shows an error line', async () => {
  // Override the harness stub to delete the bridge before rendering.
  const { renderer, dsh, document } = await loadRenderer()
  dsh.sessionEvents = undefined
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  renderer.onSessionEvent('sid', {
    type: 'compact/summary', seq: 20, time: 1,
    data: { summary: [], shadowedTokenCount: 10, shadowedSeqs: [10] },
  })
  const wrap = document.querySelector('.shadowed-expander')
  wrap.open = true
  wrap._fire('toggle')
  await new Promise((r) => setTimeout(r, 20))
  const body = document.querySelector('.shadowed-expander-body')
  assert.match(body.textContent, /runtime bridge missing/)
})
