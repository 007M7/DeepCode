'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/subagent-drilldown.js')

test('buildSubagentDrilldown: infers tool defs from child tool/call events', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'go' }] } },
    { type: 'tool/call', seq: 2, data: { name: 'read_file', arguments: '{"path":"a.md"}' } },
    { type: 'tool/call', seq: 3, data: { name: 'search',    arguments: '{"q":"hello"}' } },
    { type: 'tool/call', seq: 4, data: { name: 'read_file', arguments: '{"path":"b.md"}' } },
  ]
  const v = M.buildSubagentDrilldown({ childEvents: events })
  assert.equal(v.toolDefs.length, 2)
  assert.equal(v.toolDefsSource, 'inferred')
  const names = v.toolDefs.map((t) => t.name).sort()
  assert.deepEqual(names, ['read_file', 'search'])
  // firstSeq should be the first occurrence.
  const rf = v.toolDefs.find((t) => t.name === 'read_file')
  assert.equal(rf.firstSeq, 2)
})

test('buildSubagentDrilldown: explicit toolDefs override inferred', () => {
  const v = M.buildSubagentDrilldown({
    toolDefs: ['read_file', 'bash', 'search'],
    childEvents: [{ type: 'tool/call', seq: 1, data: { name: 'other' } }],
  })
  assert.equal(v.toolDefsSource, 'explicit')
  assert.deepEqual(v.toolDefs.map((t) => t.name), ['read_file', 'bash', 'search'])
})

test('buildSubagentDrilldown: inboundQuery from parent-seed user/message', () => {
  const events = [
    { type: 'user/message', seq: 1,
      data: {
        content: [{ type: 'text', text: 'go find X for the parent' }],
        source: { kind: 'plugin', plugin: 'subagent-search' },
      } },
    { type: 'tool/call', seq: 2, data: { name: 'search' } },
  ]
  const v = M.buildSubagentDrilldown({ childEvents: events })
  assert.equal(v.inboundQuery.source, 'seed-event')
  assert.match(v.inboundQuery.text, /find X/)
  assert.equal(v.inboundQuery.seq, 1)
})

test('buildSubagentDrilldown: explicit parentQuery wins', () => {
  const v = M.buildSubagentDrilldown({ parentQuery: 'summarise these docs' })
  assert.equal(v.inboundQuery.source, 'explicit')
  assert.equal(v.inboundQuery.text, 'summarise these docs')
})

test('buildSubagentDrilldown: falls back to first user/message when no plugin-tagged seed', () => {
  const v = M.buildSubagentDrilldown({
    childEvents: [{ type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'raw seed' }] } }],
  })
  assert.equal(v.inboundQuery.source, 'seed-event')
  assert.equal(v.inboundQuery.text, 'raw seed')
})

test('buildSubagentDrilldown: empty spec → empty view', () => {
  const v = M.buildSubagentDrilldown({})
  assert.equal(v.toolDefs.length, 0)
  assert.equal(v.toolDefsSource, 'empty')
  assert.equal(v.inboundQuery.source, 'empty')
  assert.equal(v.inboundQuery.text, '')
})

test('buildSubagentDrilldown: parentQuery accepts ContentBlock[] and preserves blocks', () => {
  const blocks = [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }]
  const v = M.buildSubagentDrilldown({ parentQuery: blocks })
  assert.equal(v.inboundQuery.source, 'explicit')
  assert.equal(v.inboundQuery.text, 'A\nB')
  assert.equal(v.inboundQuery.blocks, blocks)
})

test('buildSubagentDrilldown: preserves seq of the seed event when inferring', () => {
  const v = M.buildSubagentDrilldown({
    childEvents: [
      { type: 'assistant/chunk', seq: 5, data: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: 'seed' }] } },
    ],
  })
  assert.equal(v.inboundQuery.seq, 7)
})
