// Unit tests for src/main/plugin-heuristics.js — A3 effect heuristics.
// The module is pure: fixtures are hand-built entry lists.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const H = require('../src/main/plugin-heuristics.js')

test('summarize: empty entries → zero counts, no conflicts, no warning', () => {
  const s = H.summarize({ entries: [] })
  assert.equal(s.enabledCount, 0)
  assert.equal(s.disabledCount, 0)
  assert.equal(s.totalCount, 0)
  assert.deepEqual(s.conflicts, [])
  assert.equal(s.toolWarning, null)
})

test('summarize: enabled/disabled counts split correctly', () => {
  const s = H.summarize({
    entries: [
      { id: 'bash', disabled: false },
      { id: 'fs' },
      { id: 'net', disabled: true },
    ],
  })
  assert.equal(s.enabledCount, 2)
  assert.equal(s.disabledCount, 1)
  assert.equal(s.totalCount, 3)
})

test('summarize: near-name conflict (edit distance 1) flagged', () => {
  const s = H.summarize({
    entries: [
      { id: 'bash-local' },
      { id: 'bash-locel' }, // typo
    ],
  })
  assert.equal(s.conflicts.length, 1)
  assert.equal(s.conflicts[0].kind, 'edit-distance')
  assert.deepEqual(
    [s.conflicts[0].a, s.conflicts[0].b].sort(),
    ['bash-local', 'bash-locel'],
  )
})

test('summarize: prefix-overlap conflict flagged', () => {
  const s = H.summarize({
    entries: [
      { id: 'bash' },
      { id: 'bash-local' },
    ],
  })
  assert.equal(s.conflicts.length, 1)
  assert.equal(s.conflicts[0].kind, 'prefix')
})

test('summarize: disabled entries do not participate in conflict detection', () => {
  const s = H.summarize({
    entries: [
      { id: 'bash-local' },
      { id: 'bash-locel', disabled: true },
    ],
  })
  assert.equal(s.conflicts.length, 0)
})

test('summarize: short ids (<4 chars) skipped in conflict detection', () => {
  const s = H.summarize({
    entries: [
      { id: 'fs' },
      { id: 'os' },
      { id: 'ls' },
    ],
  })
  assert.equal(s.conflicts.length, 0)
})

test('summarize: distance 2 is NOT flagged by A3 (A1 already covers dist≤2)', () => {
  // "abcd" vs "abef" differ by 2 chars — A1 flags this, A3 uses a tighter
  // threshold to avoid noise in the summary bar.
  const s = H.summarize({
    entries: [
      { id: 'abcd' },
      { id: 'abef' },
    ],
  })
  assert.equal(s.conflicts.length, 0)
})

test('summarize: tool warning fires at custom threshold', () => {
  const many = []
  for (let i = 0; i < 5; i++) many.push({ id: `plugin${i}` })
  const s = H.summarize({ entries: many, toolWarnAt: 3 })
  assert.ok(s.toolWarning)
  assert.equal(s.toolWarning.count, 5)
  assert.equal(s.toolWarning.threshold, 3)
})

test('summarize: tool warning does not fire when at or below threshold', () => {
  const s = H.summarize({
    entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    toolWarnAt: 3,
  })
  assert.equal(s.toolWarning, null)
})

test('summarize: default toolWarnAt is 30', () => {
  const many = []
  for (let i = 0; i < 31; i++) many.push({ id: `p${i}` })
  const s = H.summarize({ entries: many })
  assert.ok(s.toolWarning)
  assert.equal(s.toolWarning.threshold, 30)
})

test('findConflicts: prefix takes precedence over edit-distance for same pair', () => {
  // 'test' vs 'test1' — prefix overlap AND edit distance 1. The prefix
  // branch fires first and marks the pair, so we only see one entry.
  const pairs = H.findConflicts(['test', 'test1'])
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].kind, 'prefix')
})

test('findConflicts: each pair emitted at most once even in noisy input', () => {
  const pairs = H.findConflicts(['abcd', 'abce', 'abce', 'abcd'])
  // Duplicates on the input list are de-duped in output via the pair-key set.
  assert.equal(pairs.length, 1)
})

test('editDistance: sanity — matches known cases', () => {
  assert.equal(H.editDistance('kitten', 'sitting'), 3)
  assert.equal(H.editDistance('bash', 'bash'), 0)
  assert.equal(H.editDistance('', 'abc'), 3)
})
