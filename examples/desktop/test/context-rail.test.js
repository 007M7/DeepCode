// Tests for src/renderer/context-rail.js — task #137 (demo 批 2 §1.2).
//
// Pure classifier + summariser (buildRail is DOM-heavy; exercised via the
// renderer harness in a sibling test). Fixture shapes mirror the real wire
// types (packages/core/session/src/types.ts:210) so upstream drift is
// caught here rather than at render time. See fixtures/trace-samples/
// 1.7-compact-three-events.json for the same shape used in the demo.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { classifyEventForRail, summariseByTurn } =
  require('../src/renderer/context-rail.js')

test('classifyEventForRail: context/message from plugin = inject family', () => {
  const ev = {
    type: 'context/message',
    seq: 42,
    time: 1721119500000,
    data: {
      content: [{ type: 'text', text: 'CLAUDE.md was loaded, 12 rules active.' }],
      source: { kind: 'plugin', plugin: 'hooks-claude' },
    },
  }
  const dot = classifyEventForRail(ev)
  assert.equal(dot.family, 'inject')
  assert.equal(dot.plugin, 'hooks-claude')
  assert.equal(dot.seq, 42)
  assert.match(dot.label, /^inject · hooks-claude · CLAUDE\.md/)
})

test('classifyEventForRail: context/message from user = inject with plugin="user"', () => {
  const dot = classifyEventForRail({
    type: 'context/message',
    seq: 3,
    data: {
      content: [{ type: 'text', text: 'skill include:foo' }],
      source: { kind: 'user' },
    },
  })
  assert.equal(dot.family, 'inject')
  assert.equal(dot.plugin, 'user')
})

test('classifyEventForRail: compact/summary spans shadowedRange', () => {
  const dot = classifyEventForRail({
    type: 'compact/summary',
    seq: 151,
    time: 1721119512500,
    data: {
      summary: [{ type: 'text', text: 'summary…' }],
      shadowedRange: { start: 1, end: 149 },
      shadowedSeqs: Array.from({ length: 27 }, (_, i) => i + 1),
      shadowedTokenCount: 32180,
    },
  })
  assert.equal(dot.family, 'compact')
  assert.equal(dot.seq, 151)
  assert.equal(dot.spanEnd, 149)
  assert.equal(dot.label, 'compact · shadowed 27 events')
})

test('classifyEventForRail: recall tool/call = recall family', () => {
  // renderer.js:1188 RECALL_TOOL_NAMES defines history_read / history_search.
  const dot = classifyEventForRail({
    type: 'tool/call',
    seq: 88,
    data: { name: 'history_read', arguments: '{"seq":42}' },
  })
  assert.equal(dot.family, 'recall')
  assert.equal(dot.plugin, 'history_read')
})

test('classifyEventForRail: unrelated tool/call returns null (no rail dot)', () => {
  // Every dot must earn its space — a regular bash / read / write call is
  // not a context event, must not clutter the rail.
  assert.equal(classifyEventForRail({
    type: 'tool/call',
    seq: 5,
    data: { name: 'bash', arguments: '{}' },
  }), null)
})

test('classifyEventForRail: steering/message = steering family', () => {
  const dot = classifyEventForRail({
    type: 'steering/message',
    seq: 7,
    data: { content: [{ type: 'text', text: 'nudge: use widget' }] },
  })
  assert.equal(dot.family, 'steering')
})

test('classifyEventForRail: turn/end / assistant/message / user/message = null', () => {
  for (const type of ['turn/end', 'turn/start', 'assistant/message', 'user/message']) {
    assert.equal(classifyEventForRail({ type, seq: 1, data: {} }), null, type)
  }
})

test('summariseByTurn: aggregates injects/compacts/recalls per turn', () => {
  const events = [
    { type: 'turn/start',        seq: 1, data: { turn: 0 } },
    { type: 'context/message',   seq: 2, data: { content: [{ type: 'text', text: 'a' }], source: { kind: 'plugin', plugin: 'hooks-claude' } } },
    { type: 'context/message',   seq: 3, data: { content: [{ type: 'text', text: 'b' }], source: { kind: 'plugin', plugin: 'time-context' } } },
    { type: 'tool/call',         seq: 4, data: { name: 'history_read' } },
    { type: 'turn/end',          seq: 5, data: { turn: 0 } },
    { type: 'turn/start',        seq: 6, data: { turn: 1 } },
    { type: 'compact/summary',   seq: 7, data: { shadowedRange: { start: 1, end: 5 }, shadowedSeqs: [1, 2, 3] } },
    { type: 'turn/end',          seq: 8, data: { turn: 1 } },
  ]
  const groups = summariseByTurn(events)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].turn, 0)
  assert.equal(groups[0].inject, 2)
  assert.equal(groups[0].recall, 1)
  assert.equal(groups[0].compact, 0)
  assert.equal(groups[1].turn, 1)
  assert.equal(groups[1].compact, 1)
  assert.equal(groups[1].inject, 0)
})

test('summariseByTurn: empty list = empty array', () => {
  assert.deepEqual(summariseByTurn([]), [])
  assert.deepEqual(summariseByTurn(null), [])
})

// Batch 3 (task #138) additions — the rail classifier now recognises two
// more families so §1.6 workflow starts and §1.4 subagent lifecycles show
// up as timeline dots. The families themselves live in workflow-view.js /
// subagent-view.js; the classifier here just decides whether an event
// earns a dot at all.

test('classifyEventForRail: tool/call name=workflow = workflow family (with kind label)', () => {
  const dot = classifyEventForRail({
    type: 'tool/call',
    seq: 900,
    data: { name: 'workflow', arguments: '{"name":"translate-comments","kind":"seq"}' },
  })
  assert.equal(dot.family, 'workflow')
  assert.match(dot.label, /translate-comments/)
  assert.match(dot.label, /seq/)
})

test('classifyEventForRail: subagent.started notification = subagent family', () => {
  const dot = classifyEventForRail({
    type: '_notification',
    method: 'subagent.started',
    seq: 100,
    params: { parentSessionId: 'root-abc', childSessionId: 'sub-1234567890' },
  })
  assert.equal(dot.family, 'subagent')
  assert.match(dot.label, /subagent · started/)
})

test('classifyEventForRail: subagent.finished notification = subagent family', () => {
  const dot = classifyEventForRail({
    type: '_notification',
    method: 'subagent.finished',
    seq: 200,
    params: { parentSessionId: 'root-abc', childSessionId: 'sub-1234567890', status: 'ok' },
  })
  assert.equal(dot.family, 'subagent')
  assert.match(dot.label, /subagent · finished/)
})

test('summariseByTurn: workflow + subagent families increment their own counters', () => {
  const events = [
    { type: 'turn/start',   seq: 1, data: { turn: 5 } },
    { type: 'tool/call',    seq: 2, data: { name: 'workflow', arguments: '{"name":"x","kind":"seq"}' } },
    { type: '_notification', method: 'subagent.started', seq: 3, params: { parentSessionId: 'p', childSessionId: 'c' } },
    { type: 'turn/end',     seq: 4, data: { turn: 5 } },
  ]
  const groups = summariseByTurn(events)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].workflow, 1)
  assert.equal(groups[0].subagent, 1)
})
