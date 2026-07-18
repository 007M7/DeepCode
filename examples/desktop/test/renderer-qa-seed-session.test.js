// Round-visual N2 (2026-07-16): `window.__dshQaSeedSession` seam. See
// docs/walkthrough-round-visual.md tail for the discovery: `dsh.newSession()`
// alone leaves `state.activeSessionId === null`, so any fixture that gates on
// an active session (playTraceFixture / onSessionEvent) renders nothing.
// This test locks the seam's DSH_QA gating rule + the newSession → selectSession
// chain so future walkthroughs don't rediscover the two-step dance.
//
// Gating shape:
//   window.dshQa present  →  __dshQaSeedSession must exist and chain properly
//   window.dshQa absent   →  __dshQaSeedSession must NOT be exposed (prod parity)

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

test('__dshQaSeedSession: exposed only when window.dshQa is present (DSH_QA=1 parity)', async () => {
  // Absent dshQa bridge → seam must not exist. This is the production
  // shape — DSH_QA=0 launches never see the seam, matching the same rule
  // that gates window:reveal + window.dshQa itself.
  const { window: prodWindow } = await loadRenderer()
  assert.equal(prodWindow.dshQa, undefined, 'sanity: harness omits dshQa by default')
  assert.equal(typeof prodWindow.__dshQaSeedSession, 'undefined',
    '__dshQaSeedSession must not leak into production renderer')
})

test('__dshQaSeedSession: chains newSession → selectSession and returns the id', async () => {
  // Inject a dshQa bridge before bootUi runs. The harness's default dsh stub
  // returns { id: 'test-session' } from newSession; selectSession is the
  // renderer's own routine (nothing to stub — we observe its side effect).
  const preboot = (windowStub) => { windowStub.dshQa = { revealWindow: async () => ({ ok: true }) } }
  const { window: qaWindow, dsh } = await loadRenderer({}, { preboot })
  assert.equal(typeof qaWindow.__dshQaSeedSession, 'function',
    'seam should be exposed when window.dshQa is present')
  const { id } = await qaWindow.__dshQaSeedSession()
  assert.equal(id, 'test-session', 'seam returns the freshly minted session id')
  // newSession IPC was called exactly once (order-in-calls tolerant so the
  // harness's own boot-time calls don't fail the assertion).
  const newSessionCalls = dsh.__calls.filter((c) => c[0] === 'newSession')
  assert.equal(newSessionCalls.length, 1, 'newSession IPC called exactly once by the seam')
  // After the chain resolves, `getActiveSessionId()` must reflect the new id —
  // that's the whole point of the seam (state.activeSessionId is what
  // playTraceFixture / onSessionEvent gate on).
  assert.equal(qaWindow.__dshChat.getActiveSessionId(), 'test-session',
    'activeSessionId flipped by selectSession — the chain worked')
})
