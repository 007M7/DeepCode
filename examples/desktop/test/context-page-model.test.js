// Tests for src/renderer/context-page-model.js — task #185 (Context page,
// #179-A). Pure projections only; the DOM controller has its own smoke
// path (context-page.js is exercised in the CDP shots).
//
// Fixtures mirror the wire shapes in packages/core/session/src/types.ts
// (SessionEvent + turn/end + context/message + compact/summary + tool/call).
// The tests assert on the row+roster shape rather than on the tracker's
// internal token counts, because context-meter.js has its own dedicated
// coverage — this file's job is to prove projectTurnRows composes the
// pieces correctly, not to re-verify tracker arithmetic.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/context-page-model.js')

// Small helpers to build events at the ergonomic level tests read at.
let _seq = 0
function nextSeq() { _seq += 1; return _seq }
function reset() { _seq = 0 }

function inject(plugin, text = 'note', kind = 'plugin') {
  return {
    type: 'context/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: {
      content: [{ type: 'text', text }],
      source: kind === 'user' ? { kind: 'user' } : { kind: 'plugin', plugin },
    },
  }
}
function compact({ range = [1, 20], model = 'deepseek-chat', maxTokens = 512, shadowedTokens = 15000 } = {}) {
  return {
    type: 'compact/summary',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: {
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: range[0], end: range[1] },
      shadowedSeqs: [],
      shadowedTokenCount: shadowedTokens,
      model,
      maxTokens,
    },
  }
}
function recall(name = 'history_read', args = { seq: 42 }) {
  return {
    type: 'tool/call',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { name, arguments: JSON.stringify(args) },
  }
}
function turnEnd(turn) {
  return {
    type: 'turn/end',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { turn, reason: { kind: 'completed' } },
  }
}
function userMessageFromCompactPlugin() {
  return {
    type: 'user/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: {
      content: [{ type: 'text', text: '<manual compact trigger>' }],
      source: { kind: 'plugin', plugin: 'compact' },
    },
  }
}

test('projectTurnRows: groups events by turn boundary', () => {
  reset()
  const events = [
    inject('hooks-claude', 'CLAUDE.md loaded'),
    inject('time-context', 'tick'),
    turnEnd(1),
    inject('hooks-claude', 'reloaded'),
    recall('history_search'),
    turnEnd(2),
  ]
  const rows = M.projectTurnRows(events)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].injectCount, 2)
  assert.equal(rows[0].compactCount, 0)
  assert.equal(rows[0].recallCount, 0)
  assert.equal(rows[0].closed, true)
  assert.equal(rows[1].turn, 2)
  assert.equal(rows[1].injectCount, 1)
  assert.equal(rows[1].recallCount, 1)
})

test('projectTurnRows: per-plugin injection slice preserves order and seq list', () => {
  reset()
  const events = [
    inject('hooks-claude'),
    inject('time-context'),
    inject('hooks-claude'),
    inject('acme-notifier'),
    turnEnd(1),
  ]
  const [row] = M.projectTurnRows(events)
  const plugins = row.injects.map((s) => s.plugin)
  // First-seen order — hooks-claude before time-context before acme-notifier.
  assert.deepEqual(plugins, ['hooks-claude', 'time-context', 'acme-notifier'])
  const claude = row.injects.find((s) => s.plugin === 'hooks-claude')
  assert.equal(claude.count, 2)
  assert.equal(claude.seqs.length, 2)
  // Every inject seq is also on the flat list, in observation order.
  assert.deepEqual(row.injectSeqs, [1, 2, 3, 4])
})

test('projectTurnRows: trailing in-flight bucket carries closed=false', () => {
  reset()
  const events = [
    inject('hooks-claude'),
    turnEnd(1),
    inject('time-context'),
    // no turn/end — turn 2 in progress
  ]
  const rows = M.projectTurnRows(events)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].closed, true)
  assert.equal(rows[1].closed, false)
})

test('projectTurnRows: compact events counted in the turn they land in', () => {
  reset()
  const events = [
    inject('hooks-claude'),
    turnEnd(1),
    compact({ range: [1, 30] }),
    turnEnd(2),
  ]
  const rows = M.projectTurnRows(events)
  assert.equal(rows[1].compactCount, 1)
  assert.equal(rows[1].compactSeqs.length, 1)
})

test('projectTurnRows: recall recognizes both history_read and history_search', () => {
  reset()
  const events = [recall('history_read'), recall('history_search'), turnEnd(1)]
  const rows = M.projectTurnRows(events)
  assert.equal(rows[0].recallCount, 2)
})

test('projectTurnRows: budget projection matches tracker (assumed source when no override)', () => {
  reset()
  const events = [inject('hooks-claude', 'x'.repeat(4000)), turnEnd(1)]
  const rows = M.projectTurnRows(events)
  assert.equal(rows[0].budgetSource, 'assumed')
  assert.ok(rows[0].budget > 0, 'default 128k budget present')
  assert.ok(rows[0].budgetPct >= 0 && rows[0].budgetPct <= 999)
})

test('projectTurnRows: explicit budget override marks source=server', () => {
  reset()
  const events = [inject('hooks-claude'), turnEnd(1)]
  const rows = M.projectTurnRows(events, { budgetTokens: 200_000 })
  assert.equal(rows[0].budgetSource, 'server')
  assert.equal(rows[0].budget, 200_000)
})

test('projectTurnRows: non-context/message events do not inflate injectCount', () => {
  reset()
  const events = [
    { type: 'assistant/chunk', seq: nextSeq(), data: { text: 'hi' } },
    { type: 'tool/call', seq: nextSeq(), data: { name: 'bash', arguments: '{}' } },
    turnEnd(1),
  ]
  const rows = M.projectTurnRows(events)
  assert.equal(rows[0].injectCount, 0)
  assert.equal(rows[0].recallCount, 0)
  assert.equal(rows[0].compactCount, 0)
})

test('projectTurnRows: robust to non-array + garbage input', () => {
  assert.deepEqual(M.projectTurnRows(null), [])
  assert.deepEqual(M.projectTurnRows(undefined), [])
  const rows = M.projectTurnRows([null, 42, {}, { type: null }])
  // Every input still contributes to eventCount when it's an object; skip when it's not.
  assert.equal(rows.length, 0, 'no turn/end → no closed rows, no trailing since eventCount==0 for typeof!=object')
})

test('buildInjectionRoster: aggregates counts + first/last seq + family from inject-family', () => {
  reset()
  const events = [
    inject('hooks-claude'),
    inject('time-context'),
    inject('hooks-claude'),
    inject('acme-unknown'),
  ]
  const roster = M.buildInjectionRoster(events, { isFirstTurn: true })
  const byPlugin = Object.fromEntries(roster.map((r) => [r.plugin, r]))
  assert.equal(byPlugin['hooks-claude'].count, 2)
  assert.equal(byPlugin['hooks-claude'].family, 'A') // session-start on first turn
  assert.equal(byPlugin['time-context'].family, 'C')
  assert.equal(byPlugin['acme-unknown'].family, 'G') // unknown plugin
  assert.ok(byPlugin['hooks-claude'].firstSeq < byPlugin['hooks-claude'].lastSeq)
})

test('summarizeCompactPolicy: reads the last compact/summary and detects manual source', () => {
  reset()
  const events = [
    inject('hooks-claude'),
    turnEnd(1),
    userMessageFromCompactPlugin(),
    compact({ model: 'deepseek-chat', maxTokens: 768, shadowedTokens: 12000 }),
    turnEnd(2),
  ]
  const policy = M.summarizeCompactPolicy(events)
  assert.equal(policy.model, 'deepseek-chat')
  assert.equal(policy.maxTokens, 768)
  assert.equal(policy.source, 'manual')
  assert.equal(policy.shadowedTokens, 12000)
})

test('summarizeCompactPolicy: returns null when no compact has landed', () => {
  reset()
  const policy = M.summarizeCompactPolicy([inject('hooks-claude'), turnEnd(1)])
  assert.equal(policy, null)
})

test('summarizeCompactPolicy: unknown source when no adjacent user/message hint', () => {
  reset()
  const events = [compact({ model: 'x', maxTokens: 512 })]
  const policy = M.summarizeCompactPolicy(events)
  assert.equal(policy.source, 'unknown')
})

test('summarizeRecallConfig: buckets by tool name with sampleArgs preserved', () => {
  reset()
  const events = [
    recall('history_read', { seq: 42 }),
    recall('history_read', { seq: 88 }),
    recall('history_search', { q: 'sessions' }),
  ]
  const cfg = M.summarizeRecallConfig(events)
  assert.equal(cfg.total, 3)
  assert.equal(cfg.tools.length, 2)
  const read = cfg.tools.find((t) => t.name === 'history_read')
  assert.equal(read.count, 2)
  assert.ok(read.sampleArgs && read.sampleArgs.includes('"seq":42'))
})

test('summarizeRecallConfig: empty when no recall events', () => {
  const cfg = M.summarizeRecallConfig([inject('hooks-claude')])
  assert.equal(cfg.total, 0)
  assert.equal(cfg.tools.length, 0)
})

test('computeBudgetSparkline: normalises heights against series peak', () => {
  const rows = [
    { turn: 1, budgetPct: 10 },
    { turn: 2, budgetPct: 30 },
    { turn: 3, budgetPct: 60 },
  ]
  const line = M.computeBudgetSparkline(rows)
  assert.equal(line.length, 3)
  // Peak row's height == 1
  assert.equal(line[2].height, 1)
  // Non-peak scales linearly
  assert.ok(line[1].height > 0.4 && line[1].height < 0.6)
  // Floor is 0.05 so a tiny value is still visible
  assert.ok(line[0].height >= 0.05)
})

test('computeBudgetSparkline: returns empty array when all pct are zero', () => {
  const line = M.computeBudgetSparkline([{ turn: 1, budgetPct: 0 }, { turn: 2, budgetPct: 0 }])
  assert.deepEqual(line, [])
})

test('serializeProfileYAML: emits the expected DSH profile shape', () => {
  const yaml = M.serializeProfileYAML({
    name: 'demo-profile',
    shadowing: 'auto',
    compactModel: 'deepseek-chat',
    compactMaxTokens: 512,
    compactSource: 'manual',
    recall: { windowSeqs: 80, threshold: 0.4 },
    injectionScopes: [
      { plugin: 'hooks-claude', allow: true },
      { plugin: 'time-context', allow: false },
    ],
  })
  assert.ok(yaml.includes('name: demo-profile'))
  assert.ok(yaml.includes('mode: auto'))
  assert.ok(yaml.includes('model: deepseek-chat'))
  assert.ok(yaml.includes('maxTokens: 512'))
  assert.ok(yaml.includes('source: manual'))
  assert.ok(yaml.includes('windowSeqs: 80'))
  assert.ok(yaml.includes('threshold: 0.4'))
  assert.ok(yaml.includes('- plugin: hooks-claude'))
  assert.ok(yaml.includes('allow: true'))
  assert.ok(yaml.includes('- plugin: time-context'))
  assert.ok(yaml.includes('allow: false'))
})

test('serializeProfileYAML: quotes strings with spaces + emits empty scopes as []', () => {
  const yaml = M.serializeProfileYAML({ name: 'my profile', shadowing: 'off', injectionScopes: [] })
  assert.ok(yaml.includes('name: "my profile"'))
  assert.ok(yaml.includes('mode: off'))
  assert.ok(yaml.includes('injectionScopes:\n  []'))
})

test('capabilitiesLegend: every entry names its wire status + G* gap where applicable', () => {
  const legend = M.capabilitiesLegend()
  assert.ok(legend.length >= 4)
  const statuses = new Set(legend.map((e) => e.status))
  assert.ok(statuses.has('live'))
  assert.ok(statuses.has('restart-required'))
  assert.ok(statuses.has('upstream-pending'))
  // Every non-live entry cites a G-number so the design pack's SDK-gap
  // matrix and the page's legend stay in sync.
  for (const e of legend) {
    if (e.status !== 'live') assert.match(e.gap, /^G\d+$/)
    if (e.status === 'live') assert.equal(e.gap, null)
    assert.ok(typeof e.note === 'string' && e.note.length > 20, 'each note explains the reason')
  }
})

test('pluginOf: handles all source shapes seen on the wire', () => {
  const p = (s) => M.pluginOf({ data: { source: s } })
  assert.equal(p({ kind: 'plugin', plugin: 'hooks-claude' }), 'hooks-claude')
  assert.equal(p({ kind: 'user' }), 'user')
  assert.equal(p({ kind: 'tool', tool: 'bash' }), 'tool')
  assert.equal(p('user'), 'user')
  assert.equal(p(null), 'other')
  assert.equal(p({}), 'other')
})
