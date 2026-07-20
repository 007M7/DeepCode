// feedback-annotation-model.test.js — lane-wf-feedback item 2 (renderer model).
//
// The pure annotation model backs the inspector Feedback tab: identity keying,
// forward-compatible record normalization, and the in-memory index that drives
// the ✓ marker + prefill without an IPC round-trip.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const model = require('../src/renderer/feedback-annotation-model.js')

test('keyFor: stable (sessionId, seq) key; rejects missing pieces', () => {
  assert.strictEqual(model.keyFor('s1', 7), 's1::7')
  assert.strictEqual(model.keyFor('s1', '7'), 's1::7')
  assert.strictEqual(model.keyFor('', 7), null)
  assert.strictEqual(model.keyFor('s1', NaN), null)
  assert.strictEqual(model.keyFor('s1', undefined), null)
})

test('identityFor: pulls sessionId + seq from event + owning session', () => {
  assert.deepStrictEqual(model.identityFor({ seq: 4 }, 's1'), { sessionId: 's1', seq: 4 })
  assert.strictEqual(model.identityFor({ seq: 4 }, ''), null)
  assert.strictEqual(model.identityFor({}, 's1'), null)
  assert.strictEqual(model.identityFor(null, 's1'), null)
})

test('normalize: builds the forward-compatible record shape', () => {
  const rec = model.normalize({ sessionId: 's1', seq: 7, verdict: 'up', note: '  good  ', rubricDim: 'convergence', at: 111 })
  assert.deepStrictEqual(rec, { sessionId: 's1', seq: 7, verdict: 'up', note: 'good', rubricDim: 'convergence', at: 111 })
})

test('normalize: verdict-only (no note) still stores; note-only stores with null verdict', () => {
  const v = model.normalize({ sessionId: 's', seq: 1, verdict: 'down', note: '' })
  assert.strictEqual(v.verdict, 'down')
  assert.strictEqual(v.note, '')
  const n = model.normalize({ sessionId: 's', seq: 1, note: 'just a note' })
  assert.strictEqual(n.verdict, null)
  assert.strictEqual(n.note, 'just a note')
})

test('normalize: nothing to store (no verdict + empty note) → null (a clear)', () => {
  assert.strictEqual(model.normalize({ sessionId: 's', seq: 1, verdict: null, note: '   ' }), null)
  assert.strictEqual(model.normalize({ sessionId: 's', seq: 1 }), null)
})

test('normalize: invalid verdict is coerced to null; bad rubricDim dropped', () => {
  const rec = model.normalize({ sessionId: 's', seq: 1, verdict: 'meh', note: 'x', rubricDim: '   ' })
  assert.strictEqual(rec.verdict, null)
  assert.strictEqual('rubricDim' in rec, false)
})

test('normalize: no identity → null', () => {
  assert.strictEqual(model.normalize({ seq: 1, verdict: 'up' }), null)
  assert.strictEqual(model.normalize(null), null)
})

test('index: put/get/has/remove round-trip', () => {
  const idx = model.createAnnotationIndex()
  assert.strictEqual(idx.has('s1', 7), false)
  const rec = idx.put({ sessionId: 's1', seq: 7, verdict: 'up', note: 'ok' })
  assert.strictEqual(rec.verdict, 'up')
  assert.strictEqual(idx.has('s1', 7), true)
  assert.strictEqual(idx.get('s1', 7).note, 'ok')
  assert.strictEqual(idx.size(), 1)
  assert.strictEqual(idx.remove('s1', 7), true)
  assert.strictEqual(idx.has('s1', 7), false)
})

test('index: put with a clearing form drops the entry', () => {
  const idx = model.createAnnotationIndex()
  idx.put({ sessionId: 's1', seq: 7, verdict: 'up', note: 'ok' })
  assert.strictEqual(idx.has('s1', 7), true)
  const cleared = idx.put({ sessionId: 's1', seq: 7, verdict: null, note: '' })
  assert.strictEqual(cleared, null)
  assert.strictEqual(idx.has('s1', 7), false)
})

test('index: hydrate replaces the whole set from a flat list', () => {
  const idx = model.createAnnotationIndex()
  idx.put({ sessionId: 'x', seq: 1, verdict: 'up', note: 'a' })
  idx.hydrate([
    { sessionId: 's1', seq: 2, verdict: 'down', note: 'b' },
    { sessionId: 's1', seq: 3, verdict: 'up', note: 'c' },
    { bad: 'record' }, // ignored — no key
  ])
  assert.strictEqual(idx.has('x', 1), false, 'prior entries cleared')
  assert.strictEqual(idx.size(), 2)
  assert.strictEqual(idx.get('s1', 2).note, 'b')
})

test('index: two events in the same session are keyed independently', () => {
  const idx = model.createAnnotationIndex()
  idx.put({ sessionId: 's', seq: 1, verdict: 'up', note: 'first' })
  idx.put({ sessionId: 's', seq: 2, verdict: 'down', note: 'second' })
  assert.strictEqual(idx.get('s', 1).verdict, 'up')
  assert.strictEqual(idx.get('s', 2).verdict, 'down')
  assert.strictEqual(idx.size(), 2)
})
