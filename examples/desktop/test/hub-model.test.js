// Unit tests for src/renderer/hub-model.js — the pure Hub data module.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const H = require('../src/renderer/hub-model.js')

test('KIND_ORDER puts plugin first', () => {
  assert.equal(H.KIND_ORDER[0], 'plugin')
  assert.equal(H.KIND_ORDER.length, 7)
  assert.deepEqual(
    [...H.KIND_ORDER],
    ['plugin', 'skill', 'prompt', 'rubric', 'profile', 'dataset', 'script'],
  )
})

test('normaliseRow fills defaults + preserves kind-specific fields', () => {
  const r = H.normaliseRow('script', { name: 'dedup', lang: 'python', lastStatus: 'ok' })
  assert.equal(r.kind, 'script')
  assert.equal(r.name, 'dedup')
  assert.equal(r.version, 'v1')
  assert.equal(r.lang, 'python')
  assert.equal(r.lastStatus, 'ok')
  assert.equal(r.rowCount, null)
  assert.deepEqual(r.versions, [])
})

test('normaliseRow retains numeric rowCount for datasets', () => {
  const r = H.normaliseRow('dataset', { name: 'seed', rowCount: 12000 })
  assert.equal(r.rowCount, 12000)
})

test('sortHubRows sorts by kind order then name asc', () => {
  const rows = [
    { kind: 'dataset', name: 'zebra' },
    { kind: 'plugin',  name: 'bash-local' },
    { kind: 'dataset', name: 'alpha' },
    { kind: 'script',  name: 'dedup' },
    { kind: 'plugin',  name: 'agent-spine' },
  ].map((r) => H.normaliseRow(r.kind, r))
  const sorted = H.sortHubRows(rows)
  assert.deepEqual(
    sorted.map((r) => `${r.kind}:${r.name}`),
    ['plugin:agent-spine', 'plugin:bash-local', 'dataset:alpha', 'dataset:zebra', 'script:dedup'],
  )
})

test('sortHubRows leaves the input untouched', () => {
  const rows = [
    H.normaliseRow('script', { name: 'a' }),
    H.normaliseRow('plugin', { name: 'b' }),
  ]
  const snapshot = rows.map((r) => r.name)
  H.sortHubRows(rows)
  assert.deepEqual(rows.map((r) => r.name), snapshot)
})

test('sectionCounts includes zero-count sections so empty slots render', () => {
  const rows = [
    H.normaliseRow('plugin', { name: 'p1' }),
    H.normaliseRow('plugin', { name: 'p2' }),
    H.normaliseRow('script', { name: 's1' }),
  ]
  const counts = H.sectionCounts(rows)
  assert.equal(counts.get('plugin'), 2)
  assert.equal(counts.get('script'), 1)
  assert.equal(counts.get('dataset'), 0)
  assert.equal(counts.get('rubric'), 0)
  assert.equal(counts.size, H.KIND_ORDER.length)
})

test('parseScriptSummary reads the last JSON line', () => {
  const stdout = [
    'starting…',
    'seen 100 rows',
    '{"progress": 0.5}',                     // no written/dropped → skipped
    '{"written": 42, "dropped": 8, "notes": "ok"}',
  ].join('\n')
  const summary = H.parseScriptSummary(stdout)
  assert.equal(summary.written, 42)
  assert.equal(summary.dropped, 8)
  assert.equal(summary.notes, 'ok')
  assert.equal(summary.source, 'stdout')
})

test('parseScriptSummary returns null when nothing usable is emitted', () => {
  assert.equal(H.parseScriptSummary(''), null)
  assert.equal(H.parseScriptSummary('hello\nworld\n'), null)
  assert.equal(H.parseScriptSummary('{"unrelated": 1}\n'), null)
})

test('parseScriptSummary tolerates a trailing empty line', () => {
  const stdout = '{"written": 1, "dropped": 0}\n\n'
  const summary = H.parseScriptSummary(stdout)
  assert.equal(summary.written, 1)
})

test('formatDiffSummary composes the row-count delta phrase', () => {
  const s = H.formatDiffSummary({
    inputRows: 18432,
    summary: { written: 12109, dropped: 6323, notes: 'exact-match dedup' },
    outputRows: 12109,
  })
  assert.match(s, /18,432 → 12,109 rows/)
  assert.match(s, /−6,323 dropped/)
  assert.match(s, /exact-match dedup/)
})

test('formatDiffSummary falls back to fs delta when summary is missing', () => {
  const s = H.formatDiffSummary({ inputRows: 100, summary: null, outputRows: 80 })
  assert.match(s, /100 → 80 rows/)
  assert.match(s, /−20 dropped/)
})

test('formatDiffSummary handles no input row count gracefully', () => {
  const s = H.formatDiffSummary({ inputRows: NaN, summary: { written: 5, dropped: 0 }, outputRows: 5 })
  assert.match(s, /5 rows written/)
})

test('previewDatasetRows parses first N JSONL rows', () => {
  const jsonl = [
    '{"messages": [{"role":"user","content":"hi"}]}',
    '{"messages": [{"role":"user","content":"there"}]}',
    'garbage line',
    '{"messages": [{"role":"user","content":"third"}]}',
    '{"messages": [{"role":"user","content":"fourth"}]}',
  ].join('\n')
  const rows = H.previewDatasetRows(jsonl, 3)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].messages[0].content, 'hi')
  assert.equal(rows[2].messages[0].content, 'third')
})

test('chipColumnsFor detects the known chip columns + collects the rest', () => {
  const rows = [
    { messages: [], reasoning_content: 'x', task_id: 'a' },
    { messages: [], tool_calls: [] },
  ]
  const c = H.chipColumnsFor(rows)
  assert.deepEqual(c.chips, ['messages', 'reasoning_content', 'tool_calls'])
  assert.deepEqual(c.rest, ['task_id'])
})

test('countJsonlRows counts non-empty lines only', () => {
  assert.equal(H.countJsonlRows(''), 0)
  assert.equal(H.countJsonlRows('a\nb\nc\n'), 3)
  assert.equal(H.countJsonlRows('a\n\nb\n\n'), 2)
})

test('sdkLegend lists the four seams the Hub touches', () => {
  const legend = H.sdkLegend()
  const ids = legend.map((l) => l.id)
  assert.deepEqual(ids.sort(), ['dataset/list', 'library/list', 'plugins/list', 'script/run'])
  const gap = legend.find((l) => l.id === 'script/run')
  assert.equal(gap.status, 'file-tier')
  assert.equal(gap.gap, 'G12')
})
