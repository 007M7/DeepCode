// Ticket #128 — Devtools surface classification + filter.
//
// Three-way partition of every buffered event by "surface":
//   - current   → shown in the chat pane and still in scope
//   - shadowed  → was on-surface once, now replaced by a compact summary
//   - log-only  → never on the chat surface (audit families: hook/*,
//                  request/*, approval/*, permission/*, bash/sandbox-mode,
//                  step/*, tool/code-dispatch, and their friends)
//
// The pure classifier + filter live under DevtoolsModel so the DOM controller
// stays a thin glue and this file can drive them without an Electron process.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const M = require('../src/renderer/devtools-model.js')

// -- deriveSurface -----------------------------------------------------------

test('deriveSurface: audit-family events → log-only regardless of seq/shadow set', () => {
  const shadowed = new Set([10, 11, 12])
  for (const t of ['hook/invoked', 'hook/result', 'approval/requested', 'permission/denied',
    'request/header', 'request/header-delta', 'bash/sandbox-mode',
    'step/started', 'step/completed', 'tool/code-dispatch']) {
    const s = M.deriveSurface({ type: t, seq: 10 }, shadowed)
    assert.equal(s, 'log-only', `expected log-only for ${t}, got ${s}`)
  }
})

test('deriveSurface: chat-family with seq in shadowedSeqs → shadowed', () => {
  const shadowed = new Set([5, 6, 7])
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: 5 }, shadowed), 'shadowed')
  assert.equal(M.deriveSurface({ type: 'user/message', seq: 6 }, shadowed), 'shadowed')
  assert.equal(M.deriveSurface({ type: 'tool/started', seq: 7 }, shadowed), 'shadowed')
})

test('deriveSurface: chat-family with seq NOT in shadow set → current', () => {
  const shadowed = new Set([5, 6, 7])
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: 42 }, shadowed), 'current')
  assert.equal(M.deriveSurface({ type: 'turn/started', seq: 100 }, shadowed), 'current')
})

test('deriveSurface: null/undefined shadow set → current for chat family', () => {
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: 1 }, null), 'current')
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: 1 }, undefined), 'current')
})

test('deriveSurface: null/no seq → current if chat-family, log-only if audit', () => {
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: null }, new Set([1])), 'current')
  assert.equal(M.deriveSurface({ type: 'hook/invoked' }, new Set([1])), 'log-only')
})

test('deriveSurface: honors explicit event.surface when server sets it (wire promise)', () => {
  // RFC (renderer.js:1046 comment) says the wire promises `event.surface` will
  // ship one day. Prefer that over derivation when present, so we're forward-
  // compatible with the sq-meta ticket that lands it.
  assert.equal(M.deriveSurface({ type: 'assistant/message', seq: 999, surface: 'shadowed' }, new Set()), 'shadowed')
  assert.equal(M.deriveSurface({ type: 'hook/invoked', surface: 'current' }, new Set()), 'current')
})

// -- buildShadowedSet from compact events ------------------------------------

test('buildShadowedSet: gathers seqs from every compact event in the buffer', () => {
  const events = [
    { type: 'assistant/message', seq: 1 },
    { type: 'compact/started', seq: 5, event: { shadowedSeqs: [1, 2, 3] } },
    { type: 'assistant/message', seq: 10 },
    { type: 'compact/started', seq: 20, event: { shadowedSeqs: [10, 11] } },
  ].map((e) => ({ type: e.type, seq: e.seq, event: e.event || {} }))
  const s = M.buildShadowedSet(events)
  assert.deepStrictEqual([...s].sort((a, b) => a - b), [1, 2, 3, 10, 11])
})

test('buildShadowedSet: empty / missing shadowedSeqs → empty set', () => {
  const events = [
    { type: 'assistant/message', seq: 1, event: {} },
    { type: 'compact/started', seq: 5, event: {} },
  ]
  const s = M.buildShadowedSet(events)
  assert.equal(s.size, 0)
})

// -- filterEntries: surface option ------------------------------------------

test('filterEntries: surfaces=Set(current) keeps only current-surface entries', () => {
  const entries = [
    entry(1, 'assistant/message', 100),           // current (no shadow set)
    entry(2, 'hook/invoked', null),               // log-only
    entry(3, 'assistant/message', 5, 'shadowed'), // explicit shadowed
  ]
  const kept = M.filterEntries(entries, { surfaces: new Set(['current']), shadowedSeqs: new Set() })
  assert.deepStrictEqual(kept.map((e) => e.id), [1])
})

test('filterEntries: surfaces=Set(current,shadowed) drops only log-only', () => {
  const entries = [
    entry(1, 'assistant/message', 100),
    entry(2, 'hook/invoked', null),
    entry(3, 'assistant/message', 5, 'shadowed'),
  ]
  const kept = M.filterEntries(entries, { surfaces: new Set(['current', 'shadowed']), shadowedSeqs: new Set() })
  assert.deepStrictEqual(kept.map((e) => e.id), [1, 3])
})

test('filterEntries: empty surfaces set = no surface restriction (parity with types)', () => {
  const entries = [
    entry(1, 'assistant/message', 100),
    entry(2, 'hook/invoked', null),
  ]
  const kept = M.filterEntries(entries, { surfaces: new Set(), shadowedSeqs: new Set() })
  assert.equal(kept.length, 2)
})

test('filterEntries: surfaces composes with preset+types+text (AND)', () => {
  const entries = [
    entry(1, 'hook/invoked', null),
    entry(2, 'hook/result', null),
    entry(3, 'approval/requested', null),
  ]
  const kept = M.filterEntries(entries, {
    surfaces: new Set(['log-only']),
    preset: 'Hooks',
    text: 'result',
    shadowedSeqs: new Set(),
  })
  assert.deepStrictEqual(kept.map((e) => e.id), [2])
})

test('filterEntries: shadowed lookup uses buffer-derived shadowedSeqs when entry lacks event.surface', () => {
  const entries = [
    entry(1, 'assistant/message', 5),  // seq 5 is in the shadow set → shadowed
    entry(2, 'assistant/message', 42), // seq 42 not in set → current
  ]
  const kept = M.filterEntries(entries, { surfaces: new Set(['shadowed']), shadowedSeqs: new Set([5]) })
  assert.deepStrictEqual(kept.map((e) => e.id), [1])
})

// -- counts by surface (for chip badges) ------------------------------------

test('countsBySurface: three-way tally over the buffer', () => {
  const entries = [
    entry(1, 'assistant/message', 100),
    entry(2, 'assistant/message', 5),       // will be shadowed
    entry(3, 'hook/invoked', null),
    entry(4, 'hook/result', null),
    entry(5, 'user/message', 200),
  ]
  const counts = M.countsBySurface(entries, new Set([5]))
  assert.equal(counts.current, 2)
  assert.equal(counts.shadowed, 1)
  assert.equal(counts['log-only'], 2)
})

// -- timeline ordering ------------------------------------------------------

test('filterEntries preserves buffer order (timeline reads oldest→newest)', () => {
  // The Devtools panel expects the filtered list to stay in the same order
  // the ring buffer stores. Timeline reads top-to-bottom → oldest-to-newest,
  // and the autoscroll-to-tail affordance depends on this invariant.
  const entries = [
    entry(1, 'assistant/message', 1),
    entry(2, 'hook/invoked', null),
    entry(3, 'compact/started', 5, undefined),
    entry(4, 'assistant/message', 6),
    entry(5, 'hook/result', null),
    entry(6, 'user/message', 7),
  ]
  const all = M.filterEntries(entries, {})
  assert.deepStrictEqual(all.map((e) => e.id), [1, 2, 3, 4, 5, 6])
  // A narrower surface filter still preserves relative order.
  const currentOnly = M.filterEntries(entries, {
    surfaces: new Set(['current']),
    shadowedSeqs: new Set(),
  })
  assert.deepStrictEqual(currentOnly.map((e) => e.id), [1, 3, 4, 6])
})

test('countsBySurface respects the same shadowedSeqs derivation as filterEntries', () => {
  // Regression guard: the surface pill badges and the filter chip badges
  // both call countsBySurface(all, shadowedSeqs); filterEntries then keeps
  // exactly those rows. The two must never disagree — otherwise a chip says
  // "12 current" and expanding it shows a different number.
  const entries = [
    entry(1, 'assistant/message', 5),           // shadowed via set
    entry(2, 'assistant/message', 6),           // shadowed via set
    entry(3, 'assistant/message', 42),          // current
    entry(4, 'hook/invoked', null),             // log-only
    entry(5, 'assistant/message', 999, 'shadowed'), // explicit surface (wire promise)
    entry(6, 'request/header', null),           // log-only
  ]
  const shadowedSeqs = new Set([5, 6])
  const counts = M.countsBySurface(entries, shadowedSeqs)
  for (const s of M.SURFACES) {
    const kept = M.filterEntries(entries, { surfaces: new Set([s]), shadowedSeqs })
    assert.equal(kept.length, counts[s],
      `filter/count mismatch for surface="${s}": filter=${kept.length}, count=${counts[s]}`)
  }
})

test('SURFACES enumerates exactly the three buckets (chip render contract)', () => {
  // The controller iterates M.SURFACES to render one chip per bucket, and
  // countsBySurface returns exactly these keys. Locks the list so a rename
  // never silently drops a chip.
  assert.deepStrictEqual([...M.SURFACES], ['current', 'shadowed', 'log-only'])
})

test('LOG_ONLY_PATTERNS covers every audit family the surface partition claims', () => {
  // Ticket brief lists: hook/*, approval/*, permission/*, request/header,
  // request/header-delta, bash/sandbox-mode, step/*, tool/code-dispatch.
  // A drift here would leak audit-family events onto the "current" chip.
  for (const t of [
    'hook/invoked', 'hook/result',
    'approval/requested', 'permission/denied',
    'request/header', 'request/header-delta',
    'bash/sandbox-mode',
    'step/started', 'step/completed',
    'tool/code-dispatch',
  ]) {
    assert.equal(M.deriveSurface({ type: t }, new Set()), 'log-only',
      `LOG_ONLY_PATTERNS should classify ${t} as log-only`)
  }
})

// -- helpers -----------------------------------------------------------------

function entry(id, type, seq, surface) {
  const ev = { type, seq }
  if (surface) ev.surface = surface
  return { id, time: id * 1000, sessionId: 's', type, seq, event: ev }
}
