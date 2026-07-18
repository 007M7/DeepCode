// Pure normalizer for inbound `session/interrupt` requests. Extracted from
// main.js so test/interrupt-normalize.test.js can exercise it without booting
// Electron. Canonical wire shape (protocol v2, per impl-interact and
//
//   { sessionId, interruptId, payload: { kind:'approval'|'form', spec:{...} } }
//
// An earlier draft placed the discriminant at `request.spec.kind`; that
// branch is dead — the bridge only emits `payload.kind`. Anything else is
// answered fail-closed with `{outcome:'cancelled'}`.

'use strict'

const crypto = require('node:crypto')

/**
 * Normalize a `session/interrupt` request into the shell's interrupt-card
 * form and register a resolver in `pending`. If the shape is recognized,
 * returns a Promise the caller resolves via IPC after the user answers;
 * otherwise returns `{outcome:'cancelled'}` synchronously.
 *
 * @param {object} request  raw JSON-RPC params from the runtime
 * @param {Map} pending     interruptId -> {resolve, sessionId}
 * @param {(channel:string, payload:object)=>void} sendFn
 *   IPC sender; called as `sendFn('interrupt:incoming', {...})` when the
 *   request is dispatched to the renderer.
 */
function normalizeInterruptRequest(request, pending, sendFn) {
  const sessionId = request && request.sessionId
  const interruptId = request && request.interruptId
    ? request.interruptId
    : `int-${crypto.randomUUID()}`
  const payload = request && request.payload
  if (!payload || typeof payload !== 'object' || !payload.kind) {
    return { outcome: 'cancelled' }
  }
  const kind = payload.kind
  const spec = payload.spec || {}
  if (kind !== 'approval' && kind !== 'form') return { outcome: 'cancelled' }
  const promise = new Promise((resolve) => {
    pending.set(interruptId, { resolve, sessionId })
  })
  sendFn('interrupt:incoming', { interruptId, sessionId, kind, spec })
  return promise
}

module.exports = { normalizeInterruptRequest }
