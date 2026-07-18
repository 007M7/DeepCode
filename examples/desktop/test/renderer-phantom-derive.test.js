// Ticket B (task #124) — renderer-side derivation of formerly-phantom
// header fields. Each E-class field must be filled from wire events into
// `state.sessions.get(id)` shell meta so pure modules (session-tree.js,
// session-tree-page.js) can read one authoritative source, and rows
// classify correctly on real daemons that never ship the phantom.
//
// Fields covered:
//   B-2 awaitingApproval  — set on approval-interrupt arrival, cleared on
//                           resolution/invalidate.
//   B-4 lastError         — set on SessionFinishedNotification with
//                           status:'error' and reason.kind !== 'ok';
//                           cleared on next turn/start.
//   B-5 cancelled variant — same field; kind:'cancelled' still counts as
//                           interrupted (merges the old header.interrupted
//                           alias with the error path).
//
// Fixtures follow the wire shapes verbatim (see packages/ui/jsonrpc/src/
// protocol.ts:418-517 for InterruptRequest / SessionFinishedNotification)
// so a future adapter refactor doesn't quietly diverge from what the
// shell reduces against.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

// -- B-2 awaitingApproval derivation ----------------------------------------

test('B-2: approval interrupt sets meta.awaitingApproval=true on the target session', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-approve', { title: 'sess', header: {} })
  await renderer.selectSession('s-approve')
  assert.equal(renderer.getSessionMeta('s-approve').awaitingApproval, undefined,
    'meta starts clean — no phantom leak from ensureSession seed')

  // Wire shape per protocol.ts:453-517 — InterruptRequest with
  // `spec.kind === 'approval'` and `spec.spec.toolCallId + options[]`.
  listeners.onInterruptIncoming({
    interruptId: 'int-1',
    sessionId: 's-approve',
    kind: 'approval',
    spec: {
      toolCallId: 'call-77',
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    },
  })
  assert.equal(renderer.getSessionMeta('s-approve').awaitingApproval, true,
    'approval interrupt arrival must derive the meta flag')
})

test('B-2: form interrupt does NOT set awaitingApproval (that flag is approval-specific)', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-form', { title: 'sess', header: {} })
  await renderer.selectSession('s-form')
  listeners.onInterruptIncoming({
    interruptId: 'int-form-1',
    sessionId: 's-form',
    kind: 'form',
    spec: { title: 'Answer this', fields: [{ id: 'q', kind: 'text', label: 'Q?' }] },
  })
  assert.notEqual(renderer.getSessionMeta('s-form').awaitingApproval, true,
    'form-kind interrupts are a separate affordance; awaitingApproval is only for tool-call approvals')
})

test('B-2: interrupt invalidation clears meta.awaitingApproval', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-i', { title: 'sess', header: {} })
  await renderer.selectSession('s-i')
  listeners.onInterruptIncoming({
    interruptId: 'int-invalidate',
    sessionId: 's-i',
    kind: 'approval',
    spec: { toolCallId: 'call-1', options: [{ optionId: 'x', kind: 'allow_once', name: 'x' }] },
  })
  assert.equal(renderer.getSessionMeta('s-i').awaitingApproval, true)
  // Wire: `interrupt/invalidate` fires when the runtime crashes or the
  // turn ends without an answer (protocol.ts:502-517-ish). Clears our
  // derived flag.
  listeners.onInterruptInvalidate({ interruptId: 'int-invalidate', reason: 'runtime disconnected' })
  assert.notEqual(renderer.getSessionMeta('s-i').awaitingApproval, true,
    'invalidation must clear the derived flag or a resolved-then-invalidated card stays "waiting" forever')
})

// -- B-4/B-5 lastError derivation from SessionFinishedNotification -----------

test('B-4: session.finished status:error stores TurnEndReason in meta.lastError', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-err', { title: 'sess', header: {} })
  // Wire shape (protocol.ts:430-434 + types.ts:94-120): SessionFinished
  // notification carries `{ sessionId, status: 'error', reason: TurnEndReason }`.
  listeners.onNotify({
    method: 'session.finished',
    params: {
      sessionId: 's-err',
      status: 'error',
      reason: { kind: 'error', message: 'model returned 429' },
    },
  })
  const meta = renderer.getSessionMeta('s-err')
  assert.ok(meta.lastError, 'lastError must be derived and stored on meta')
  assert.equal(meta.lastError.kind, 'error')
  assert.equal(meta.lastError.message, 'model returned 429')
})

test('B-5: session.finished with reason kind:cancelled also lands in meta.lastError', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-cancel', { title: 'sess', header: {} })
  listeners.onNotify({
    method: 'session.finished',
    params: {
      sessionId: 's-cancel',
      status: 'error',
      reason: { kind: 'cancelled', reason: 'user_cancelled' },
    },
  })
  const meta = renderer.getSessionMeta('s-cancel')
  assert.ok(meta.lastError, 'cancelled counts as an interruption for classifySessionShape purposes')
  assert.equal(meta.lastError.kind, 'cancelled')
})

test('B-4: session.finished status:ok does not set lastError (successful finish)', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-ok', { title: 'sess', header: {} })
  listeners.onNotify({
    method: 'session.finished',
    params: {
      sessionId: 's-ok',
      status: 'ok',
      reason: { kind: 'ok' },
    },
  })
  const meta = renderer.getSessionMeta('s-ok')
  assert.notEqual(meta.lastError && meta.lastError.kind && meta.lastError.kind !== 'ok', true,
    'a clean finish must not paint the row as interrupted')
})

test('B-4: turn/start clears a prior meta.lastError so a new turn resets the shape', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-rerun', { title: 'sess', header: {} })
  await renderer.selectSession('s-rerun')
  // First turn errors out.
  listeners.onNotify({
    method: 'session.finished',
    params: {
      sessionId: 's-rerun',
      status: 'error',
      reason: { kind: 'error', message: 'boom' },
    },
  })
  assert.equal(renderer.getSessionMeta('s-rerun').lastError.kind, 'error')
  // User re-runs; the next turn starts. The interrupted glyph should fall
  // off the row — the new turn hasn't errored yet.
  renderer.onSessionEvent('s-rerun', { type: 'turn/start', seq: 1 })
  const cleared = renderer.getSessionMeta('s-rerun').lastError
  assert.ok(!cleared || cleared.kind === 'ok',
    'turn/start must clear lastError so the row stops showing ✕ during a fresh attempt')
})

// -- meta values surface through enrichEntry so pure modules see them -------

test('enrichEntry surfaces meta.awaitingApproval + meta.lastError onto entry.meta for classifiers', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s-enrich', { title: 'sess', header: {} })
  listeners.onInterruptIncoming({
    interruptId: 'int-e',
    sessionId: 's-enrich',
    kind: 'approval',
    spec: { toolCallId: 'c-1', options: [{ optionId: 'a', kind: 'allow_once', name: 'a' }] },
  })
  listeners.onNotify({
    method: 'session.finished',
    params: {
      sessionId: 's-enrich',
      status: 'error',
      reason: { kind: 'cancelled' },
    },
  })
  const wireLike = {
    sessionId: 's-enrich',
    header: { version: 0, id: 's-enrich', createdAt: 0 },
    live: true,
    persisted: false,
  }
  const enriched = renderer.enrichEntry(wireLike)
  // classifySessionShape needs `entry.meta.lastError` (not entry.header).
  // enrichEntry is the bridge — it takes the raw wire entry and layers on
  // the shell-derived meta so pure modules stay pure.
  assert.ok(enriched.meta, 'enrichEntry must expose meta so classifySessionShape reads it')
  assert.equal(enriched.meta.awaitingApproval, true)
  assert.equal(enriched.meta.lastError && enriched.meta.lastError.kind, 'cancelled')
})
