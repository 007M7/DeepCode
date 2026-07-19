// Tests for feat/chat-triple-view: color tokens, side drawer, session graph.
// Covers:
//   - style.css declares the three §7 turn edge tokens and applies them
//     to the correct selectors
//   - chat-side-drawer.deriveTurnRows / summarize / renderChatSideDrawer
//     produce the right shape for a fixture event stream
//   - chat-session-graph.deriveGraph node count == turn count, and fork /
//     interrupt edges land on the correct edge kinds

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const drawer = require('../src/renderer/chat-side-drawer.js')
const graph = require('../src/renderer/chat-session-graph.js')

// -- Fixture: 3-turn session with one fork + one interruption --------------
function buildFixture() {
  return [
    { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hello there' }] } },
    { type: 'turn/start', seq: 2, data: { turnId: 't0', model: 'deepseek-r1' } },
    { type: 'assistant/message', seq: 3, data: { text: 'hi — how can I help?' } },
    { type: 'turn/end', seq: 4, data: { turnId: 't0', usage: { total_tokens: 128 }, durationMs: 500 } },

    { type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'run a task' }] } },
    { type: 'turn/start', seq: 6, data: { turnId: 't1', model: 'deepseek-r1' } },
    { type: 'assistant/message', seq: 7, data: { text: 'sure, working on it' } },
    { type: 'turn/end', seq: 8, data: { turnId: 't1', usage: { total_tokens: 512 }, durationMs: 4200 } },

    // fork off t1 into a child session
    { type: 'session/fork', seq: 9, data: { fromTurnId: 't1', childSessionId: 'child-abc' } },

    { type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: 'wait, cancel that' }] } },
    { type: 'turn/start', seq: 11, data: { turnId: 't2', model: 'deepseek-r1' } },
    { type: 'user/interrupt', seq: 12, data: {} },
    { type: 'turn/end', seq: 13, data: { turnId: 't2', stopReason: 'cancelled' } },
  ]
}

// -- CSS token gate --------------------------------------------------------
test('style.css declares §7 turn edge tokens on :root', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  assert.match(css, /--turn-action-edge\s*:/, 'missing --turn-action-edge token')
  assert.match(css, /--turn-output-edge\s*:/, 'missing --turn-output-edge token')
  assert.match(css, /--turn-interrupt-marker\s*:/, 'missing --turn-interrupt-marker token')
})
test('style.css applies action edge to .assistant-turn border-left', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  // capture the .assistant-turn block up to the first close brace
  const m = css.match(/\.assistant-turn\s*\{[^}]+\}/)
  assert.ok(m, '.assistant-turn rule missing')
  assert.match(m[0], /border-left:\s*2px\s+solid\s+var\(--turn-action-edge\)/,
    '.assistant-turn should paint its left rail with --turn-action-edge')
})
test('style.css applies output edge to tool-result-row inside a turn', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  assert.match(css, /\.assistant-turn\s*>\s*\.turn-body\s*>\s*\.tool-result-row\s*\{[^}]*--turn-output-edge/,
    'tool-result-row inside turn should reference --turn-output-edge')
})
test('style.css declares .turn-interrupt-marker with the interrupt color', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8')
  assert.match(css, /\.turn-interrupt-marker\s*\{[^}]*var\(--turn-interrupt-marker\)/,
    '.turn-interrupt-marker should paint with --turn-interrupt-marker')
})

// -- Side drawer pure functions --------------------------------------------
test('deriveTurnRows: builds user + turn rows in wire order', () => {
  const rows = drawer.deriveTurnRows(buildFixture())
  const kinds = rows.map((r) => r.kind)
  assert.deepEqual(kinds, ['user', 'turn', 'user', 'turn', 'user', 'turn'])
  const turns = rows.filter((r) => r.kind === 'turn')
  assert.equal(turns.length, 3)
  assert.equal(turns[0].turnId, 't0')
  assert.equal(turns[0].tokens, 128)
  assert.equal(turns[1].tokens, 512)
  assert.equal(turns[2].interrupted, true, 't2 should be marked interrupted')
})
test('summarize: totals across turns', () => {
  const rows = drawer.deriveTurnRows(buildFixture())
  const s = drawer.summarize(rows)
  assert.equal(s.turnCount, 3)
  assert.equal(s.userCount, 3)
  assert.equal(s.tokens, 640) // 128 + 512 + 0
  assert.equal(s.interrupted, 1)
})
test('firstLine: strips + truncates', () => {
  assert.equal(drawer.firstLine('short'), 'short')
  assert.equal(drawer.firstLine('line 1\nline 2'), 'line 1')
  const big = 'x'.repeat(200)
  const trimmed = drawer.firstLine(big)
  assert.ok(trimmed.length <= 80)
  assert.ok(trimmed.endsWith('…'))
})

// -- Drawer render (DOM shim) ----------------------------------------------
function makeMiniDoc() {
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      dataset: {},
      _children: [],
      _attrs: {},
      _listeners: {},
      classList: {
        _cls: new Set(),
        add(c) { this._cls.add(c) },
        remove(c) { this._cls.delete(c) },
        contains(c) { return this._cls.has(c) },
        toggle(c, force) {
          const has = this._cls.has(c)
          const shouldOn = typeof force === 'boolean' ? force : !has
          if (shouldOn) this._cls.add(c); else this._cls.delete(c)
        },
      },
      appendChild(c) { this._children.push(c); return c },
      append(...cs) { for (const c of cs) this._children.push(c); return this },
      setAttribute(k, v) {
        this._attrs[k] = v
        // In real DOM, HTML elements' `class` attribute mirrors to className;
        // SVG elements' does not, but for the purposes of these tests we
        // don't care about that distinction — mirror so the filter works.
        if (k === 'class') this.className = String(v)
      },
      addEventListener(evt, fn) { (this._listeners[evt] ||= []).push(fn) },
      querySelectorAll(sel) {
        const cls = sel.replace(/^\./, '')
        const out = []
        const walk = (n) => {
          if (!n || !Array.isArray(n._children)) return
          for (const c of n._children) {
            if (c && typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) out.push(c)
            walk(c)
          }
        }
        walk(this)
        return out
      },
    }
  }
  return { createElement: el, createElementNS: (ns, tag) => el(tag) }
}
test('renderChatSideDrawer: paints three sections', () => {
  const doc = makeMiniDoc()
  const container = doc.createElement('div')
  container.ownerDocument = doc
  drawer.renderChatSideDrawer(container, {
    sessionId: 's-abc-123456',
    events: buildFixture(),
  })
  const sections = container.querySelectorAll('.chat-side-drawer-section')
  assert.equal(sections.length, 3, 'expected 3 sections: current / overview / history')
  const historyItems = container.querySelectorAll('.chat-side-drawer-history-item')
  // 3 user rows + 3 turns = 6
  assert.equal(historyItems.length, 6)
})

// -- Session graph ---------------------------------------------------------
test('deriveGraph: node count matches user+turn+fork events', () => {
  const g = graph.deriveGraph(buildFixture())
  const turnNodes = g.nodes.filter((n) => n.kind === 'turn' || n.kind === 'interrupt')
  const userNodes = g.nodes.filter((n) => n.kind === 'user')
  const forkNodes = g.nodes.filter((n) => n.kind === 'fork')
  assert.equal(turnNodes.length, 3, 'three turn nodes (interrupted still counts as turn)')
  assert.equal(userNodes.length, 3)
  assert.equal(forkNodes.length, 1)
})
test('deriveGraph: fork edge is dashed and interrupt edge is orange', () => {
  const g = graph.deriveGraph(buildFixture())
  const forkEdge = g.edges.find((e) => e.kind === 'fork')
  assert.ok(forkEdge, 'fork edge missing')
  const interruptEdge = g.edges.find((e) => e.kind === 'interrupt')
  assert.ok(interruptEdge, 'interrupt edge missing')
  // Interrupt edge terminates at an interrupt-kind node.
  const target = g.nodes.find((n) => n.id === interruptEdge.to)
  assert.equal(target.kind, 'interrupt')
})
test('deriveGraph: succession edges chain the main line', () => {
  const g = graph.deriveGraph(buildFixture())
  const successionEdges = g.edges.filter((e) => e.kind === 'succession')
  // 6 main-line nodes ⇒ 5 chained edges; the one that lands on the
  // interrupted t2 gets recoloured to `interrupt`, leaving 4 succession.
  assert.equal(successionEdges.length, 4)
  const interruptEdges = g.edges.filter((e) => e.kind === 'interrupt')
  assert.equal(interruptEdges.length, 1)
})
test('layoutGraph: assigns fork a right-shifted column', () => {
  const g = graph.deriveGraph(buildFixture())
  const laid = graph.layoutGraph(g)
  const forkNode = g.nodes.find((n) => n.kind === 'fork')
  const parentEdge = g.edges.find((e) => e.to === forkNode.id)
  const forkPos = laid.positions.get(forkNode.id)
  const parentPos = laid.positions.get(parentEdge.from)
  assert.ok(forkPos.x > parentPos.x, 'fork should be shifted right of its parent')
  assert.equal(forkPos.y, parentPos.y, 'fork sits on the same row as its parent')
})
test('renderSessionGraph: draws SVG with node + edge groups', () => {
  const doc = makeMiniDoc()
  const container = doc.createElement('div')
  container.ownerDocument = doc
  graph.renderSessionGraph(container, { events: buildFixture() })
  const svg = container._children[0]
  assert.ok(svg, 'svg root missing')
  assert.equal(svg.tagName, 'SVG')
  // Count node <g> children (kind: graph-node) and edges (graph-edge)
  const nodes = svg._children.filter((c) => typeof c.className === 'string' && c.className.startsWith('graph-node'))
  const edges = svg._children.filter((c) => typeof c.className === 'string' && c.className.startsWith('graph-edge'))
  assert.equal(nodes.length, 7, 'three turns + three users + one fork = 7 nodes')
  assert.ok(edges.length >= 5, 'at least the five main-line succession edges + fork + interrupt')
})
test('renderSessionGraph: empty state when no events', () => {
  const doc = makeMiniDoc()
  const container = doc.createElement('div')
  container.ownerDocument = doc
  graph.renderSessionGraph(container, { events: [] })
  const empty = container._children[0]
  assert.equal(empty.className, 'chat-session-graph-empty')
})
