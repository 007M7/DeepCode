// Tests for src/renderer/quick-chat.js's pure recent-session selector.
//
// The module is a script-tag renderer file that attaches to `window`. We
// load it via a very small DOM stub so `node --test` can exercise the pure
// helper without a real browser. Anything that touches the DOM is stubbed
// to no-op; only pickRecentSessions is exercised.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

// Minimal DOM/window stubs. The module registers listeners on document and
// exposes helpers on `window`; we intercept both.
function loadModule() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'quick-chat.js'),
    'utf8',
  )
  const documentStub = {
    createElement: () => ({
      appendChild() {}, setAttribute() {}, addEventListener() {},
      classList: { add() {}, remove() {}, toggle() {} },
      style: {},
    }),
    createElementNS: () => ({ setAttribute() {}, appendChild() {}, innerHTML: '' }),
    body: { appendChild() {} },
    getElementById: () => null,
    addEventListener() {},
  }
  const windowStub = {
    __dshChat: null,
    __dshTabs: null,
    __dshQuickChatInternals: null,
    dsh: null,
    document: documentStub,
    requestAnimationFrame(cb) { cb() },
    alert() {},
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(windowStub, documentStub)
  return windowStub.__dshQuickChatInternals
}

const { pickRecentSessions } = loadModule()

test('pickRecentSessions: prefers running sessions', () => {
  const rows = pickRecentSessions([
    { sessionId: 'a', running: false, lastEventTime: 1000 },
    { sessionId: 'b', running: true, lastEventTime: 500 },
    { sessionId: 'c', running: false, lastEventTime: 2000 },
  ], 5)
  assert.equal(rows[0].sessionId, 'b') // running wins
})

test('pickRecentSessions: then live over persisted-only', () => {
  const rows = pickRecentSessions([
    { sessionId: 'a', running: false, live: false, lastEventTime: 1000 },
    { sessionId: 'b', running: false, live: true, lastEventTime: 500 },
  ], 5)
  assert.equal(rows[0].sessionId, 'b')
})

test('pickRecentSessions: then by lastEventTime desc', () => {
  const rows = pickRecentSessions([
    { sessionId: 'a', running: false, lastEventTime: 100 },
    { sessionId: 'b', running: false, lastEventTime: 300 },
    { sessionId: 'c', running: false, lastEventTime: 200 },
  ], 5)
  assert.deepEqual(rows.map((r) => r.sessionId), ['b', 'c', 'a'])
})

test('pickRecentSessions: caps to limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, lastEventTime: i }))
  const rows = pickRecentSessions(many, 5)
  assert.equal(rows.length, 5)
  // The highest lastEventTime wins ties on `running/live=false`.
  assert.equal(rows[0].sessionId, 's19')
})

test('pickRecentSessions: handles non-array input', () => {
  assert.deepEqual(pickRecentSessions(null), [])
  assert.deepEqual(pickRecentSessions(undefined), [])
  assert.deepEqual(pickRecentSessions('nope'), [])
})

test('pickRecentSessions: missing lastEventTime is treated as 0', () => {
  const rows = pickRecentSessions([
    { sessionId: 'a' },
    { sessionId: 'b', lastEventTime: 1 },
  ], 5)
  assert.equal(rows[0].sessionId, 'b')
})

test('pickRecentSessions: drops rows flagged hasUserMessage:false', () => {
  // QA round-2 P1: quick-chat used to list smoke fixtures + abandoned
  // "+ New chat" stubs alongside real sessions. Empty stubs should be
  // filtered so the row list matches what the sidebar shows.
  const rows = pickRecentSessions([
    { sessionId: 'real', lastEventTime: 100, hasUserMessage: true },
    { sessionId: 'stub', lastEventTime: 200, hasUserMessage: false },
  ], 5)
  assert.deepEqual(rows.map((r) => r.sessionId), ['real'])
})

test('pickRecentSessions: rows without the flag still count (backwards compat)', () => {
  // Older callers / older shells never set the flag — those pass through so
  // the helper stays usable outside the enriched-entries path.
  const rows = pickRecentSessions([
    { sessionId: 'a', lastEventTime: 100 },
    { sessionId: 'b', lastEventTime: 200 },
  ], 5)
  assert.equal(rows.length, 2)
})
