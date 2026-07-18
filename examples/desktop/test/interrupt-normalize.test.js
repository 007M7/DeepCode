// Locks the canonical protocol-v2 `session/interrupt` normalization shape.
// The bridge (packages/ui/jsonrpc/src/interactions.ts) only emits requests
// with the discriminant at `payload.kind`; a legacy flat shape at
// `spec.kind` was considered during protocol design but never made it to
// the wire. This test locks that in place — if the wire ever moves back to
// flat, this test flips to the new expectation deliberately.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { normalizeInterruptRequest } = require('../src/main/interrupt-normalize.js')

function makePending() { return new Map() }
function makeSender() {
  const calls = []
  return { fn: (channel, payload) => calls.push({ channel, payload }), calls }
}

test('accepts canonical nested payload (approval)', () => {
  const pending = makePending()
  const sender = makeSender()
  const req = {
    sessionId: 'S1',
    interruptId: 'I-1',
    payload: {
      kind: 'approval',
      spec: {
        toolCallId: 'call-a',
        options: [
          { optionId: 'allow-once',  name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject',     kind: 'reject_once' },
        ],
      },
    },
  }
  const p = normalizeInterruptRequest(req, pending, sender.fn)
  assert.ok(typeof p.then === 'function', 'returns a pending promise')
  assert.strictEqual(sender.calls.length, 1, 'dispatched once to renderer')
  const { channel, payload } = sender.calls[0]
  assert.strictEqual(channel, 'interrupt:incoming')
  assert.strictEqual(payload.sessionId, 'S1')
  assert.strictEqual(payload.interruptId, 'I-1')
  assert.strictEqual(payload.kind, 'approval')
  assert.strictEqual(payload.spec.toolCallId, 'call-a')
  assert.strictEqual(payload.spec.options.length, 2)
  assert.ok(pending.has('I-1'), 'resolver stored under interruptId')
  // Resolve so the promise settles cleanly for the test runner.
  pending.get('I-1').resolve({ outcome: 'cancelled' })
})

test('accepts canonical nested payload (form)', () => {
  const pending = makePending()
  const sender = makeSender()
  const req = {
    sessionId: 'S2',
    interruptId: 'I-2',
    payload: { kind: 'form', spec: { fields: [{ id: 'name', label: 'Name' }] } },
  }
  const p = normalizeInterruptRequest(req, pending, sender.fn)
  assert.ok(typeof p.then === 'function')
  const { payload } = sender.calls[0]
  assert.strictEqual(payload.kind, 'form')
  assert.deepStrictEqual(payload.spec.fields, [{ id: 'name', label: 'Name' }])
  pending.get('I-2').resolve({ outcome: 'cancelled' })
})

test('rejects flat legacy shape (spec.kind without payload)', () => {
  // Legacy draft shape. Bridge no longer emits this; fail-closed protects the
  // shell from ambient garbage or a mistyped test bridge.
  const pending = makePending()
  const sender = makeSender()
  const req = {
    sessionId: 'S3',
    interruptId: 'I-3',
    spec: { kind: 'approval', toolCallId: 'x' },
  }
  const out = normalizeInterruptRequest(req, pending, sender.fn)
  assert.deepStrictEqual(out, { outcome: 'cancelled' })
  assert.strictEqual(sender.calls.length, 0, 'no dispatch when shape is unknown')
  assert.strictEqual(pending.size, 0, 'no resolver registered')
})

test('rejects when payload has unknown kind', () => {
  const pending = makePending()
  const sender = makeSender()
  const req = {
    sessionId: 'S4',
    interruptId: 'I-4',
    payload: { kind: 'unknown-thing', spec: {} },
  }
  const out = normalizeInterruptRequest(req, pending, sender.fn)
  assert.deepStrictEqual(out, { outcome: 'cancelled' })
  assert.strictEqual(sender.calls.length, 0)
  assert.strictEqual(pending.size, 0)
})

test('synthesizes an interruptId when the runtime omits one', () => {
  const pending = makePending()
  const sender = makeSender()
  const req = {
    sessionId: 'S5',
    // interruptId absent — normalizer must synthesize `int-<uuid>` so the
    // resolver map still has a stable key.
    payload: { kind: 'approval', spec: { toolCallId: 'x', options: [] } },
  }
  const p = normalizeInterruptRequest(req, pending, sender.fn)
  assert.ok(typeof p.then === 'function')
  assert.strictEqual(sender.calls.length, 1)
  const id = sender.calls[0].payload.interruptId
  assert.match(id, /^int-/, 'synthesized id has the expected prefix')
  assert.ok(pending.has(id))
  pending.get(id).resolve({ outcome: 'cancelled' })
})

test('rejects when payload is missing or malformed', () => {
  const pending = makePending()
  const sender = makeSender()
  for (const bad of [null, undefined, {}, { sessionId: 'x' }, { payload: null }, { payload: 'no' }]) {
    const out = normalizeInterruptRequest(bad, pending, sender.fn)
    assert.deepStrictEqual(out, { outcome: 'cancelled' }, `bad shape ${JSON.stringify(bad)} is cancelled`)
  }
  assert.strictEqual(sender.calls.length, 0)
})
