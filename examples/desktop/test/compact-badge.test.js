// Unit tests for the compact-badge classifier (task #103 P0-3).
//
// docs/context-fork-intent.md §2.2 says auto and manual compaction are
// distinguishable in the log by the enclosing turn's `trigger`:
// `{ kind: 'injection', source: { kind: 'plugin', plugin: 'compact' } }`
// is the manual (compactOnDemand) shape; anything else means the compact
// happened inside a turn the runtime was already in (auto / pre-step
// safety valve). The intent doc's red-line says the classifier must read
// straight from `trigger.source.plugin === 'compact'` and never reverse-
// engineer from UI state — that's what these tests pin.
//
// Runs under `node --test`; the classifier is pure so no DOM shim needed.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { classifyCompactTrigger } = require('../src/renderer/compact-badge.js')

test('manual — injection turn whose source is plugin:compact', () => {
  const badge = classifyCompactTrigger({
    kind: 'injection',
    source: { kind: 'plugin', plugin: 'compact' },
  })
  assert.ok(badge, 'expected a badge, got null')
  assert.equal(badge.kind, 'manual')
  assert.equal(badge.label, 'manual')
  assert.match(badge.hint, /asked/i, 'manual hint should tell the user *they* triggered it')
})

test('auto — user turn (compact fired inside a running prompt, pre-step)', () => {
  const badge = classifyCompactTrigger({ kind: 'user' })
  assert.ok(badge)
  assert.equal(badge.kind, 'auto')
  assert.equal(badge.label, 'auto')
  assert.match(badge.hint, /context window|protect/i)
})

test('auto — injection turn but source is a different plugin', () => {
  // A steering plugin injects context; if compaction fires during that turn
  // it's still an auto (reactive) event, not a manual one. The classifier
  // must not treat every injection turn as manual.
  const badge = classifyCompactTrigger({
    kind: 'injection',
    source: { kind: 'plugin', plugin: 'steering' },
  })
  assert.equal(badge.kind, 'auto')
})

test('auto — injection turn with a non-plugin source (tool, subagent-fork)', () => {
  const badge = classifyCompactTrigger({
    kind: 'injection',
    source: { kind: 'tool', tool: 'inject_context' },
  })
  assert.equal(badge.kind, 'auto')
})

test('null when trigger is missing — caller must skip the badge', () => {
  // A persisted-only replay may not carry the turn/start; better to omit
  // the badge than to guess wrong. Pin every "no data" branch.
  assert.equal(classifyCompactTrigger(null), null)
  assert.equal(classifyCompactTrigger(undefined), null)
  assert.equal(classifyCompactTrigger('user'), null, 'stringy trigger is not the object shape we contract')
  assert.equal(classifyCompactTrigger(42), null)
})

test('manual — case-sensitive plugin name (`Compact` is NOT `compact`)', () => {
  // The plugin name in the log is the exact `plugin.name` string. Guard
  // against a well-intentioned but wrong toLowerCase() creeping in.
  const badge = classifyCompactTrigger({
    kind: 'injection',
    source: { kind: 'plugin', plugin: 'Compact' },
  })
  assert.equal(badge.kind, 'auto', 'case mismatch must not upgrade to manual')
})

test('manual — plugin source missing sub-fields — still auto (safe default)', () => {
  // If the source shape is malformed we lean auto: the manual label is the
  // stronger claim ("you did this") so a wrong-manual is worse than a
  // wrong-auto.
  assert.equal(classifyCompactTrigger({ kind: 'injection', source: {} }).kind, 'auto')
  assert.equal(classifyCompactTrigger({ kind: 'injection', source: null }).kind, 'auto')
  assert.equal(classifyCompactTrigger({ kind: 'injection' }).kind, 'auto')
})
