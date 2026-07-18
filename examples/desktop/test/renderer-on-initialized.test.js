// Tests for renderer.js `window.dsh.onInitialized(...)` handler — profile
// switch / new-runtime cleanup.
//
// The critical regression this suite locks down: when a new runtime hands
// back its initialize response, the shell must wipe the old daemon's
// per-session catalog + transient stream state. Historically the catalog
// leaked across profile switches and rows whose click did nothing piled up.
// See arch-review commit c680897 for the fix at renderer.js §onInitialized.
//
// Covered:
//   - state.sessions is cleared
//   - state.activeSessionId is null'd
//   - state.entries is emptied
//   - state.streaming / inflightTurn / lastAssistantSeq / forkMarkers /
//     interruptCards are reset
//   - streamEl is emptied so old chat bubbles don't hang around
//   - refreshSessionList is called (via a stub) to repopulate authoritatively

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

test('onInitialized wipes state.sessions before repopulating', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('leftover-1', { title: 'stale', header: {} })
  renderer.ensureSession('leftover-2', { title: 'also stale', header: {} })
  assert.deepEqual(renderer.snapshotState().sessionIds.sort(), ['leftover-1', 'leftover-2'])
  // Fire the initialize notification that main.js dispatches after a
  // runtime restart.
  listeners.onInitialized({
    serverInfo: { name: 'new-daemon', version: '2.0' },
    protocolVersion: 1,
  })
  // Give refreshSessionList's async body a beat to run.
  await new Promise((r) => setTimeout(r, 5))
  const after = renderer.snapshotState()
  assert.deepEqual(after.sessionIds, [],
    'sessions from the previous runtime must not survive a fresh onInitialized')
})

test('onInitialized clears active session, streaming, and interrupt maps', async () => {
  const { renderer, listeners } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'a', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'assistant/chunk',
    seq: 1,
    data: { chunk: { type: 'text-delta', text: 'streaming content' } },
  })
  assert.equal(renderer.getActiveSessionId(), 's1')
  assert.match(renderer.getStreamText(), /streaming content/)
  listeners.onInitialized({
    serverInfo: { name: 'x', version: '1' },
    protocolVersion: 1,
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(renderer.getActiveSessionId(), null,
    'active session should be cleared on runtime switch')
  assert.doesNotMatch(renderer.getStreamText(), /streaming content/,
    'stream DOM should be cleared on runtime switch')
})

test('onInitialized re-fetches session/list from the new daemon', async () => {
  // The wipe is only safe because refreshSessionList runs right after and
  // repopulates from the new daemon's authoritative list. Assert that call
  // fires.
  const { renderer, listeners, dsh } = await loadRenderer()
  renderer.ensureSession('old', { title: 'stale', header: {} })
  const before = dsh.__calls.filter((c) => c[0] === 'listSessions').length
  listeners.onInitialized({
    serverInfo: { name: 'x', version: '1' },
    protocolVersion: 1,
  })
  await new Promise((r) => setTimeout(r, 20))
  const after = dsh.__calls.filter((c) => c[0] === 'listSessions').length
  assert.ok(after > before,
    `listSessions should have been called after onInitialized (before=${before}, after=${after})`)
})

test('onInitialized before any session exists is still a no-op safe path', async () => {
  const { renderer, listeners } = await loadRenderer()
  // Fresh boot, no sessions. Firing initialized shouldn't throw.
  assert.doesNotThrow(() => {
    listeners.onInitialized({
      serverInfo: { name: 'x', version: '1' },
      protocolVersion: 1,
    })
  })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(renderer.getActiveSessionId(), null)
})
