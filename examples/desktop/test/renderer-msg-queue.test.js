// Renderer-level tests for the composer message queue (lane-msg-queue).
//
// Covers the wiring the pure msg-queue-model.js tests can't reach:
//   - send() enqueues instead of sendPrompt when a turn is in flight
//   - the queue strip renders/hides per the active session's queue
//   - turn/end auto-drains exactly ONE queued item through sendPrompt
//   - session.finished drains once too, and doesn't double-drain with turn/end
//   - per-session isolation: a background session's turn/end never touches
//     the foreground session's composer
//   - runtime restart (onInitialized) clears every queue
//
// The harness loads the whole renderer against a DOM stub and exposes the
// send entry point + queue handle via window.__dshRenderer.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

// Drive an in-flight turn on `sid` and make it active, returning refs.
async function activeInflight(renderer, document, sid = 's1') {
  renderer.ensureSession(sid, { title: 'sess', header: {}, hasUserMessage: true })
  await renderer.selectSession(sid)
  renderer.onSessionEvent(sid, { type: 'turn/start', seq: 1 })
  return { input: document.getElementById('input') }
}

function sendCalls(dsh) {
  return dsh.__calls.filter((c) => c[0] === 'sendPrompt')
}

test('send() enqueues instead of sendPrompt while a turn is in flight', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  const before = sendCalls(dsh).length
  input.value = 'queued follow-up'
  await renderer.send()
  assert.equal(sendCalls(dsh).length, before, 'no sendPrompt fired mid-turn')
  assert.deepEqual(renderer.listMsgQueue('s1').map((x) => x.text), ['queued follow-up'])
  assert.equal(input.value, '', 'composer cleared as if sent')
})

test('whitespace-only mid-turn input never enqueues', async () => {
  const { renderer, document } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = '   '
  await renderer.send()
  assert.equal(renderer.listMsgQueue('s1').length, 0)
})

test('queue strip renders one chip per queued message + counter, hides when empty', async () => {
  const { renderer, document } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  const strip = document.getElementById('msg-queue-strip')
  assert.equal(strip.hidden, true, 'hidden with an empty queue')
  input.value = 'first'; await renderer.send()
  input.value = 'second'; await renderer.send()
  assert.equal(strip.hidden, false, 'shown once queued')
  assert.equal(strip.querySelectorAll('.msg-queue-chip').length, 2)
  const badge = strip.querySelector('.msg-queue-count')
  assert.match(badge.textContent, /queued 2/)
})

test('turn/end auto-drains exactly one queued item through sendPrompt', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'one'; await renderer.send()
  input.value = 'two'; await renderer.send()
  const before = sendCalls(dsh).length
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  // drain is async (dispatchPrompt awaits sendPrompt) — let microtasks settle.
  await new Promise((r) => setTimeout(r, 5))
  const after = sendCalls(dsh)
  assert.equal(after.length - before, 1, 'exactly one drained send')
  assert.equal(after[after.length - 1][2], 'one', 'FIFO: head sent first')
  assert.deepEqual(renderer.listMsgQueue('s1').map((x) => x.text), ['two'],
    'the second item waits for its own turn to finish')
})

test('a second turn/end drains the next item (one per completion)', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'one'; await renderer.send()
  input.value = 'two'; await renderer.send()
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 5))
  // the drained 'one' send flipped inflightTurn back on; simulate its turn.
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 3 })
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 4 })
  await new Promise((r) => setTimeout(r, 5))
  const sent = sendCalls(dsh).map((c) => c[2])
  assert.deepEqual(sent, ['one', 'two'], 'both drained in FIFO order across two turns')
  assert.equal(renderer.listMsgQueue('s1').length, 0)
})

test('turn/end + session.finished for one turn drains only once', async () => {
  const { renderer, document, dsh, listeners } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'one'; await renderer.send()
  input.value = 'two'; await renderer.send()
  const before = sendCalls(dsh).length
  // Some daemons emit both boundaries for the same turn.
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 5))
  listeners.onNotify({ method: 'session.finished', params: { sessionId: 's1', status: 'ok' } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sendCalls(dsh).length - before, 1, 'drain-once guard held across both signals')
  assert.deepEqual(renderer.listMsgQueue('s1').map((x) => x.text), ['two'])
})

test('session.finished alone (no turn/end) still drains once', async () => {
  const { renderer, document, dsh, listeners } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'only'; await renderer.send()
  const before = sendCalls(dsh).length
  listeners.onNotify({ method: 'session.finished', params: { sessionId: 's1', status: 'error' } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sendCalls(dsh).length - before, 1, 'error-path completion drained the head')
})

test('cancelled turn (turn/end after cancel) still drains — queue survives Cancel', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'after cancel'; await renderer.send()
  // User cancels; the wire still closes the turn with turn/end.
  const before = sendCalls(dsh).length
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sendCalls(dsh).length - before, 1, 'queued follow-up sent on the cancelled turn end')
})

test('per-session isolation: a background turn/end never touches the active composer', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  // s1 active + in flight, one queued item.
  const { input } = await activeInflight(renderer, document, 's1')
  input.value = 's1-queued'; await renderer.send()
  // s2 exists, has its own in-flight turn + queue, but is NOT active.
  renderer.ensureSession('s2', { title: 's2', header: {}, hasUserMessage: true, running: true })
  renderer.getMsgQueue().enqueue('s2', 's2-queued')
  // Arm s2's drain flag via a background turn/start (not the active session,
  // so it doesn't touch the composer), then end it.
  renderer.onSessionEvent('s2', { type: 'turn/start', seq: 8 })
  const before = sendCalls(dsh).length
  renderer.onSessionEvent('s2', { type: 'turn/end', seq: 9 })
  await new Promise((r) => setTimeout(r, 5))
  const sent = sendCalls(dsh).slice(before).map((c) => [c[1], c[2]])
  assert.deepEqual(sent, [['s2', 's2-queued']], 'only s2 drained, sent against s2')
  // s1's queue + composer untouched.
  assert.deepEqual(renderer.listMsgQueue('s1').map((x) => x.text), ['s1-queued'])
  const strip = document.getElementById('msg-queue-strip')
  assert.equal(strip.querySelectorAll('.msg-queue-chip').length, 1, 'active strip still shows s1')
})

test('switching sessions shows the target session\'s queue (strict isolation)', async () => {
  const { renderer, document } = await loadRenderer()
  const { input } = await activeInflight(renderer, document, 's1')
  input.value = 's1-only'; await renderer.send()
  const strip = document.getElementById('msg-queue-strip')
  assert.equal(strip.querySelectorAll('.msg-queue-chip').length, 1)
  // Switch to a fresh idle session — its queue is empty, strip hides.
  renderer.ensureSession('s2', { title: 's2', header: {}, hasUserMessage: true })
  await renderer.selectSession('s2')
  assert.equal(strip.hidden, true, 'empty queue on s2 hides the strip')
  // Switch back — s1's queue is intact.
  await renderer.selectSession('s1')
  assert.equal(strip.querySelectorAll('.msg-queue-chip').length, 1)
})

test('runtime restart (onInitialized) clears every queue and posts a notice', async () => {
  const { renderer, document, listeners } = await loadRenderer()
  const { input } = await activeInflight(renderer, document, 's1')
  input.value = 'doomed'; await renderer.send()
  renderer.getMsgQueue().enqueue('s2', 'also doomed')
  // Fire the initialize handshake (new daemon / profile switch).
  listeners.onInitialized({ serverInfo: { name: 'echo', version: '1' }, protocolVersion: 1 })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(renderer.getMsgQueue().size('s1'), 0)
  assert.equal(renderer.getMsgQueue().size('s2'), 0)
  assert.match(renderer.getStreamText(), /cleared 2 queued messages/)
})

test('drained send re-arms inflightTurn so a follow-up Enter queues again', async () => {
  const { renderer, document, dsh } = await loadRenderer()
  const { input } = await activeInflight(renderer, document)
  input.value = 'one'; await renderer.send()
  input.value = 'two'; await renderer.send()
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  await new Promise((r) => setTimeout(r, 5))
  // 'one' is now in flight (dispatchPrompt set inflightTurn). A new Enter
  // should queue behind 'two', not fire a second concurrent sendPrompt.
  const before = sendCalls(dsh).length
  input.value = 'three'; await renderer.send()
  assert.equal(sendCalls(dsh).length, before, 'follow-up queued, not sent concurrently')
  assert.deepEqual(renderer.listMsgQueue('s1').map((x) => x.text), ['two', 'three'])
})
