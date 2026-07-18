// Tests for src/renderer/compact-card.js — task #137.
//
// Pure functions the tab shell relies on:
//   classifyTriggerKind(trigger) — maps turn/start.trigger to
//     on-demand / pre-step / idle.
//   formatStrategyRows(data, triggerKind) — deterministic label→value
//     rendering with no invented fallbacks.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { classifyTriggerKind, formatStrategyRows, buildDiffModel, TRIGGER_LABELS } =
  require('../src/renderer/compact-card.js')

test('classifyTriggerKind: manual compact = on-demand', () => {
  // strategy list §1.7 says compactOnDemand wraps itself in a self-injected
  // turn whose source.plugin === 'compact'. This is the "user pressed
  // Compact" bucket, not a mid-turn safety valve.
  const trigger = { kind: 'injection', source: { kind: 'plugin', plugin: 'compact' } }
  assert.equal(classifyTriggerKind(trigger), 'on-demand')
})

test('classifyTriggerKind: user turn with mid-turn compact = pre-step', () => {
  // agent/pre-step listener fires the compact — the enclosing turn is the
  // user's original turn (kind:'user'). This is the "runtime saved you"
  // bucket.
  assert.equal(classifyTriggerKind({ kind: 'user' }), 'pre-step')
})

test('classifyTriggerKind: unknown / missing trigger = idle', () => {
  assert.equal(classifyTriggerKind(null), 'idle')
  assert.equal(classifyTriggerKind(undefined), 'idle')
  assert.equal(classifyTriggerKind({}), 'idle')
  // Non-compact plugin injection shouldn't read as on-demand.
  assert.equal(classifyTriggerKind({ kind: 'injection', source: { kind: 'plugin', plugin: 'steering' } }), 'idle')
})

test('formatStrategyRows: full payload emits every row in declared order', () => {
  const data = {
    model: 'deepseek-chat',
    maxTokens: 512,
    shadowedRange: { start: 1, end: 149 },
    shadowedTokenCount: 32180,
    shadowedSeqs: Array.from({ length: 27 }, (_, i) => i + 1),
    reason: 'manual cleanup of a long session',
  }
  const rows = formatStrategyRows(data, 'on-demand')
  // Trigger row is always first — a reader needs the "why" before the "what".
  assert.equal(rows[0].label, 'Trigger')
  assert.equal(rows[0].value, TRIGGER_LABELS['on-demand'])
  assert.deepEqual(rows.map((r) => r.label), [
    'Trigger', 'Summary model', 'Summary cap', 'Compacted range',
    'Compacted volume', 'Event count', 'User reason',
  ])
  assert.equal(rows[1].value, 'deepseek-chat')
  assert.equal(rows[2].value, '≤512 tok')
  assert.equal(rows[3].value, 'seq 1 – 149')
  assert.equal(rows[4].value, '32180 tok')
  assert.equal(rows[5].value, '27 events')
  assert.equal(rows[6].value, 'manual cleanup of a long session')
})

test('formatStrategyRows: missing fields drop rows (no invented placeholders)', () => {
  const rows = formatStrategyRows({ shadowedRange: { start: 10, end: 20 } }, 'pre-step')
  assert.deepEqual(rows.map((r) => r.label), ['Trigger', 'Compacted range'])
  assert.equal(rows[1].value, 'seq 10 – 20')
})

test('formatStrategyRows: shadowedSeqs=[] still renders "Event count: 0 events"', () => {
  const rows = formatStrategyRows({ shadowedSeqs: [] }, 'idle')
  const eventsRow = rows.find((r) => r.label === 'Event count')
  assert.ok(eventsRow)
  assert.equal(eventsRow.value, '0 events')
})

test('formatStrategyRows: whitespace-only reason drops', () => {
  const rows = formatStrategyRows({ reason: '   ' }, 'on-demand')
  assert.equal(rows.some((r) => r.label === 'User reason'), false)
})

// -- buildDiffModel (rec 32 "前后对照" tab; §8.3 ruling) -------------------
//
// The Diff model unifies the three left-column shapes (fixture preview /
// wire shadowedSeqs / range-only) plus header ratio math into one plain
// object so the DOM layer (renderer.js) only paints, and tests can drive
// the classifier + numbers without a DOM.

const extractPlainText = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

test('buildDiffModel: fixture _shadowedPreview → preview source with rows', () => {
  const model = buildDiffModel({
    shadowedRange: { start: 100, end: 102 },
    shadowedTokenCount: 800,
    shadowedSeqs: [100, 101, 102],
    _shadowedPreview: [
      { seq: 100, type: 'user/message',      gist: 'ask' },
      { seq: 101, type: 'assistant/message', gist: 'plan' },
      { seq: 102, type: 'tool/call',         gist: 'read(x)' },
    ],
    summary: [{ type: 'text', text: 'summary a b c d' }],  // 16 chars → 4 tok
  }, extractPlainText)

  assert.equal(model.left.source, 'preview')
  assert.equal(model.left.rows.length, 3)
  assert.equal(model.left.rows[0].seq, 100)
  assert.equal(model.left.rows[2].gist, 'read(x)')
  assert.equal(model.header.events, 3)
  assert.equal(model.header.beforeTokens, 800)
  assert.equal(model.header.afterTokens, 4)
  // ratio = before / after; 800/4 = 200
  assert.equal(model.header.ratio, 200)
  assert.equal(model.right.text, 'summary a b c d')
})

test('buildDiffModel: wire-shape shadowedSeqs (no preview) → seqs source, empty rows', () => {
  const model = buildDiffModel({
    shadowedSeqs: [10, 11, 12, 13],
    shadowedTokenCount: 1600,
    summary: [{ type: 'text', text: 'x'.repeat(80) }],  // 80 chars → 20 tok
  }, extractPlainText)

  assert.equal(model.left.source, 'seqs')
  assert.deepEqual(model.left.seqs, [10, 11, 12, 13])
  assert.equal(model.left.rows.length, 0)
  assert.equal(model.header.events, 4)
  assert.equal(model.header.afterTokens, 20)
  assert.equal(model.header.ratio, 80)  // 1600 / 20
})

test('buildDiffModel: range-only compact/summary → range source, events derived', () => {
  const model = buildDiffModel({
    shadowedRange: { start: 5, end: 14 },  // 10 events
    summary: [{ type: 'text', text: 'gist' }],
  }, extractPlainText)

  assert.equal(model.left.source, 'range')
  assert.deepEqual(model.left.range, { start: 5, end: 14 })
  assert.equal(model.header.events, 10)
  // beforeTokens absent → ratio null even though afterTokens defined
  assert.equal(model.header.beforeTokens, null)
  assert.equal(model.header.ratio, null)
})

test('buildDiffModel: empty compact/summary → empty source with all-null header', () => {
  const model = buildDiffModel({}, extractPlainText)
  assert.equal(model.left.source, 'empty')
  assert.equal(model.left.rows.length, 0)
  assert.equal(model.header.events, null)
  assert.equal(model.header.beforeTokens, null)
  assert.equal(model.header.afterTokens, null)
  assert.equal(model.header.ratio, null)
  assert.equal(model.right.text, '')
})

test('buildDiffModel: legacy `tokens` field maps to beforeTokens when shadowedTokenCount missing', () => {
  const model = buildDiffModel({
    shadowedSeqs: [1, 2],
    tokens: 400,
    summary: [{ type: 'text', text: 'x'.repeat(40) }],  // 40/4 = 10 tok
  }, extractPlainText)
  assert.equal(model.header.beforeTokens, 400)
  assert.equal(model.header.ratio, 40)  // 400/10
})

test('buildDiffModel: preview wins over shadowedSeqs when both present (fixture demo)', () => {
  // demo fixtures inline both shadowedSeqs (real wire shape) and
  // _shadowedPreview (demo-only enrichment); the preview column must win
  // so the demo renders text rows, not opaque seq stubs.
  const model = buildDiffModel({
    shadowedSeqs: [1, 2, 3, 4, 5],  // count=5
    _shadowedPreview: [
      { seq: 1, type: 'user/message', gist: 'hi' },
      { seq: 2, type: 'tool/call',    gist: 'run(x)' },
    ],
    summary: [{ type: 'text', text: 'gist' }],
  }, extractPlainText)
  assert.equal(model.left.source, 'preview')
  assert.equal(model.header.events, 2)  // from preview, not seqs
})

test('buildDiffModel: afterTokens=0 (missing summary) → ratio null even with beforeTokens', () => {
  const model = buildDiffModel({
    shadowedSeqs: [1],
    shadowedTokenCount: 100,
    summary: [],
  }, extractPlainText)
  assert.equal(model.header.afterTokens, null)
  assert.equal(model.header.ratio, null)
})
