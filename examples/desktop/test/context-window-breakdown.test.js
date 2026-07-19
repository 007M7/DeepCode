'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/context-window-breakdown.js')

let _seq = 0
function nextSeq() { _seq += 1; return _seq }
function reset() { _seq = 0 }

function sysMsg(text = 'you are a helpful assistant', size = null) {
  return {
    type: 'context/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: {
      content: [{ type: 'text', text: size ? 'x'.repeat(size) : text }],
      source: { kind: 'system' },
    },
  }
}
function injectMsg(plugin = 'foo', text = 'inject') {
  return {
    type: 'context/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } },
  }
}
function assistantMsg(usage = null, text = 'ok') {
  const ev = {
    type: 'assistant/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { content: [{ type: 'text', text }] },
  }
  if (usage) ev.data.usage = usage
  return ev
}
function reasoning(text = 'thinking about...') {
  return {
    type: 'assistant/reasoning',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { content: [{ type: 'text', text }] },
  }
}
function toolCall(name = 'search') {
  return {
    type: 'tool/call',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { name, arguments: JSON.stringify({ q: 'x' }) },
  }
}

test('computeWindowBreakdown: returns 5 slices in stable order', () => {
  reset()
  const result = M.computeWindowBreakdown([sysMsg(), injectMsg(), reasoning(), assistantMsg()])
  assert.equal(result.slices.length, 5)
  assert.deepEqual(result.slices.map((s) => s.family), M.FAMILY_ORDER)
})

test('computeWindowBreakdown: percentages sum to <= 100', () => {
  reset()
  const events = [sysMsg('sys'), injectMsg('plugin', 'inj'), reasoning('r'), assistantMsg(null, 'a'), toolCall('search'), toolCall('read')]
  const result = M.computeWindowBreakdown(events)
  const sum = result.slices.reduce((s, sl) => s + sl.pct, 0)
  assert.ok(sum <= 100.5, `slice pct sum ${sum} should be <= 100 (allowing ≤0.5 rounding drift)`)
  assert.ok(sum > 0, 'slice pct sum should be > 0 for a non-empty session')
})

test('computeWindowBreakdown: system_prompt family catches system + compact re-inject', () => {
  reset()
  const evSys = sysMsg()
  const evCompactInject = {
    type: 'context/message',
    seq: nextSeq(),
    data: { content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', plugin: 'compact' } },
  }
  const result = M.computeWindowBreakdown([evSys, evCompactInject])
  const sys = result.slices.find((s) => s.family === 'system_prompt')
  assert.equal(sys.eventCount, 2)
  assert.ok(sys.tokens > 0)
})

test('computeWindowBreakdown: tool_defs inferred from tool/call names when no explicit event', () => {
  reset()
  const result = M.computeWindowBreakdown([toolCall('search'), toolCall('read'), toolCall('search')])
  const td = result.slices.find((s) => s.family === 'tool_defs')
  assert.ok(td.tokens > 0, 'tool_defs slice populated from unique tool names')
  assert.equal(result.toolsFromCalls, true)
})

test('computeWindowBreakdown: usage envelope promotes to precise mode + splits thinking/responses', () => {
  reset()
  const result = M.computeWindowBreakdown([
    assistantMsg({ inputTokens: 1000, outputTokens: 400, thinking: 150 }),
  ])
  assert.equal(result.mode, 'precise')
  const thinking = result.slices.find((s) => s.family === 'thinking')
  const responses = result.slices.find((s) => s.family === 'responses')
  assert.equal(thinking.tokens, 150)
  assert.equal(responses.tokens, 400)
})

test('computeWindowBreakdown: empty events → zeroed slices, pct=0', () => {
  const result = M.computeWindowBreakdown([])
  assert.equal(result.totalTokens, 0)
  for (const s of result.slices) {
    assert.equal(s.tokens, 0)
    assert.equal(s.pct, 0)
  }
})

test('computeWindowBreakdown: honours budgetTokens override → server source', () => {
  const result = M.computeWindowBreakdown([sysMsg()], { budgetTokens: 200000 })
  assert.equal(result.budget, 200000)
  assert.equal(result.budgetSource, 'server')
})

test('classifyEventFamily: correctly bins every family', () => {
  assert.equal(M.classifyEventFamily({ type: 'assistant/reasoning', data: {} }), 'thinking')
  assert.equal(M.classifyEventFamily({ type: 'assistant/message', data: {} }), 'responses')
  assert.equal(M.classifyEventFamily({ type: 'steering/message', data: {} }), 'injections')
  assert.equal(M.classifyEventFamily({ type: 'context/message', data: { source: { kind: 'plugin', plugin: 'foo' } } }), 'injections')
  assert.equal(M.classifyEventFamily({ type: 'context/message', data: { source: { kind: 'system' } } }), 'system_prompt')
  assert.equal(M.classifyEventFamily({ type: 'tool/definitions', data: {} }), 'tool_defs')
  assert.equal(M.classifyEventFamily({ type: 'tool/result', data: {} }), null)
})
