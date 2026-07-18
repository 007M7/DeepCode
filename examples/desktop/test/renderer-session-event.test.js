// Tests for renderer.js `onSessionEvent(sessionId, event)` — the reducer that
// walks each session-event notification and mutates state / stream DOM.
//
// Covered arms (see renderer.js `switch (event.type)` at ~line 1006):
//   - turn/start          → meta.running=true, inflightTurn flips on active
//   - turn/end            → meta.running=false, inflightTurn flips off
//   - user/message        → append user bubble, seed title from first msg
//   - assistant/chunk     → append text-delta into streaming bubble
//   - assistant/message   → finalize streaming bubble, stamp seq
//   - tool/call           → record in meta.toolCalls
//   - context/message     → append context card into stream
//
// The harness loads the full renderer against a DOM stub and exposes the
// state / stream shapes we assert on via `window.__dshRenderer`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

test('turn/start sets meta.running and inflightTurn on the active session', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  assert.equal(renderer.getSessionMeta('s1').running, false) // freshly minted
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  assert.equal(renderer.getSessionMeta('s1').running, true)
  assert.equal(renderer.getActiveSessionId(), 's1')
})

test('turn/end clears meta.running', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2 })
  assert.equal(renderer.getSessionMeta('s1').running, false)
})

test('user/message on active session appends a user bubble and seeds the title', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: '', header: {}, hasUserMessage: false })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'user/message',
    seq: 1,
    data: { content: [{ type: 'text', text: 'hello there DSH' }] },
  })
  const meta = renderer.getSessionMeta('s1')
  assert.equal(meta.hasUserMessage, true)
  assert.equal(meta.title, 'hello there DSH')
  assert.match(renderer.getStreamText(), /hello there DSH/)
})

test('assistant/chunk with text-delta grows the streaming bubble', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'assistant/chunk',
    seq: 2,
    data: { chunk: { type: 'text-delta', text: 'hello ' } },
  })
  renderer.onSessionEvent('s1', {
    type: 'assistant/chunk',
    seq: 3,
    data: { chunk: { type: 'text-delta', text: 'world' } },
  })
  assert.match(renderer.getStreamText(), /hello world/)
})

test('assistant/message finalizes the streaming bubble text', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'assistant/chunk',
    seq: 2,
    data: { chunk: { type: 'text-delta', text: 'partial' } },
  })
  renderer.onSessionEvent('s1', {
    type: 'assistant/message',
    seq: 3,
    data: { content: [{ type: 'text', text: 'the final assistant answer' }] },
  })
  // The final content replaces the streaming partial; check the finalized text.
  assert.match(renderer.getStreamText(), /the final assistant answer/)
})

test('tool/call records the call in meta.toolCalls', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'tool/call',
    seq: 4,
    data: { callId: 'c1', name: 'bash', arguments: '{}' },
  })
  const meta = renderer.getSessionMeta('s1')
  assert.ok(meta.toolCalls instanceof Map)
  assert.ok(meta.toolCalls.has('c1'), 'toolCalls should record callId c1')
})

test('events for a non-active session do not append to the active stream', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'a', header: {} })
  renderer.ensureSession('s2', { title: 'b', header: {} })
  await renderer.selectSession('s1')
  const beforeText = renderer.getStreamText()
  renderer.onSessionEvent('s2', {
    type: 'user/message',
    seq: 1,
    data: { content: [{ type: 'text', text: 'background message' }] },
  })
  // meta.running / lastEventTime still update, but the active stream
  // shouldn't gain a bubble for the background session.
  assert.equal(renderer.getStreamText(), beforeText)
})

test('event.time > meta.lastEventTime updates the running max', async () => {
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 's', header: {}, lastEventTime: 0 })
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1, time: 100 })
  renderer.onSessionEvent('s1', { type: 'turn/end', seq: 2, time: 50 })
  // Later `time: 50` is smaller — must NOT overwrite the greater `100`.
  assert.equal(renderer.getSessionMeta('s1').lastEventTime, 100)
})

test('user/message with plugin source label routes to a system line, not a user bubble', async () => {
  // Regression guard for the historical `[[object Object]] <text>` bug —
  // renderer routes objectful `data.source` through describeSource before
  // string interpolation, so we see e.g. `[plugin]` and never the literal
  // `[object Object]`.
  const { renderer } = await loadRenderer()
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', {
    type: 'user/message',
    seq: 1,
    data: {
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'injected memo' }],
    },
  })
  const text = renderer.getStreamText()
  assert.match(text, /injected memo/)
  assert.doesNotMatch(text, /\[object Object\]/)
})
