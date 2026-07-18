// Devtools event-log model unit tests. Runs under `node --test`, no DOM.
//
// The model exports a small ring buffer + preset/type/text filter pipeline
// used by devtools-panel.js. Everything under test is pure — no timers, no
// notifications, no DOM. See devtools-model.js header for the design contract.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function load() {
  const p = require.resolve('../src/renderer/devtools-model.js')
  delete require.cache[p]
  return require('../src/renderer/devtools-model.js')
}

// -- ring buffer -------------------------------------------------------------

test('createBuffer: defaults to cap 500 and empty entries', () => {
  const M = load()
  const b = M.createBuffer()
  assert.equal(b.cap, 500)
  assert.deepEqual(b.entries, [])
  assert.equal(b.nextId, 1)
})

test('createBuffer: honours explicit cap; rejects garbage', () => {
  const M = load()
  assert.equal(M.createBuffer(10).cap, 10)
  assert.equal(M.createBuffer(0).cap, 500, 'zero falls back to default')
  assert.equal(M.createBuffer(-5).cap, 500, 'negative falls back to default')
  assert.equal(M.createBuffer('nope').cap, 500, 'non-number falls back')
  assert.equal(M.createBuffer(3.7).cap, 3, 'floor is applied')
})

test('addEvent: stamps monotonic id, normalises type/time/seq', () => {
  const M = load()
  const b = M.createBuffer(5)
  const e1 = M.addEvent(b, {
    sessionId: 'sid-1',
    event: { type: 'hook/invoked', time: 1000, seq: 4, data: { x: 1 } },
  })
  const e2 = M.addEvent(b, {
    sessionId: 'sid-2',
    event: { type: 'hook/result' }, // no time/seq
  })
  assert.equal(e1.id, 1)
  assert.equal(e1.sessionId, 'sid-1')
  assert.equal(e1.type, 'hook/invoked')
  assert.equal(e1.time, 1000)
  assert.equal(e1.seq, 4)
  assert.equal(e2.id, 2)
  assert.equal(e2.seq, null)
  assert.equal(typeof e2.time, 'number', 'time defaults to now')
  assert.equal(b.entries.length, 2)
})

test('addEvent: defaults for missing/garbage input never throw', () => {
  const M = load()
  const b = M.createBuffer()
  const e = M.addEvent(b, {})
  assert.equal(e.sessionId, '')
  assert.equal(e.type, '(unknown)')
  const e2 = M.addEvent(b, null)
  assert.equal(e2.type, '(unknown)')
  const e3 = M.addEvent(b, { sessionId: 42, event: { type: null } })
  assert.equal(e3.sessionId, '')
  assert.equal(e3.type, '(unknown)')
})

test('addEvent: ring buffer evicts oldest at cap', () => {
  const M = load()
  const b = M.createBuffer(3)
  M.addEvent(b, { sessionId: 's', event: { type: 'a' } })
  M.addEvent(b, { sessionId: 's', event: { type: 'b' } })
  M.addEvent(b, { sessionId: 's', event: { type: 'c' } })
  M.addEvent(b, { sessionId: 's', event: { type: 'd' } })
  M.addEvent(b, { sessionId: 's', event: { type: 'e' } })
  const types = M.getAll(b).map((e) => e.type)
  assert.deepEqual(types, ['c', 'd', 'e'])
  // Ids stay monotonic through eviction — a UI can rely on them for keys.
  const ids = M.getAll(b).map((e) => e.id)
  assert.deepEqual(ids, [3, 4, 5])
})

test('clearBuffer: empties entries; nextId keeps counting', () => {
  const M = load()
  const b = M.createBuffer()
  M.addEvent(b, { sessionId: 's', event: { type: 'a' } })
  M.addEvent(b, { sessionId: 's', event: { type: 'b' } })
  M.clearBuffer(b)
  assert.equal(b.entries.length, 0)
  const e = M.addEvent(b, { sessionId: 's', event: { type: 'c' } })
  assert.equal(e.id, 3, 'nextId survives clear so ids stay unique')
})

test('getAll: returns a fresh array; mutating it does not affect the buffer', () => {
  const M = load()
  const b = M.createBuffer()
  M.addEvent(b, { sessionId: 's', event: { type: 'a' } })
  const snap = M.getAll(b)
  snap.push({ hostile: true })
  assert.equal(b.entries.length, 1)
})

// -- pattern matching --------------------------------------------------------

test('matchesPattern: exact and prefix-star patterns', () => {
  const M = load()
  assert.equal(M.matchesPattern('hook/invoked', 'hook/invoked'), true)
  assert.equal(M.matchesPattern('hook/invoked', 'hook/*'), true)
  assert.equal(M.matchesPattern('hook/result', 'hook/*'), true)
  assert.equal(M.matchesPattern('approval/asked', 'hook/*'), false)
  assert.equal(M.matchesPattern('hook', 'hook/*'), false, 'no trailing slash → no match')
  assert.equal(M.matchesPattern('foo/bar', 'foo/bar'), true)
  assert.equal(M.matchesPattern('foo/barbaz', 'foo/bar'), false, 'exact mode is strict')
})

test('matchesPattern: bad input never throws, returns false', () => {
  const M = load()
  assert.equal(M.matchesPattern(null, 'hook/*'), false)
  assert.equal(M.matchesPattern('x', null), false)
})

test('matchesPreset: All matches anything; unknown preset falls through to All', () => {
  const M = load()
  assert.equal(M.matchesPreset('anything', 'All'), true)
  assert.equal(M.matchesPreset('anything', 'DoesNotExist'), true)
})

test('matchesPreset: Approvals covers approval/* and permission/*', () => {
  const M = load()
  assert.equal(M.matchesPreset('approval/asked', 'Approvals'), true)
  assert.equal(M.matchesPreset('approval/decided', 'Approvals'), true)
  assert.equal(M.matchesPreset('permission/preset', 'Approvals'), true)
  assert.equal(M.matchesPreset('hook/invoked', 'Approvals'), false)
})

test('matchesPreset: Hooks covers hook/*; Requests covers request/header{,-delta}', () => {
  const M = load()
  assert.equal(M.matchesPreset('hook/invoked', 'Hooks'), true)
  assert.equal(M.matchesPreset('hook/result', 'Hooks'), true)
  assert.equal(M.matchesPreset('approval/asked', 'Hooks'), false)
  assert.equal(M.matchesPreset('request/header', 'Requests'), true)
  assert.equal(M.matchesPreset('request/header-delta', 'Requests'), true)
  assert.equal(M.matchesPreset('request/other', 'Requests'), false, 'not blanket request/*')
})

// -- filterEntries -----------------------------------------------------------

function seed(M, tuples) {
  const b = M.createBuffer()
  for (const [sid, type, extra] of tuples) {
    M.addEvent(b, { sessionId: sid, event: Object.assign({ type }, extra || {}) })
  }
  return b
}

test('filterEntries: no filters returns everything in insertion order', () => {
  const M = load()
  const b = seed(M, [
    ['s1', 'a'], ['s1', 'b'], ['s2', 'c'],
  ])
  const out = M.filterEntries(M.getAll(b))
  assert.deepEqual(out.map((e) => e.type), ['a', 'b', 'c'])
})

test('filterEntries: preset filter restricts to the preset patterns', () => {
  const M = load()
  const b = seed(M, [
    ['s', 'hook/invoked'], ['s', 'approval/asked'],
    ['s', 'tool/call'], ['s', 'hook/result'],
  ])
  const hooks = M.filterEntries(M.getAll(b), { preset: 'Hooks' })
  assert.deepEqual(hooks.map((e) => e.type), ['hook/invoked', 'hook/result'])
  const approvals = M.filterEntries(M.getAll(b), { preset: 'Approvals' })
  assert.deepEqual(approvals.map((e) => e.type), ['approval/asked'])
})

test('filterEntries: type set narrows further (AND with preset)', () => {
  const M = load()
  const b = seed(M, [
    ['s', 'hook/invoked'], ['s', 'hook/result'], ['s', 'approval/asked'],
  ])
  const out = M.filterEntries(M.getAll(b), {
    preset: 'Hooks',
    types: new Set(['hook/result']),
  })
  assert.deepEqual(out.map((e) => e.type), ['hook/result'])
})

test('filterEntries: empty type Set is no restriction (regression: 0 / N drawer)', () => {
  // Regression: the controller keeps `state.typeFilter` as a Set that starts
  // empty and grows as the user clicks chips. Passing that empty Set through
  // filterEntries must NOT filter out every entry — otherwise the drawer
  // shows "0 / 181 · No events match the current filter" the moment it opens,
  // which was the observed round-4 devtools-drawer bug. Guard against
  // regression on both preset variants.
  const M = load()
  const b = seed(M, [
    ['s', 'user/message'], ['s', 'assistant/message'], ['s', 'turn/end'],
  ])
  const withEmptySet = M.filterEntries(M.getAll(b), {
    preset: 'All',
    types: new Set(),
    text: '',
  })
  assert.equal(withEmptySet.length, 3)
  const withoutOpts = M.filterEntries(M.getAll(b))
  assert.equal(withoutOpts.length, 3)
})

test('filterEntries: empty type Array is also no restriction', () => {
  const M = load()
  const b = seed(M, [['s', 'a'], ['s', 'b']])
  assert.equal(M.filterEntries(M.getAll(b), { types: [] }).length, 2)
})

test('filterEntries: type set accepts arrays too', () => {
  const M = load()
  const b = seed(M, [
    ['s', 'a'], ['s', 'b'], ['s', 'c'],
  ])
  const out = M.filterEntries(M.getAll(b), { types: ['a', 'c'] })
  assert.deepEqual(out.map((e) => e.type), ['a', 'c'])
})

test('filterEntries: text search hits type, sessionId, and serialised payload', () => {
  const M = load()
  const b = seed(M, [
    ['abc-session', 'hook/invoked', { data: { matcher: 'PreToolUse' } }],
    ['def-session', 'tool/call', { data: { name: 'bash' } }],
    ['xyz-session', 'approval/asked', { data: { reason: 'sensitive read' } }],
  ])
  // Type hit.
  assert.equal(M.filterEntries(M.getAll(b), { text: 'hook' }).length, 1)
  // Session hit.
  assert.equal(M.filterEntries(M.getAll(b), { text: 'xyz' }).length, 1)
  // Payload hit (case-insensitive).
  assert.equal(M.filterEntries(M.getAll(b), { text: 'BASH' }).length, 1)
  // Payload deep hit.
  assert.equal(M.filterEntries(M.getAll(b), { text: 'sensitive' }).length, 1)
})

test('filterEntries: text search of empty/whitespace is a no-op', () => {
  const M = load()
  const b = seed(M, [['s', 'a'], ['s', 'b']])
  assert.equal(M.filterEntries(M.getAll(b), { text: '' }).length, 2)
  assert.equal(M.filterEntries(M.getAll(b), { text: '   ' }).length, 2)
})

test('filterEntries: circular event payload does not crash the text filter', () => {
  const M = load()
  const b = M.createBuffer()
  const circ = { type: 'x' }
  circ.self = circ
  M.addEvent(b, { sessionId: 's', event: circ })
  // Type search still works; payload search silently skips the JSON path.
  assert.equal(M.filterEntries(M.getAll(b), { text: 'x' }).length, 1)
  assert.equal(M.filterEntries(M.getAll(b), { text: 'noSuchToken' }).length, 0)
})

// -- collectTypes ------------------------------------------------------------

test('collectTypes: returns sorted unique types', () => {
  const M = load()
  const b = seed(M, [
    ['s', 'zeta'], ['s', 'alpha'], ['s', 'zeta'], ['s', 'beta'],
  ])
  assert.deepEqual(M.collectTypes(M.getAll(b)), ['alpha', 'beta', 'zeta'])
  assert.deepEqual(M.collectTypes([]), [])
})

// -- formatting --------------------------------------------------------------

test('formatJSON: pretty-prints; falls back on circular', () => {
  const M = load()
  assert.equal(M.formatJSON({ a: 1 }), '{\n  "a": 1\n}')
  const circ = { a: 1 }
  circ.self = circ
  const out = M.formatJSON(circ)
  assert.equal(typeof out, 'string')
  assert.notEqual(out, '') // some string, not a crash
})

test('formatTime: HH:MM:SS.mmm padded; garbage yields dashes', () => {
  const M = load()
  // 1 Jan 1970 00:00:01.234 UTC — asserting shape not zone-specific digits.
  const out = M.formatTime(1234)
  assert.match(out, /^\d{2}:\d{2}:\d{2}\.\d{3}$/)
  assert.equal(M.formatTime(NaN), '--:--:--')
  assert.equal(M.formatTime('nope'), '--:--:--')
})

// -- module surface ----------------------------------------------------------

test('module surface: exports the documented api', () => {
  const M = load()
  const keys = [
    'DEFAULT_CAP', 'PRESETS',
    'createBuffer', 'addEvent', 'clearBuffer', 'getAll',
    'filterEntries', 'matchesPreset', 'matchesPattern', 'collectTypes',
    'formatJSON', 'formatTime', 'normalizeEntry',
  ]
  for (const k of keys) assert.ok(k in M, `missing export: ${k}`)
  assert.equal(M.DEFAULT_CAP, 500)
  // Preset names are UI-facing; assert them so a rename breaks the test on
  // purpose (the controller relies on them by name).
  assert.deepEqual(Object.keys(M.PRESETS).sort(), ['All', 'Approvals', 'Hooks', 'Requests'])
})
