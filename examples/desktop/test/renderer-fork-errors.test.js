// Tests for P0-4: Fork button error-code classification + inflight-turn gating.
//
// The wire strips SessionForkError.code down to a JSON-RPC -32603 error whose
// `message` is preserved verbatim from packages/core/session/src/index.ts. The
// renderer classifies that message back into one of the four kernel codes so
// the system line can speak in replay-boundary language instead of raw error
// text.
//
// Intent red-line (2026-07-16 team-lead): fork wording NEVER says
// "copy" / "snapshot" / "duplicate current state" — a fork is a deterministic
// replay from a closed-turn boundary. The classifier's `humanMessage` field
// carries the user-facing phrasing and is asserted below.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

test('classifyForkError → OPEN_TURN when message names an unclosed turn', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  const raw = new Error('fork boundary 12 in session "abc" must be turn/end, got assistant/message')
  const c = classifyForkError(raw)
  assert.equal(c.code, 'OPEN_TURN')
  // Human message stays in replay language — never "copy" / "snapshot".
  assert.match(c.humanMessage, /closed[\s-]turn/i)
  assert.doesNotMatch(c.humanMessage, /\b(copy|snapshot|duplicate)\b/i)
})

test('classifyForkError → INVALID_BOUNDARY for the three boundary-shape phrases', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  const phrases = [
    'fork boundary for session "x" must be a non-negative safe integer, got NaN',
    'fork boundary 999 does not exist in session "x" (last seq: 42)',
    'fork boundary 5 does not match a contiguous event seq in session "x"',
  ]
  for (const p of phrases) {
    const c = classifyForkError(new Error(p))
    assert.equal(c.code, 'INVALID_BOUNDARY', p)
  }
})

test('classifyForkError → SESSION_NOT_LIVE / SESSION_NOT_FOUND / SESSION_ALREADY_EXISTS', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  assert.equal(
    classifyForkError(new Error('session "abc" is not the live store instance')).code,
    'SESSION_NOT_LIVE',
  )
  assert.equal(
    classifyForkError(new Error('session "abc" not found')).code,
    'SESSION_NOT_FOUND',
  )
  assert.equal(
    classifyForkError(new Error('session "abc-fork-1" already exists')).code,
    'SESSION_ALREADY_EXISTS',
  )
})

test('classifyForkError → UNKNOWN when the message is not recognized', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  const c = classifyForkError(new Error('something completely different'))
  assert.equal(c.code, 'UNKNOWN')
  // Falls through to the raw message so we don't lose diagnostic content.
  assert.match(c.humanMessage, /something completely different/)
})

test('classifyForkError prefers explicit code on the error object over message parsing', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  // If main.js pre-classified and stuck the code on the object, honor it.
  const err = new Error('opaque wrapped message')
  err.code = 'OPEN_TURN'
  const c = classifyForkError(err)
  assert.equal(c.code, 'OPEN_TURN')
})

test('classifyForkError handles thrown strings and undefined', async () => {
  const { window } = await loadRenderer()
  const { classifyForkError } = window.__dshRenderer
  assert.equal(classifyForkError(undefined).code, 'UNKNOWN')
  assert.equal(classifyForkError(null).code, 'UNKNOWN')
  assert.equal(classifyForkError('OPEN_TURN somehow').code, 'UNKNOWN')
})

test('fork button is disabled + tooltip explains replay boundary when a turn is in flight', async () => {
  const { renderer, window } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  // Start a turn so inflightTurn flips true, then append an assistant bubble
  // so a fork button gets attached to it.
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  renderer.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: { content: 'hi' } })
  const bubbles = window.document.querySelectorAll('.msg.assistant')
  assert.ok(bubbles.length >= 1, 'expected an assistant bubble in the stream')
  const btn = bubbles[0].querySelector('.fork-here')
  assert.ok(btn, 'expected a fork-here button on the assistant bubble')
  renderer.updateForkButtons()
  assert.equal(btn.disabled, true)
  assert.match(btn.title, /replay/i)
  assert.match(btn.title, /closed[\s-]turn|current turn to (?:end|finish)/i)
  assert.doesNotMatch(btn.title, /\b(copy|snapshot|duplicate)\b/i)
})

test('fork button re-enables + swaps tooltip back to boundary preview when the turn ends', async () => {
  const { renderer, window } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  renderer.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: { content: 'hi' } })
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 3 })
  renderer.updateForkButtons()
  const btn = window.document.querySelectorAll('.msg.assistant')[0].querySelector('.fork-here')
  assert.equal(btn.disabled, false)
  // Boundary-preview tooltip mentions the seq (turn/end re-stamped
  // data-fork-seq); still no "copy" language.
  assert.match(btn.title, /seq 3|turn boundary|replay/i)
  assert.doesNotMatch(btn.title, /\b(copy|snapshot|duplicate)\b/i)
})
