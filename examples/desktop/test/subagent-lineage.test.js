// Ticket #15 A (2026-07-17) — subagent-lineage pure module tests.
//
// Locks the routing contract: registerStarted → resolveChild returns the
// record, pushChildEvent appends to childEvents, markFinished flips
// running=false and merges patch fields, forget removes the record, and
// the spawn anchor heuristic reads meta.lastSpawnCallId.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createSubagentLineage,
  isSpawnAgentToolCall,
  spawnAnchorFor,
  SPAWN_TOOL_NAMES,
} = require('../src/renderer/subagent-lineage.js')

test('registerStarted stores lineage and resolveChild returns it', () => {
  const store = createSubagentLineage()
  const rec = store.registerStarted({
    parentSessionId: 'root-1',
    childSessionId: 'child-1',
    parentCallId: 'call_spawn_1',
  })
  assert.equal(rec.parentSessionId, 'root-1')
  assert.equal(rec.childSessionId, 'child-1')
  assert.equal(rec.parentCallId, 'call_spawn_1')
  assert.equal(rec.running, true)
  assert.equal(rec.status, 'running')
  assert.deepEqual(rec.childEvents, [])
  const found = store.resolveChild('child-1')
  assert.strictEqual(found, rec)
})

test('registerStarted is idempotent — repeat call returns the same record', () => {
  const store = createSubagentLineage()
  const first = store.registerStarted({
    parentSessionId: 'root-1', childSessionId: 'child-1', parentCallId: null,
  })
  const second = store.registerStarted({
    parentSessionId: 'root-1', childSessionId: 'child-1', parentCallId: 'call_late',
  })
  assert.strictEqual(second, first)
  // Late-arriving parentCallId is adopted so a heuristic race doesn't
  // permanently strand the anchor.
  assert.equal(first.parentCallId, 'call_late')
})

test('registerStarted returns null when childSessionId missing', () => {
  const store = createSubagentLineage()
  assert.equal(store.registerStarted({ parentSessionId: 'root-1' }), null)
})

test('resolveChild returns null for unknown ids and no lookup for null', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'p', childSessionId: 'c' })
  assert.equal(store.resolveChild('nope'), null)
  assert.equal(store.resolveChild(null), null)
  assert.equal(store.resolveChild(undefined), null)
})

test('pushChildEvent appends to the lineage record and preserves order', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c1' })
  store.pushChildEvent('c1', { type: 'assistant/chunk', seq: 1 })
  store.pushChildEvent('c1', { type: 'tool/call', seq: 2 })
  store.pushChildEvent('c1', { type: 'tool/result', seq: 3 })
  const rec = store.resolveChild('c1')
  assert.equal(rec.childEvents.length, 3)
  assert.deepEqual(rec.childEvents.map((e) => e.seq), [1, 2, 3])
})

test('pushChildEvent no-ops for unknown ids', () => {
  const store = createSubagentLineage()
  assert.equal(store.pushChildEvent('missing', { type: 'x' }), null)
})

test('attachCard stashes DOM handles for later render access', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c1' })
  const cardEl = { id: 'card' }
  const bodyEl = { id: 'body' }
  const rec = store.attachCard('c1', { cardEl, bodyEl })
  assert.strictEqual(rec.cardEl, cardEl)
  assert.strictEqual(rec.bodyEl, bodyEl)
})

test('markFinished flips running=false and merges status/lastAssistantMessage', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c1' })
  const last = [{ type: 'text', text: '{"count":1}' }]
  const rec = store.markFinished('c1', { status: 'ok', lastAssistantMessage: last })
  assert.equal(rec.running, false)
  assert.equal(rec.status, 'ok')
  assert.strictEqual(rec.lastAssistantMessage, last)
})

test('forget removes the lineage record', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c1' })
  assert.equal(store.size(), 1)
  store.forget('c1')
  assert.equal(store.size(), 0)
  assert.equal(store.resolveChild('c1'), null)
})

test('isSpawnAgentToolCall matches the canonical spawn tool names', () => {
  for (const name of SPAWN_TOOL_NAMES) {
    assert.equal(isSpawnAgentToolCall({ type: 'tool/call', data: { name } }), true)
  }
  assert.equal(isSpawnAgentToolCall({ type: 'tool/call', data: { name: 'grep' } }), false)
  assert.equal(isSpawnAgentToolCall({ type: 'tool/result', data: { name: 'spawn_agent' } }), false)
  assert.equal(isSpawnAgentToolCall(null), false)
})

test('spawnAnchorFor reads meta.lastSpawnCallId', () => {
  assert.equal(spawnAnchorFor({ lastSpawnCallId: 'call_spawn_9' }), 'call_spawn_9')
  assert.equal(spawnAnchorFor({}), null)
  assert.equal(spawnAnchorFor(null), null)
})

test('two distinct child sessions do not collide', () => {
  const store = createSubagentLineage()
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c1', parentCallId: 'a' })
  store.registerStarted({ parentSessionId: 'root', childSessionId: 'c2', parentCallId: 'b' })
  assert.equal(store.resolveChild('c1').parentCallId, 'a')
  assert.equal(store.resolveChild('c2').parentCallId, 'b')
  assert.equal(store.size(), 2)
})
