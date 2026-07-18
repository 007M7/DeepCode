// Tests for task #157 additions to src/renderer/trace-aggregator.js:
// chunk-run collapsing, per-row event previews (tool-call/-result/
// request-header/hook/*), and the raw JSON payload viewer helper.
//
// Fixture discipline (memory/multi-agent-shared-repo-rules.md #4): the
// 115-chunk fixture comes from fixtures/trace-samples/1.1-trace-chunk-heavy.json
// which mirrors the real wire shape emitted by the daemon (data.chunk.text
// on text-delta, request/header carrying header.{model,tools,system,
// messagePrefix}, tool/result meta.card + meta.durationMs, hook payloads).
// If this fixture drifts from the daemon wire shape, the row previews
// become useless in the real app — same failure mode #157 is chasing.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TA = require('../src/renderer/trace-aggregator.js')

function loadHeavy() {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', '1.1-trace-chunk-heavy.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

test('collapseChunkRuns folds a run of assistant/chunk into a single row', () => {
  const events = loadHeavy()
  const steps = TA.aggregateSteps(events)
  assert.equal(steps.length, 1, 'fixture has one step')
  const rows = TA.collapseChunkRuns(steps[0].events)
  const runs = rows.filter((r) => r.kind === 'run')
  assert.equal(runs.length, 1, 'the 115 chunks fold into one run')
  assert.equal(runs[0].count, 115)
  assert.equal(runs[0].events.length, 115)
  assert.ok(runs[0].startSeq !== null && runs[0].endSeq !== null)
  assert.ok(runs[0].endSeq > runs[0].startSeq)
})

test('collapseChunkRuns keeps non-chunk events as their own event rows in order', () => {
  const events = loadHeavy()
  const steps = TA.aggregateSteps(events)
  const rows = TA.collapseChunkRuns(steps[0].events)
  const kinds = rows.map((r) => r.kind === 'run' ? `run(${r.count})` : r.event.type)
  // Expected order inside step 0 events: request/header, hook/before-tool-call,
  // run of 115 chunks, tool/call, tool/result, assistant/message.
  assert.deepEqual(
    kinds,
    ['request/header', 'hook/before-tool-call', 'run(115)', 'tool/call', 'tool/result', 'assistant/message'],
  )
})

test('collapseChunkRuns handles multiple runs separated by other events', () => {
  const stream = [
    { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'A' } } },
    { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: 'B' } } },
    { type: 'request/header', seq: 3, data: { header: { model: 'x', messagePrefix: [] }, reason: 'mid' } },
    { type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'text-delta', text: 'C' } } },
  ]
  const rows = TA.collapseChunkRuns(stream)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].kind, 'run'); assert.equal(rows[0].count, 2)
  assert.equal(rows[1].kind, 'event'); assert.equal(rows[1].event.type, 'request/header')
  assert.equal(rows[2].kind, 'run'); assert.equal(rows[2].count, 1)
})

test('collapseChunkRuns tolerates malformed input', () => {
  assert.deepEqual(TA.collapseChunkRuns(null), [])
  assert.deepEqual(TA.collapseChunkRuns(undefined), [])
  assert.deepEqual(TA.collapseChunkRuns([null, undefined, { /* no type */ }]).length, 1)
})

test('chunkRunConcatText concatenates delta text and truncates with ellipsis', () => {
  const chunks = [
    { data: { chunk: { text: 'Hello ' } } },
    { data: { chunk: { text: 'world' } } },
  ]
  assert.equal(TA.chunkRunConcatText(chunks, 50), 'Hello world')
  const many = Array.from({ length: 20 }, (_, i) => ({ data: { chunk: { text: 'abcde ' } } }))
  const out = TA.chunkRunConcatText(many, 30)
  assert.ok(out.endsWith('…'))
  assert.equal(out.length, 30)
})

test('chunkRunConcatText reads legacy shapes: chunk.delta and data.text', () => {
  const chunks = [
    { data: { chunk: { delta: 'foo ' } } },
    { data: { text: 'bar' } },
  ]
  assert.equal(TA.chunkRunConcatText(chunks, 50), 'foo bar')
})

test('chunkRunConcatText returns empty on non-array or empty input', () => {
  assert.equal(TA.chunkRunConcatText([], 10), '')
  assert.equal(TA.chunkRunConcatText(null, 10), '')
})

test('previewForEvent narrates tool/call with argument gist', () => {
  const ev = { type: 'tool/call', data: { name: 'read', arguments: '{"path":"src/foo.ts","offset":0}' } }
  const out = TA.previewForEvent(ev)
  assert.match(out, /^read\(/)
  assert.match(out, /path="src\/foo\.ts"/)
})

test('previewForEvent narrates tool/result ok with size + duration', () => {
  const ev = {
    type: 'tool/result',
    data: {
      callId: 'c1',
      content: [{ type: 'text', text: 'abcdefghij' }],
      isError: false,
      meta: { durationMs: 42 },
    },
  }
  const out = TA.previewForEvent(ev)
  assert.equal(out, '→ok c1 · 10b · 42ms')
})

test('previewForEvent narrates tool/result error with message', () => {
  const ev = {
    type: 'tool/result',
    data: {
      callId: 'c2',
      isError: true,
      content: [{ type: 'text', text: 'ENOENT: no such file' }],
    },
  }
  const out = TA.previewForEvent(ev)
  assert.match(out, /^→err c2/)
  assert.match(out, /ENOENT/)
})

test('previewForEvent narrates request/header with model + counts + system-flag', () => {
  const ev = {
    type: 'request/header',
    data: {
      header: {
        model: 'deepseek-chat',
        system: 'you are…',
        tools: [{ name: 'read' }, { name: 'edit' }, { name: 'bash' }],
        messagePrefix: [1, 2, 3, 4],
      },
      reason: 'step-start',
    },
  }
  const out = TA.previewForEvent(ev)
  assert.equal(out, 'model=deepseek-chat · msgs=4 · tools=3 · sys · step-start')
})

test('previewForEvent narrates hook events with allowed/blocked', () => {
  assert.equal(
    TA.previewForEvent({ type: 'hook/before-tool-call', data: { hookName: 'guard', allowed: false } }),
    'guard · BLOCKED',
  )
  assert.equal(
    TA.previewForEvent({ type: 'hook/before-tool-call', data: { hookName: 'guard', allowed: true } }),
    'guard · allowed',
  )
})

test('previewForEvent falls back to compact JSON for unknown event types', () => {
  const out = TA.previewForEvent({ type: 'foo/bar', data: { a: 1, b: 'two' } })
  assert.match(out, /"a":1/)
})

test('previewForEvent handles null / bad input', () => {
  assert.equal(TA.previewForEvent(null), '')
  assert.equal(TA.previewForEvent({}), '')
  assert.equal(TA.previewForEvent({ type: 'x' }), '')
})

test('previewForEvent shows single-chunk text-delta as its own text', () => {
  const ev = { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'streaming word' } } }
  assert.equal(TA.previewForEvent(ev), 'streaming word')
})

test('payloadForEvent returns a pretty-printed JSON string of the whole event', () => {
  const ev = { type: 'tool/call', seq: 12, data: { name: 'read', arguments: '{}' } }
  const s = TA.payloadForEvent(ev)
  assert.ok(s.includes('"type": "tool/call"'))
  assert.ok(s.includes('"seq": 12'))
  // multi-line
  assert.ok(s.split('\n').length >= 4)
})

test('payloadForEvent falls back on circular refs', () => {
  const ev = { type: 'x' }
  ev.self = ev
  const s = TA.payloadForEvent(ev)
  assert.ok(typeof s === 'string' && s.length > 0)
})

test('115-chunk fixture concat preview reads like the answer body', () => {
  const events = loadHeavy()
  const chunks = events.filter((e) => e.type === 'assistant/chunk')
  const preview = TA.chunkRunConcatText(chunks, 200)
  // The first two words in the fixture are "Harness 是 …" — assert we
  // got a substantive preview, not the empty string, and that it hit
  // the 200-char cap (i.e. truncation actually triggered).
  assert.match(preview, /^Harness /)
  assert.equal(preview.length, 200)
  assert.ok(preview.endsWith('…'))
})
