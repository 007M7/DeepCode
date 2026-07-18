// trace-graph.test.js — Task #203 view C (agent node graph).
//
// Verifies:
//   1. buildGraph turns a step-record into step + interesting-event nodes
//      with sequential seq edges
//   2. spawn_agent tool/call adds a fan-out edge to a subagent node
//   3. assignLevels puts sequential nodes on ascending levels and
//      fan-out siblings at the same depth
//   4. computePositions returns positive width/height for every node
//   5. familyForEventNode filters out assistant/chunk and hook/*
//   6. labelForEventNode returns model name for request/header

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const G = require('../src/renderer/trace-graph.js')

function makeDoc() {
  function makeEl(tag) {
    const cls = { _s: new Set(),
      add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    }
    const el = {
      tagName: tag.toUpperCase(),
      _children: [],
      _attrs: {},
      _listeners: {},
      dataset: {},
      style: {},
      textContent: '',
      get className() { return Array.from(cls._s).join(' ') },
      set className(v) { cls._s.clear(); String(v || '').split(/\s+/).forEach(x => x && cls._s.add(x)) },
      classList: cls,
      appendChild(c) { this._children.push(c); return c },
      append(...cs) { for (const c of cs) this._children.push(c) },
      setAttribute(k, v) { this._attrs[k] = String(v) },
      getAttribute(k) { return this._attrs[k] },
      addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
      querySelector() { return null },
    }
    return el
  }
  return {
    createElement(tag) { return makeEl(tag) },
    createElementNS(_ns, tag) { return makeEl(tag) },
    body: makeEl('body'),
  }
}

test('buildGraph: sequential nodes + seq edges', () => {
  const rec = {
    turn: 3, step: 0, startSeq: 100, endSeq: 105,
    startTime: 1000, endTime: 1500,
    events: [
      { type: 'request/header', time: 1010, seq: 101, data: { header: { model: 'deepseek-chat' } } },
      { type: 'assistant/message', time: 1200, seq: 102, data: { content: [{ type: 'text', text: 'ok' }] } },
    ],
    inputs: [], outputs: [], open: false,
  }
  const g = G.buildGraph(rec)
  // 1 step + 2 event nodes
  assert.strictEqual(g.nodes.length, 3)
  // 2 sequential edges: step→ev, ev→ev
  assert.strictEqual(g.edges.filter(e => e.kind === 'seq').length, 2)
  assert.strictEqual(g.layoutMode, 'bfs-layered-fallback')
})

test('buildGraph: spawn_agent adds fan-out edge to subagent stub', () => {
  const rec = {
    turn: 5, step: 0, startSeq: 200, endSeq: 202,
    startTime: 2000, endTime: 2200,
    events: [
      { type: 'tool/call', time: 2050, seq: 201, data: { callId: 's1', name: 'spawn_agent', arguments: '{}' } },
    ],
    inputs: [], outputs: [], open: false,
  }
  const g = G.buildGraph(rec)
  const fanOut = g.edges.filter(e => e.kind === 'fan-out')
  assert.strictEqual(fanOut.length, 1)
  // The fan-out edge points to a subagent-family node.
  const target = g.nodes.find(n => n.id === fanOut[0].to)
  assert.ok(target)
  assert.strictEqual(target.family, 'subagent')
})

test('assignLevels puts sequential nodes on ascending levels', () => {
  const nodes = [
    { id: 'a', seq: 1 }, { id: 'b', seq: 2 }, { id: 'c', seq: 3 },
  ]
  const edges = [
    { from: 'a', to: 'b', kind: 'seq' },
    { from: 'b', to: 'c', kind: 'seq' },
  ]
  const levels = G.assignLevels(nodes, edges)
  assert.strictEqual(levels.length, 3)
  assert.deepStrictEqual(levels[0], ['a'])
  assert.deepStrictEqual(levels[1], ['b'])
  assert.deepStrictEqual(levels[2], ['c'])
})

test('assignLevels: fan-out siblings share a level', () => {
  const nodes = [
    { id: 'parent', seq: 1 }, { id: 'k1', seq: 2 }, { id: 'k2', seq: 3 },
  ]
  const edges = [
    { from: 'parent', to: 'k1', kind: 'fan-out' },
    { from: 'parent', to: 'k2', kind: 'fan-out' },
  ]
  const levels = G.assignLevels(nodes, edges)
  assert.strictEqual(levels.length, 2)
  assert.deepStrictEqual(levels[0], ['parent'])
  // Order stable by seq.
  assert.deepStrictEqual(levels[1], ['k1', 'k2'])
})

test('computePositions returns positive width/height and per-node coords', () => {
  const g = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }],
    levels: [['a'], ['b', 'c']],
  }
  const p = G.computePositions(g)
  assert.ok(p.width > 200)
  assert.ok(p.height > 100)
  const a = p.by.get('a')
  const b = p.by.get('b')
  const c = p.by.get('c')
  assert.ok(a && b && c)
  assert.ok(b.x > a.x, 'b sits right of a')
  assert.strictEqual(b.x, c.x, 'siblings share a column')
  assert.ok(c.y > b.y, 'siblings stack vertically')
})

test('familyForEventNode filters out uninteresting types', () => {
  assert.strictEqual(G.familyForEventNode({ type: 'assistant/chunk' }), null)
  assert.strictEqual(G.familyForEventNode({ type: 'hook/allow' }), null)
  assert.strictEqual(G.familyForEventNode({ type: 'tool/call' }), 'tool')
  assert.strictEqual(G.familyForEventNode({ type: 'assistant/message' }), 'llm')
  assert.strictEqual(G.familyForEventNode({ type: 'request/header' }), 'llm')
  assert.strictEqual(G.familyForEventNode({ type: 'compact/summary' }), 'compact')
  assert.strictEqual(G.familyForEventNode({ type: 'subagent.started' }), 'subagent')
})

test('labelForEventNode surfaces model / tool name', () => {
  assert.strictEqual(
    G.labelForEventNode({ type: 'request/header', data: { header: { model: 'deepseek-chat' } } }, 'llm'),
    'deepseek-chat')
  assert.strictEqual(
    G.labelForEventNode({ type: 'tool/call', data: { name: 'read' } }, 'tool'),
    'read')
})

test('renderGraph produces a wrapper with an SVG child', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 1, endSeq: 4,
    startTime: 1000, endTime: 2000,
    events: [
      { type: 'assistant/message', time: 1100, seq: 2, data: {} },
      { type: 'tool/call', time: 1300, seq: 3, data: { callId: 'x', name: 'read' } },
      { type: 'tool/result', time: 1500, seq: 4, data: { callId: 'x' } },
    ],
    inputs: [], outputs: [], open: false,
  }
  const el = G.renderGraph(doc, rec)
  assert.ok(el)
  assert.ok(el.classList.contains('trace-graph'))
  const svg = el._children.find(c => c.tagName === 'SVG')
  assert.ok(svg)
})

// Clickability audit D2 (2026-07-17): the graph node exposes a click
// handler; the handler both dispatches onSeqClick AND marks its group
// with `.selected` so the reader gets visible feedback. Verify both.
test('renderGraph node click fires onSeqClick and toggles .selected', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 1, endSeq: 4,
    startTime: 1000, endTime: 2000,
    events: [
      { type: 'assistant/message', time: 1100, seq: 2, data: {} },
      { type: 'tool/call', time: 1300, seq: 3, data: { callId: 'x', name: 'read' } },
    ],
    inputs: [], outputs: [], open: false,
  }
  const seen = []
  const el = G.renderGraph(doc, rec, { onSeqClick: (seq, node) => seen.push([seq, node && node.family]) })
  // Recursive walker over the fake doc so we can pull click-bound node groups.
  // The fake doc distinguishes classList (used by DOM code) from the raw
  // `class` attribute written via setAttribute (which svgGroup uses). Match
  // either since trace-graph.js reads the SVG groups both ways.
  function findAll(root, cls) {
    const acc = []
    const stack = [root]
    while (stack.length) {
      const n = stack.pop()
      if (!n) continue
      const classAttr = (n._attrs && n._attrs.class) || ''
      const hasClass = (n.classList && typeof n.classList.contains === 'function' && n.classList.contains(cls))
        || classAttr.split(/\s+/).includes(cls)
      if (hasClass) acc.push(n)
      if (Array.isArray(n._children)) for (const c of n._children) stack.push(c)
    }
    return acc
  }
  const nodes = findAll(el, 'trace-graph-node')
  assert.ok(nodes.length >= 2, `expected 2+ node groups, got ${nodes.length}`)
  // First node with an actual click listener → invoke it.
  const clickable = nodes.find((n) => n._listeners && Array.isArray(n._listeners.click))
  assert.ok(clickable, 'at least one node has a click listener')
  clickable._listeners.click[0]({})
  assert.strictEqual(seen.length, 1, 'onSeqClick fired exactly once')
  assert.ok(clickable.classList.contains('selected'), 'clicked node wears .selected')
  // (Mutex-clear across nodes needs an SVG-level querySelectorAll that the
  // fake doc doesn't provide — asserted in the browser via the audit's
  // selfies. The pure builder guarantees the setter runs on each click,
  // which is the honest unit-test surface.)
})
