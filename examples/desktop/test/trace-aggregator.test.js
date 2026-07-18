// Tests for src/renderer/trace-aggregator.js (task #136). The aggregator
// eats a wire-shape event array and produces the trace-step records the
// §1.1 card renders. Fixtures come from fixtures/trace-samples/ — same
// discipline as the inject-family test: never idealize the wire shape.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  aggregateSteps, classifyStepEvent, trimSummary, shortSummaryFor,
} = require('../src/renderer/trace-aggregator.js')

function loadFixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', name)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

test('aggregateSteps produces two records from the one-turn fixture', () => {
  const events = loadFixture('1.1-trace-one-turn.json')
  const steps = aggregateSteps(events)
  assert.equal(steps.length, 2, 'the fixture has two step/start-step/end pairs')

  const [first, second] = steps
  assert.equal(first.turn, 3)
  assert.equal(first.step, 0)
  assert.equal(first.startSeq, 102)
  assert.equal(first.endSeq, 108)
  assert.equal(first.durationMs, 1150, 'step 0 duration: 801250 - 800100')
  assert.equal(first.open, false)
  assert.equal(second.turn, 3)
  assert.equal(second.step, 1)
})

test('user/message before the first step lands in that step\'s inputs bucket', () => {
  const events = loadFixture('1.1-trace-one-turn.json')
  const steps = aggregateSteps(events)
  const [first] = steps
  const found = first.inputs.find((e) => e.type === 'user/message' && e.seq === 101)
  assert.ok(found, 'user/message @ seq 101 must appear in step 0 inputs')
})

test('assistant/message and tool/call go to outputs and events; assistant/chunk stays events-only', () => {
  const events = loadFixture('1.1-trace-one-turn.json')
  const steps = aggregateSteps(events)
  const [first] = steps
  const outSeqs = first.outputs.map((e) => e.seq).sort((a, b) => a - b)
  assert.deepEqual(outSeqs, [105, 106])
  const chunkInEvents = first.events.find((e) => e.type === 'assistant/chunk')
  const chunkInOutputs = first.outputs.find((e) => e.type === 'assistant/chunk')
  assert.ok(chunkInEvents, 'chunk stays visible in events bucket')
  assert.equal(chunkInOutputs, undefined, 'chunk must not leak into outputs')
})

test('tool/result from a prior step feeds the next step\'s inputs bucket', () => {
  const stream = [
    { type: 'step/start', seq: 1, time: 0, data: { turn: 0, step: 0 } },
    { type: 'tool/call', seq: 2, time: 1, data: { turn: 0, step: 0, callId: 'c1', name: 'read', arguments: '{}' } },
    { type: 'step/end', seq: 3, time: 2, data: { turn: 0, step: 0 } },
    { type: 'tool/result', seq: 4, time: 3, data: { turn: 0, step: 0, callId: 'c1', content: [], isError: false } },
    { type: 'step/start', seq: 5, time: 4, data: { turn: 0, step: 1 } },
    { type: 'step/end', seq: 6, time: 5, data: { turn: 0, step: 1 } },
  ]
  const steps = aggregateSteps(stream)
  assert.equal(steps.length, 2)
  assert.equal(steps[1].inputs.length, 1)
  assert.equal(steps[1].inputs[0].seq, 4)
  assert.equal(steps[1].inputs[0].type, 'tool/result')
})

test('summary picks the first text block content when assistant emits one', () => {
  const events = loadFixture('1.1-trace-one-turn.json')
  const steps = aggregateSteps(events)
  assert.equal(steps[0].summary, 'Reading the file first.')
})

test('a still-open (streaming) step comes back with open:true and no endSeq', () => {
  const stream = [
    { type: 'step/start', seq: 1, time: 0, data: { turn: 0, step: 0 } },
    { type: 'assistant/chunk', seq: 2, time: 1, data: { chunk: { type: 'text-delta', text: 'hi' } } },
  ]
  const steps = aggregateSteps(stream)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].open, true)
  assert.equal(steps[0].endSeq, null)
  assert.equal(steps[0].durationMs, null)
})

test('malformed step data (missing turn/step) still opens the record with null fields', () => {
  const stream = [
    { type: 'step/start', seq: 1, time: 0, data: {} },
    { type: 'step/end', seq: 2, time: 5, data: {} },
  ]
  const steps = aggregateSteps(stream)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].turn, null)
  assert.equal(steps[0].step, null)
  assert.equal(steps[0].durationMs, 5)
})

test('empty stream returns empty step list — no crash', () => {
  assert.deepEqual(aggregateSteps([]), [])
})

test('classifyStepEvent buckets known types correctly', () => {
  assert.deepEqual(
    classifyStepEvent({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'x' }] } }),
    { toOutput: true, toEvents: true, summary: 'x' },
  )
  assert.equal(classifyStepEvent({ type: 'assistant/chunk' }).toOutput, false)
  assert.equal(classifyStepEvent({ type: 'request/header' }).toOutput, false)
})

test('trimSummary keeps ≤12 chars; longer input cut with ellipsis', () => {
  assert.equal(trimSummary('short'), 'short')
  assert.equal(trimSummary('exactly-12chr'), 'exactly-12ch…')
  assert.equal(trimSummary(''), '')
  assert.equal(trimSummary(null), '')
})

test('shortSummaryFor prefers text over tool_use blocks; falls back to tool name', () => {
  assert.equal(
    shortSummaryFor({
      type: 'assistant/message',
      data: { content: [{ type: 'tool_use', name: 'read' }, { type: 'text', text: 'reading' }] },
    }),
    'reading',
  )
  assert.equal(
    shortSummaryFor({
      type: 'assistant/message',
      data: { content: [{ type: 'tool_use', name: 'read' }] },
    }),
    'tool: read',
  )
  assert.equal(shortSummaryFor({ type: 'tool/call', data: { name: 'bash' } }), 'bash(…)')
})
