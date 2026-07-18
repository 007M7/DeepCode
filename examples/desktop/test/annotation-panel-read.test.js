// Tests for the annotation-panel read interface (#205 Feedback-tab handoff).
//
// The panel is a script-tag IIFE that installs `window.__dshAnnotation` at
// runtime; under node --test we require it, which runs the IIFE with
// `typeof window === 'undefined'` — so the store lives on the CommonJS
// module.exports `_internal` handle instead.
//
// We stub just enough of the browser globals to exercise the CustomEvent
// dispatch path in write(): `document.dispatchEvent` + a CustomEvent
// constructor that records `type` and `detail`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// Stub browser globals BEFORE requiring the panel — its `write()` gates on
// `typeof document !== 'undefined'`, so setting these controls whether the
// CustomEvent branch runs.
const dispatched = []
global.document = {
  dispatchEvent(ev) { dispatched.push(ev); return true },
  addEventListener() {},
}
class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
  }
}
global.CustomEvent = FakeCustomEvent

const panel = require('../src/renderer/annotation-panel.js')
const model = require('../src/renderer/annotation-model.js')
const { write, read, readAll, state } = panel._internal

test('write() stamps annotator default when the record has none', () => {
  state.byId.clear()
  const ann = model.blankAnnotation('sess-alpha')
  write(ann)
  const stored = state.byId.get('sess-alpha')
  assert.equal(stored.annotator, 'local-user')
})

test('write() preserves an existing annotator instead of overwriting it', () => {
  state.byId.clear()
  const ann = { ...model.blankAnnotation('sess-beta'), annotator: 'reviewer-42' }
  write(ann)
  assert.equal(state.byId.get('sess-beta').annotator, 'reviewer-42')
})

test('write() dispatches dsh:annotation-updated with the stored record', () => {
  state.byId.clear()
  dispatched.length = 0
  const ann = model.blankAnnotation('sess-gamma')
  write(ann)
  const ev = dispatched.find(e => e.type === 'dsh:annotation-updated')
  assert.ok(ev, 'event fired')
  assert.equal(ev.detail.sessionId, 'sess-gamma')
  assert.equal(ev.detail.ann.annotator, 'local-user', 'detail carries stamped record')
})

test('read(sessionId) returns null for unknown ids and a snapshot for known ones', () => {
  state.byId.clear()
  assert.equal(read('nope'), null)
  const ann = model.setOverall(model.blankAnnotation('sess-delta'), 'good', 42)
  write(ann)
  const got = read('sess-delta')
  assert.equal(got.overall, 'good')
  assert.equal(got.sessionId, 'sess-delta')
  // Mutating the snapshot must not affect the store.
  got.overall = 'bad'
  assert.equal(read('sess-delta').overall, 'good', 'snapshot is a copy')
})

test('readAll() returns a fresh Map of snapshots', () => {
  state.byId.clear()
  write(model.setOverall(model.blankAnnotation('a'), 'good', 0))
  write(model.setOverall(model.blankAnnotation('b'), 'bad', 0))
  const all = readAll()
  assert.equal(all.size, 2)
  assert.equal(all.get('a').overall, 'good')
  assert.equal(all.get('b').overall, 'bad')
  // Deleting from the snapshot map does not remove from the store.
  all.delete('a')
  assert.ok(readAll().has('a'))
})

// ─── Typed rubric primitives ─────────────────────────────────────────

test('activeDims defaults to the 5 fixed continuous multi-turn dims', () => {
  const { activeDims } = panel._internal
  const dims = activeDims()
  assert.equal(dims.length, 5, '5 fixed dims out of the box')
  for (const d of dims) assert.equal(d.type, 'continuous')
})

test('valueForKey routes 1-9 keys to the right primitive value', () => {
  const { valueForKey } = panel._internal
  // continuous — key = numeric value inside range
  assert.equal(valueForKey({ id: 'x', type: 'continuous', min: 1, max: 5 }, 3), 3)
  assert.equal(valueForKey({ id: 'x', type: 'continuous', min: 1, max: 5 }, 6), undefined,
    'out-of-range digit → undefined (no write)')
  // categorical — key = 1-based enum index
  assert.equal(valueForKey({ id: 'x', type: 'categorical', values: ['bad', 'ok', 'good'] }, 1), 'bad')
  assert.equal(valueForKey({ id: 'x', type: 'categorical', values: ['bad', 'ok', 'good'] }, 3), 'good')
  assert.equal(valueForKey({ id: 'x', type: 'categorical', values: ['bad', 'ok', 'good'] }, 4), undefined)
  // boolean — 1=true, 2=false
  assert.equal(valueForKey({ id: 'x', type: 'boolean' }, 1), true)
  assert.equal(valueForKey({ id: 'x', type: 'boolean' }, 2), false)
  assert.equal(valueForKey({ id: 'x', type: 'boolean' }, 3), undefined)
})
