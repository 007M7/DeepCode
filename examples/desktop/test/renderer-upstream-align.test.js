// Ticket #15 (2026-07-17) — renderer wiring for the upstream-align batch.
//
// A. Live subagent lineage routing: subagent.started + a spawn_agent
//    tool/call anchor + a stream of session.event notifications keyed on
//    the child sessionId => a RUNNING inline card appears under the spawn
//    row and grows as child events arrive; subagent.finished swaps in the
//    sealed inline trace card at the same anchor.
// B. envelope:'raw' inject render: appendInjectCard routes through
//    raw-inject.js when data.envelope === 'raw', producing a
//    .raw-inject-card with badge / kind attributes and the L2 JSON drawer
//    so envelope+meta land verbatim.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

async function seedActiveSession(renderer, id = 'root-align-a') {
  renderer.ensureSession(id, { title: 'x', header: {} })
  await renderer.selectSession(id)
}

test('subagent.started with spawn anchor mounts RUNNING inline card', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-a'
  await seedActiveSession(renderer, parentId)
  // Emulate the parent's spawn_agent tool/call so meta.lastSpawnCallId is
  // populated for the heuristic anchor path.
  renderer.onSessionEvent(parentId, {
    type: 'tool/call',
    seq: 5,
    data: { callId: 'call_spawn_up_a', name: 'spawn_agent', arguments: '{}' },
  })
  // Verify the tool row is on the stream (the anchor).
  const streamEl = document.getElementById('stream')
  const parentRow = streamEl.querySelector('.tool-block[data-call-id="call_spawn_up_a"]')
  assert.ok(parentRow, 'spawn_agent tool row must render as the anchor')
  // Fire subagent.started — real wire shape (no parentCallId; heuristic
  // adopts meta.lastSpawnCallId).
  renderer.dispatchSubagentNotification('subagent.started', {
    parentSessionId: parentId,
    childSessionId: 'child-1',
  })
  const runningCard = streamEl.querySelector('.subagent-trace--running')
  assert.ok(runningCard, 'a RUNNING inline card must mount under the spawn row')
  assert.equal(runningCard.dataset.parentCallId, 'call_spawn_up_a')
  const store = renderer.getSubagentStore()
  assert.ok(store, 'lineage store must be initialised')
  const rec = store.resolveChild('child-1')
  assert.ok(rec, 'lineage record must exist for child-1')
  assert.equal(rec.running, true)
  assert.equal(rec.parentCallId, 'call_spawn_up_a')
})

test('child session.event notifications route into the live card body', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-a'
  await seedActiveSession(renderer, parentId)
  renderer.onSessionEvent(parentId, {
    type: 'tool/call', seq: 5,
    data: { callId: 'call_spawn_up_b', name: 'spawn_agent', arguments: '{}' },
  })
  renderer.dispatchSubagentNotification('subagent.started', {
    parentSessionId: parentId, childSessionId: 'child-2',
  })
  // Now feed child events through onSessionEvent keyed on the child id.
  // routeLiveChildEvent should paint each into the .subagent-live-body.
  renderer.onSessionEvent('child-2', {
    type: 'assistant/chunk',
    seq: 1,
    data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'Running grep for X.' } },
  })
  renderer.onSessionEvent('child-2', {
    type: 'tool/call', seq: 2,
    data: { callId: 'sub_grep_1', name: 'grep', arguments: '{}' },
  })
  renderer.onSessionEvent('child-2', {
    type: 'tool/result', seq: 3,
    data: { callId: 'sub_grep_1', content: [{ type: 'text', text: '3 hits' }], isError: false },
  })
  const streamEl = document.getElementById('stream')
  const liveBody = streamEl.querySelector('.subagent-trace--running .subagent-live-body')
  assert.ok(liveBody, 'live-subtrajectory body must be present in RUNNING card')
  const rows = liveBody.querySelectorAll('.subagent-live-row')
  assert.equal(rows.length, 3, 'one live row per child event')
  // The child events should NOT have leaked into the parent stream (they
  // belong under the spawn row, not the root).
  const rootTextBubbles = streamEl.querySelectorAll('.msg.assistant')
  const anyStreamedChild = Array.from(rootTextBubbles).some(
    (b) => (b.textContent || '').includes('Running grep for X.'))
  assert.equal(anyStreamedChild, false, 'child stream must not surface as a root assistant bubble')
})

test('subagent.finished swaps RUNNING card for the sealed inline trace at the same anchor', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-a'
  await seedActiveSession(renderer, parentId)
  renderer.onSessionEvent(parentId, {
    type: 'tool/call', seq: 5,
    data: { callId: 'call_spawn_up_c', name: 'spawn_agent', arguments: '{}' },
  })
  renderer.dispatchSubagentNotification('subagent.started', {
    parentSessionId: parentId, childSessionId: 'child-3',
  })
  // A few live child events so the sealed card has content in its buffer.
  renderer.onSessionEvent('child-3', {
    type: 'tool/call', seq: 1,
    data: { callId: 'sub_1', name: 'grep', arguments: '{}' },
  })
  renderer.dispatchSubagentNotification('subagent.finished', {
    parentSessionId: parentId,
    childSessionId: 'child-3',
    agentId: 'agent-x',
    status: 'ok',
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '```json\n{"count":3}\n```' }],
  })
  const streamEl = document.getElementById('stream')
  const running = streamEl.querySelector('.subagent-trace--running')
  assert.equal(running, null, 'RUNNING card must be replaced')
  const sealed = streamEl.querySelector('.subagent-trace[data-parent-call-id="call_spawn_up_c"]')
  assert.ok(sealed, 'sealed inline trace must occupy the same anchor')
  assert.equal(sealed.classList.contains('subagent-trace--running'), false)
  // Lineage record must be forgotten so a repeat id doesn't reuse a stale entry.
  assert.equal(renderer.getSubagentStore().resolveChild('child-3'), null)
})

test('envelope:"raw" context/message renders as .raw-inject-card with badge', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-b'
  await seedActiveSession(renderer, parentId)
  const meta = renderer.getSessionMeta(parentId)
  const event = {
    type: 'context/message',
    seq: 42,
    data: {
      envelope: 'raw',
      source: { kind: 'plugin', plugin: 'workspace-context' },
      meta: {
        kind: 'workspace-instructions',
        version: '2026.07.17',
        changes: [
          { path: 'a.ts', action: 'add' },
          { path: 'b.ts', action: 'remove' },
        ],
      },
      content: [{ type: 'text', text: '<workspace-instructions>...</workspace-instructions>' }],
    },
  }
  const el = renderer.appendInjectCard(event, parentId, meta)
  assert.ok(el, 'raw inject must produce a card element')
  assert.equal(el.className && el.className.includes('raw-inject-card'), true)
  assert.equal(el.dataset.envelope, 'raw')
  assert.equal(el.dataset.kind, 'workspace-instructions')
  const streamEl = document.getElementById('stream')
  const badge = streamEl.querySelector('.raw-inject-badge')
  assert.ok(badge, 'badge must be present')
  assert.match(badge.textContent, /raw · workspace-instructions/)
  // Typed shape: workspace-instructions renders a changes list with the
  // action columns.
  const changes = streamEl.querySelectorAll('.raw-inject-change-row')
  assert.equal(changes.length, 2)
  // Zero-loss: envelope + meta land in the L2 JSON drawer.
  const jsonPre = streamEl.querySelector('.raw-inject-json')
  assert.ok(jsonPre, 'L2 raw JSON pre must be present')
  assert.match(jsonPre.textContent, /"envelope": "raw"/)
  assert.match(jsonPre.textContent, /"kind": "workspace-instructions"/)
})

test('envelope:"raw" with unknown kind falls back to generic card without losing meta', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-b'
  await seedActiveSession(renderer, parentId)
  const meta = renderer.getSessionMeta(parentId)
  const event = {
    type: 'context/message',
    seq: 43,
    data: {
      envelope: 'raw',
      source: { kind: 'plugin', plugin: 'experimental' },
      meta: { kind: 'session-note', note: 'unknown-kind fallback' },
      content: [{ type: 'text', text: 'freeform note' }],
    },
  }
  const el = renderer.appendInjectCard(event, parentId, meta)
  assert.equal(el.dataset.kind, 'session-note')
  const streamEl = document.getElementById('stream')
  // No typed workspace-instructions header for unknown kinds.
  assert.equal(streamEl.querySelectorAll('.raw-inject-changes').length, 0)
  const badge = streamEl.querySelector('.raw-inject-badge')
  assert.match(badge.textContent, /raw · session-note/)
  const jsonPre = streamEl.querySelector('.raw-inject-json')
  assert.match(jsonPre.textContent, /unknown-kind fallback/)
})

test('tagged (envelope:"context") context/message does NOT hit the raw branch', async () => {
  const { renderer, document } = await loadRenderer()
  const parentId = 'root-align-b'
  await seedActiveSession(renderer, parentId)
  const meta = renderer.getSessionMeta(parentId)
  // Old-shape event (no envelope) — must fall through to the classifier.
  renderer.appendInjectCard({
    type: 'context/message',
    seq: 55,
    data: {
      source: { kind: 'plugin', plugin: 'time-context' },
      content: [{ type: 'text', text: 'clock tick' }],
    },
  }, parentId, meta)
  const streamEl = document.getElementById('stream')
  assert.equal(streamEl.querySelectorAll('.raw-inject-card').length, 0,
    'tagged inject must not produce a raw card')
  const injectCard = streamEl.querySelector('.inject-card')
  assert.ok(injectCard, 'tagged inject must produce the normal inject-card')
})
