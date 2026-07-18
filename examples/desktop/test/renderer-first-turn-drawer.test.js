// F-3 regression lock (2026-07-18 e2e audit, docs/e2e-real-audit.md).
//
// Audit repro:
//   "very first single-step turn on a fresh session had `.turn-flow-glyph`
//   but no `<details>` drawer to open, so the `dsh-open-turn-trace` event
//   fires against no listener."
//
// Root cause: `finishTraceStep(meta, endSeq, endTime)` returns `null` when
// `meta.currentTraceRecord === null`. On a single-step turn the wire
// order is:
//     step/start   → beginTraceStep  (sets currentTraceRecord)
//     step/end     → finishTraceStep (renders card, clears currentTraceRecord)
//     turn/end     → defensive finishTraceStep flush → returns null
// The renderer's turn/end handler passes that null straight to
// `finishTurnContainer({ traceCard })`. The footer builder guards drawer
// construction with `if (traceCard && traceCard.parentNode) { … }`, so
// drawer stays undefined and the `dsh-open-turn-trace` listener never
// attaches. Turn-flow glyph renders regardless (drawn from
// meta.turnSteps, which finishTraceStep populates BEFORE clearing
// currentTraceRecord), so the user sees the glyph with nowhere to click.
//
// Fix: stash the just-emitted trace card on `meta.lastTurnTraceCard` in
// finishTraceStep; the turn/end handler falls back to it when the
// defensive flush returns null. Cleared on turn/start and after
// finishTurnContainer consumes it.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadRenderer } = require('./renderer-harness.js')

// Preboot hook: preload the turn-footer + turn-flow-glyph modules onto
// the window before renderer.js runs. Production loads these via
// script-tag globals; the renderer-harness auto-preload list doesn't
// include them, so finishTurnContainer's `tf` check would come back
// null and the guard would skip building the footer entirely — masking
// the F-3 fix under a different reason. Preload them here so the
// drawer path exercises the same guards the browser sees.
function prebootTurnModules (windowStub) {
  windowStub.__dshTurnFooter = require(path.join(__dirname, '..', 'src', 'renderer', 'turn-footer.js'))
  windowStub.__dshTurnFlowGlyph = require(path.join(__dirname, '..', 'src', 'renderer', 'turn-flow-glyph.js'))
}

// A single-step turn on a fresh session: user prompt, one step/start-end
// pair with one assistant/message, terminal turn/end. This matches the
// audit's minimum repro ("Say banana").
function singleStepTurn () {
  return [
    { seq: 1, type: 'user/message', time: 1_000, data: { content: [{ type: 'text', text: 'Say banana' }] } },
    { seq: 2, type: 'turn/start', time: 1_010, data: { turn: 0 } },
    { seq: 3, type: 'request/header', time: 1_020, data: { model: 'deepseek-v4-flash' } },
    { seq: 4, type: 'step/start', time: 1_030, data: { turn: 0, step: 0 } },
    { seq: 5, type: 'assistant/message', time: 1_180, data: {
      content: [{ type: 'text', text: 'banana' }],
      usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    } },
    { seq: 6, type: 'step/end', time: 1_200, data: { turn: 0, step: 0 } },
    { seq: 7, type: 'turn/end', time: 1_210, data: { turn: 0, reason: { kind: 'complete' } } },
  ]
}

test('F-3: single-step turn attaches trace drawer to the turn footer', async () => {
  const { renderer, document } = await loadRenderer({}, { preboot: prebootTurnModules })
  renderer.ensureSession('sess-first', { title: 'first', header: { model: 'deepseek-v4-flash' } })
  await renderer.selectSession('sess-first')
  for (const ev of singleStepTurn()) renderer.onSessionEvent('sess-first', ev)

  // Assertion 1: the turn container was sealed. On a sealed turn the
  // `assistant-turn` section carries data-turn-status="sealed".
  const stream = document.getElementById('stream')
  const turnSection = stream ? stream.querySelector('.assistant-turn') : null
  assert.ok(turnSection, 'the turn container must exist after turn/end')
  assert.equal(turnSection.dataset.turnStatus, 'sealed', 'turn must be sealed')

  // Assertion 2: the footer carries the trace drawer. Before the fix,
  // the drawer did not build — F-3 was "glyph present, drawer absent"
  // in the real browser. The glyph is SVG (not exercised in this
  // jsdom-less shim); the DOM-level drawer path is what F-3 locks.
  const footer = turnSection.querySelector('.turn-footer')
  assert.ok(footer, 'sealed turn must have a footer')
  const drawer = footer.querySelector('.turn-trace-drawer')
  assert.ok(drawer, 'F-3 fix: turn-trace drawer must be attached under the footer')

  // Assertion 3: meta.lastTurnTraceCard is cleared after finishTurnContainer
  // consumes it, so the NEXT turn can't inherit this one's card.
  const meta = renderer.getSessionMeta('sess-first')
  assert.equal(meta.lastTurnTraceCard, null, 'lastTurnTraceCard must be cleared after turn end')
})

test('F-3: two consecutive turns each get their own drawer, no cross-contamination', async () => {
  const { renderer, document } = await loadRenderer({}, { preboot: prebootTurnModules })
  renderer.ensureSession('sess-two', { title: 'two', header: {} })
  await renderer.selectSession('sess-two')
  for (const ev of singleStepTurn()) renderer.onSessionEvent('sess-two', ev)
  // Second turn: same shape, seqs 8..14. The renderer's own turn/start
  // reset should clear meta.lastTurnTraceCard so the second drawer is
  // built from the second turn's card, not the first's.
  const second = [
    { seq: 8, type: 'user/message', time: 2_000, data: { content: [{ type: 'text', text: 'and pear' }] } },
    { seq: 9, type: 'turn/start', time: 2_010, data: { turn: 1 } },
    { seq: 10, type: 'request/header', time: 2_020, data: { model: 'deepseek-v4-flash' } },
    { seq: 11, type: 'step/start', time: 2_030, data: { turn: 1, step: 0 } },
    { seq: 12, type: 'assistant/message', time: 2_180, data: {
      content: [{ type: 'text', text: 'pear' }],
      usage: { inputTokens: 4, outputTokens: 1 },
    } },
    { seq: 13, type: 'step/end', time: 2_200, data: { turn: 1, step: 0 } },
    { seq: 14, type: 'turn/end', time: 2_210, data: { turn: 1, reason: { kind: 'complete' } } },
  ]
  for (const ev of second) renderer.onSessionEvent('sess-two', ev)

  const stream = document.getElementById('stream')
  const turns = stream ? stream.querySelectorAll('.assistant-turn') : []
  assert.equal(turns.length, 2, 'two sealed turns must render')
  for (const t of turns) {
    const drawer = t.querySelector('.turn-trace-drawer')
    assert.ok(drawer, 'each turn must have its own trace drawer')
  }
})
