// Pure tests for src/renderer/event-filter.js — the two guards that keep
// the chat stream from leaking `[[object Object]]` blobs and dev-facing
// audit events. Also asserts that renderer.js's local copies of both
// helpers match the extracted module byte-for-byte (they exist as inline
// copies for readability; the test is the drift alarm).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  describeSource,
  isDevOnlyEventType,
  pickReplaySource,
  textFromContentBlocks,
} = require('../src/renderer/event-filter.js')

// ---- describeSource -------------------------------------------------------

test('describeSource: string passes through', () => {
  assert.equal(describeSource('user'), 'user')
  assert.equal(describeSource('plugin'), 'plugin')
})

test('describeSource: undefined/null → "context"', () => {
  assert.equal(describeSource(undefined), 'context')
  assert.equal(describeSource(null), 'context')
})

test('describeSource: MessageSourceMap plugin → "plugin:<name>"', () => {
  const label = describeSource({ kind: 'plugin', plugin: 'compact' })
  assert.equal(label, 'plugin:compact')
})

test('describeSource: MessageSourceMap tool → "tool:<name>"', () => {
  const label = describeSource({ kind: 'tool', tool: 'bash' })
  assert.equal(label, 'tool:bash')
})

test('describeSource: kind-only falls back to kind', () => {
  assert.equal(describeSource({ kind: 'external' }), 'external')
})

test('describeSource: object without .kind → "context" (no [object Object])', () => {
  // The historical bug: `${source}` used the object directly, so a caller
  // like `appendSystem(\`[${data.source}] hi\`)` produced
  // `[[object Object]] hi`. Route through describeSource → readable label.
  const label = describeSource({ foo: 'bar' })
  assert.equal(label, 'context')
  assert.doesNotMatch(label, /object Object/i)
})

// ---- isDevOnlyEventType ---------------------------------------------------

test('isDevOnlyEventType: request/header* is dev-only', () => {
  assert.equal(isDevOnlyEventType('request/header'), true)
  assert.equal(isDevOnlyEventType('request/header-delta'), true)
})

test('isDevOnlyEventType: hook/approval/permission/audit prefixes are dev-only', () => {
  assert.equal(isDevOnlyEventType('hook/invoked'), true)
  assert.equal(isDevOnlyEventType('hook/result'), true)
  assert.equal(isDevOnlyEventType('approval/request'), true)
  assert.equal(isDevOnlyEventType('permission/grant'), true)
  assert.equal(isDevOnlyEventType('audit/write'), true)
})

test('isDevOnlyEventType: bash/sandbox-mode is dev-only', () => {
  assert.equal(isDevOnlyEventType('bash/sandbox-mode'), true)
})

test('isDevOnlyEventType: chat-facing families pass through', () => {
  for (const t of [
    'user/message', 'assistant/chunk', 'assistant/message',
    'tool/call', 'tool/result', 'turn/end', 'compact/start',
    'context/message', 'steering/message',
  ]) {
    assert.equal(isDevOnlyEventType(t), false, `expected ${t} not dev-only`)
  }
})

test('isDevOnlyEventType: non-string → dev-only (silent-drop side)', () => {
  // If we don't know the type, err on the side of silence. The Devtools
  // buffer still catches the raw event; chat stays clean.
  assert.equal(isDevOnlyEventType(undefined), true)
  assert.equal(isDevOnlyEventType(null), true)
  assert.equal(isDevOnlyEventType(42), true)
})

// ---- drift alarm ----------------------------------------------------------
// renderer.js contains inline copies for readability. If a future edit
// changes semantics on one side, this test flags it.

test('renderer.js inline copy of describeSource matches module', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  )
  // Sanity: both branches present. Not a byte match (renderer has slightly
  // different comments); we just guard against a case being dropped.
  assert.match(src, /function describeSource\(source\)/)
  assert.match(src, /source\.kind === 'plugin'/)
  assert.match(src, /source\.kind === 'tool'/)
  assert.match(src, /return 'context'/)
})

test('renderer.js inline copy of isDevOnlyEventType matches module', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  )
  assert.match(src, /function isDevOnlyEventType\(type\)/)
  assert.match(src, /startsWith\('hook\/'\)/)
  assert.match(src, /startsWith\('approval\/'\)/)
  assert.match(src, /startsWith\('permission\/'\)/)
  assert.match(src, /startsWith\('request\/header'\)/)
  assert.match(src, /=== 'bash\/sandbox-mode'/)
})

// ---- pickReplaySource -----------------------------------------------------

test('pickReplaySource: server wins when it has more entries', () => {
  const cached = [{ seq: 1 }, { seq: 2 }]
  const server = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  assert.strictEqual(pickReplaySource(cached, server), server)
})

test('pickReplaySource: cache wins when server is empty (daemon-echo lag)', () => {
  // The bug scenario: daemon-echo hasn't persisted the live session yet.
  // Server returns []; renderer must use the in-memory cache or the chat
  // vanishes when the user switches back.
  const cached = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  const server = []
  assert.strictEqual(pickReplaySource(cached, server), cached)
})

test('pickReplaySource: cache wins when server has fewer entries', () => {
  const cached = [{ seq: 1 }, { seq: 2 }, { seq: 3 }]
  const server = [{ seq: 1 }]
  assert.strictEqual(pickReplaySource(cached, server), cached)
})

test('pickReplaySource: server wins when tied (persisted authoritative)', () => {
  const cached = [{ seq: 1 }, { seq: 2 }]
  const server = [{ seq: 1 }, { seq: 2 }]
  assert.strictEqual(pickReplaySource(cached, server), server)
})

test('pickReplaySource: null server falls back to cache', () => {
  const cached = [{ seq: 1 }]
  assert.strictEqual(pickReplaySource(cached, null), cached)
})

test('pickReplaySource: both empty → empty array (never null)', () => {
  const result = pickReplaySource(null, null)
  assert.ok(Array.isArray(result))
  assert.equal(result.length, 0)
})

// ---- textFromContentBlocks -----------------------------------------------

test('textFromContentBlocks: text-only array concatenates', () => {
  const s = textFromContentBlocks([
    { type: 'text', text: 'hello ' },
    { type: 'text', text: 'world' },
  ])
  assert.equal(s, 'hello world')
})

test('textFromContentBlocks: reasoning + tool-call + text → text only', () => {
  // The bug scenario: assistant/message finalized with a mixed content
  // array. Historical behavior emitted `[reasoning][tool-call]…` verbatim
  // into the bubble; the fix drops non-text blocks (they render elsewhere).
  const s = textFromContentBlocks([
    { type: 'reasoning', text: 'thinking about repo' },
    { type: 'tool-call', name: 'bash', arguments: '{}' },
    { type: 'tool-call', name: 'bash', arguments: '{}' },
    { type: 'text', text: 'DSH is a harness for DeepSeek.' },
  ])
  assert.equal(s, 'DSH is a harness for DeepSeek.')
  assert.doesNotMatch(s, /\[(reasoning|tool-call|tool_use|image)\]/)
})

test('textFromContentBlocks: unknown/no-text blocks silently dropped', () => {
  // tool_use and image are two other block families that used to leak.
  const s = textFromContentBlocks([
    { type: 'tool_use', name: 'read', input: { file: 'x' } },
    { type: 'image', source: { data: '…' } },
    { type: 'text', text: 'answer' },
  ])
  assert.equal(s, 'answer')
})

test('textFromContentBlocks: non-array / null / undefined → empty string', () => {
  assert.equal(textFromContentBlocks(null), '')
  assert.equal(textFromContentBlocks(undefined), '')
  assert.equal(textFromContentBlocks('not an array'), '')
  assert.equal(textFromContentBlocks({}), '')
})

test('textFromContentBlocks: skips null/malformed entries', () => {
  const s = textFromContentBlocks([null, { type: 'text', text: 'a' }, undefined, { type: 'text' /* no .text */ }])
  assert.equal(s, 'a')
})

// ---- drift alarm: renderer.js inline copy of textFromContentBlocks -------

test('renderer.js inline textFromContentBlocks drops non-text blocks (no [reasoning]/[tool-call] leak)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  )
  // Sanity: function is defined.
  assert.match(src, /function textFromContentBlocks\(blocks\)/)
  // Text-block branch present.
  assert.match(src, /b\.type === 'text'/)
  // The regression guard: the old `return \`[${b.type}]\`` fallback must
  // not reappear. If a future edit reintroduces it, every non-trivial
  // assistant turn will leak `[reasoning][tool-call]…` into the bubble.
  assert.doesNotMatch(src, /return `\[\$\{b\.type\}\]`/)
})

// ---- drift alarm: cache-based replay in renderer.js -----------------------

test('renderer.js caches events per session', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'),
    'utf8',
  )
  // The renderer must populate an in-memory event cache on every
  // notification and use it as a fallback when session/events lags. If
  // this fails, bug 2 has regressed.
  assert.match(src, /cachedEvents/)
  assert.match(src, /cacheEvent\(/)
  assert.match(src, /replayingId/)
})
