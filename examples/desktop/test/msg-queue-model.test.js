// Unit tests for msg-queue-model.js — the per-session FIFO backing the
// composer's mid-turn message queue. Pure data structure, no DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createMsgQueue } = require('../src/renderer/msg-queue-model.js')

test('enqueue returns a monotonic id and list preserves FIFO order', () => {
  const q = createMsgQueue()
  const a = q.enqueue('s1', 'first')
  const b = q.enqueue('s1', 'second')
  const c = q.enqueue('s1', 'third')
  assert.ok(a < b && b < c, 'ids are monotonic')
  assert.deepEqual(q.list('s1').map((x) => x.text), ['first', 'second', 'third'])
})

test('enqueue trims text and rejects empty / whitespace-only', () => {
  const q = createMsgQueue()
  assert.equal(q.enqueue('s1', ''), null)
  assert.equal(q.enqueue('s1', '   '), null)
  assert.equal(q.enqueue('s1', '\n\t '), null)
  const id = q.enqueue('s1', '  hi  ')
  assert.ok(id)
  assert.equal(q.list('s1')[0].text, 'hi', 'stored text is trimmed')
  assert.equal(q.size('s1'), 1, 'rejected blanks never entered the queue')
})

test('enqueue with null sessionId is a no-op', () => {
  const q = createMsgQueue()
  assert.equal(q.enqueue(null, 'x'), null)
  assert.equal(q.enqueue(undefined, 'x'), null)
})

test('drain pops the head and returns null when empty/unknown', () => {
  const q = createMsgQueue()
  assert.equal(q.drain('s1'), null, 'unknown session drains to null')
  q.enqueue('s1', 'one')
  q.enqueue('s1', 'two')
  assert.equal(q.drain('s1').text, 'one', 'head first')
  assert.equal(q.drain('s1').text, 'two')
  assert.equal(q.drain('s1'), null, 'emptied queue drains to null')
})

test('drain-once semantics: one call removes exactly one item', () => {
  const q = createMsgQueue()
  q.enqueue('s1', 'a')
  q.enqueue('s1', 'b')
  q.enqueue('s1', 'c')
  const first = q.drain('s1')
  assert.equal(first.text, 'a')
  assert.equal(q.size('s1'), 2, 'the other two wait for their own turn ends')
  assert.deepEqual(q.list('s1').map((x) => x.text), ['b', 'c'])
})

test('remove drops a specific item by id; returns false when absent', () => {
  const q = createMsgQueue()
  const a = q.enqueue('s1', 'a')
  const b = q.enqueue('s1', 'b')
  assert.equal(q.remove('s1', a), true)
  assert.deepEqual(q.list('s1').map((x) => x.text), ['b'])
  assert.equal(q.remove('s1', a), false, 'already gone')
  assert.equal(q.remove('nope', b), false, 'unknown session')
})

test('update rewrites text, trims, and rejects blank', () => {
  const q = createMsgQueue()
  const id = q.enqueue('s1', 'old')
  assert.equal(q.update('s1', id, '  new  '), true)
  assert.equal(q.list('s1')[0].text, 'new')
  assert.equal(q.update('s1', id, '   '), false, 'blank edit rejected')
  assert.equal(q.list('s1')[0].text, 'new', 'text unchanged after rejected edit')
  assert.equal(q.update('s1', 9999, 'x'), false, 'unknown id')
})

test('promote moves an item to the head so the next drain sends it', () => {
  const q = createMsgQueue()
  q.enqueue('s1', 'a')
  const b = q.enqueue('s1', 'b')
  q.enqueue('s1', 'c')
  assert.equal(q.promote('s1', b), true)
  assert.deepEqual(q.list('s1').map((x) => x.text), ['b', 'a', 'c'])
  assert.equal(q.drain('s1').text, 'b', 'promoted item drains first')
})

test('promote is idempotent on the head and single-item queues', () => {
  const q = createMsgQueue()
  const a = q.enqueue('s1', 'a')
  assert.equal(q.promote('s1', a), true, 'single item head promote succeeds')
  assert.deepEqual(q.list('s1').map((x) => x.text), ['a'])
  const b = q.enqueue('s1', 'b')
  assert.equal(q.promote('s1', a), true, 'already-head promote succeeds')
  assert.deepEqual(q.list('s1').map((x) => x.text), ['a', 'b'])
  assert.equal(q.promote('s1', 4242), false, 'unknown id fails')
})

test('per-session isolation: operations never cross sessions', () => {
  const q = createMsgQueue()
  const a1 = q.enqueue('s1', 's1-a')
  q.enqueue('s2', 's2-a')
  q.enqueue('s2', 's2-b')
  assert.equal(q.size('s1'), 1)
  assert.equal(q.size('s2'), 2)
  // drain s1 leaves s2 untouched
  assert.equal(q.drain('s1').text, 's1-a')
  assert.equal(q.size('s2'), 2, 's2 unaffected by s1 drain')
  // remove/promote keyed on the wrong session is a no-op
  assert.equal(q.remove('s2', a1), false, 's1 id not found in s2')
  assert.equal(q.promote('s2', a1), false)
  assert.deepEqual(q.list('s2').map((x) => x.text), ['s2-a', 's2-b'])
})

test('clear empties one session and returns the count dropped', () => {
  const q = createMsgQueue()
  q.enqueue('s1', 'a')
  q.enqueue('s1', 'b')
  q.enqueue('s2', 'c')
  assert.equal(q.clear('s1'), 2)
  assert.equal(q.size('s1'), 0)
  assert.equal(q.size('s2'), 1, 'other session survives a targeted clear')
  assert.equal(q.clear('unknown'), 0)
})

test('clearAll wipes every session (crash / profile switch) and totals the drop', () => {
  const q = createMsgQueue()
  q.enqueue('s1', 'a')
  q.enqueue('s1', 'b')
  q.enqueue('s2', 'c')
  assert.equal(q.clearAll(), 3)
  assert.equal(q.size('s1'), 0)
  assert.equal(q.size('s2'), 0)
  assert.deepEqual(q.list('s1'), [])
})

test('list returns copies — mutating the result cannot corrupt the queue', () => {
  const q = createMsgQueue()
  q.enqueue('s1', 'a')
  const snap = q.list('s1')
  snap[0].text = 'HACKED'
  snap.push({ id: 999, text: 'injected' })
  assert.equal(q.list('s1')[0].text, 'a', 'internal item untouched')
  assert.equal(q.size('s1'), 1, 'internal length untouched')
})
