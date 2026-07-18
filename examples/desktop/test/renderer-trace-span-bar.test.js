// Task #215 — span-tree inline waterfall.
// Verifies that a `tool/call` paired with its `tool/result` (same callId)
// renders a real start→end SPAN inside its trace-event-row: the .trace-event-bar
// carries both a non-zero `margin-left` (start offset) and a non-zero `width`
// (span duration), each proportional to the step baseline.
//
// The point-event fallback (assistant/message with no _pairEndTime) is already
// covered by renderer-trace-langsmith-visuals — this file specifically covers
// the span path added for #215 so hover start/end/duration and the tool-band
// waterfall grammar don't regress silently.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { loadRenderer } = require('./renderer-harness.js')

function play(renderer, sid, events) {
  for (const ev of events) renderer.onSessionEvent(sid, ev)
}

// step: 1000ms wide.  tool/call at t=1200 (20%), tool/result at t=1800 (80%).
// Expected span: margin-left ≈ 20%, width ≈ 60%.
function makeToolSpanStream() {
  return [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1200, type: 'tool/call', data: {
      callId: 'c1', tool: 'read', arguments: { path: 'x.ts' },
    } },
    { seq: 3, time: 1800, type: 'tool/result', data: {
      callId: 'c1', result: 'ok',
    } },
    { seq: 4, time: 2000, type: 'step/end', data: {} },
  ]
}

test('paired tool/call renders start→end span in trace-event-row (task #215)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-span', { title: 't', header: {} })
  await renderer.selectSession('s-span')
  play(renderer, 's-span', makeToolSpanStream())

  // Look for at least one .trace-event-bar-span (only paired rows emit it).
  const spans = document.querySelectorAll('.trace-event-bar-span')
  assert.ok(spans.length >= 1, `expected ≥1 span bar, got ${spans.length}`)

  // The paired tool/call bar should sit around 20% left / 60% width.
  let sawShape = false
  for (const s of spans) {
    const ml = parseFloat(String(s.style && s.style.marginLeft || '0'))
    const w = parseFloat(String(s.style && s.style.width || '0'))
    if (!Number.isFinite(ml) || !Number.isFinite(w)) continue
    if (ml >= 10 && ml <= 30 && w >= 50 && w <= 70) { sawShape = true; break }
  }
  assert.ok(sawShape, 'expected a span with margin-left~20% & width~60%')
})

test('paired tool bar carries start/end/duration hover title', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-hover', { title: 't', header: {} })
  await renderer.selectSession('s-hover')
  play(renderer, 's-hover', makeToolSpanStream())

  const tracks = document.querySelectorAll('.trace-event-bar-track')
  let sawSpanTitle = false
  for (const tr of tracks) {
    const title = String(tr.title || '')
    if (/start \+\d+ms · end \+\d+ms · duration \d+ms/.test(title)) {
      sawSpanTitle = true; break
    }
  }
  assert.ok(sawSpanTitle,
    'expected a bar with `start +Xms · end +Yms · duration Zms` title')
})
