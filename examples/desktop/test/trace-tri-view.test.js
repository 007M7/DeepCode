// trace-tri-view.test.js — Task #203 chips + panel container.
//
// Verifies:
//   1. buildTriView emits three chips [Tree | Timeline | Graph]
//   2. Tree panel adopts the caller's treeEl
//   3. Timeline / Graph panels are hidden by default
//   4. Clicking a chip toggles the .active class and unhides the matching
//      panel
//   5. Export button is hidden on Tree, visible on Timeline/Graph
//   6. sessionTraceRecords delegates to __dshTraceAgg.aggregateSteps
//   7. Rendering handles a missing treeEl gracefully with a stub
//
// The container relies on window.__dshTraceTimeline / __dshTraceGraph /
// __dshTraceAgg globals — we stub them for the test.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const TRI = require('../src/renderer/trace-tri-view.js')

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
      hidden: false,
      get className() { return Array.from(cls._s).join(' ') },
      set className(v) { cls._s.clear(); String(v || '').split(/\s+/).forEach(x => x && cls._s.add(x)) },
      classList: cls,
      appendChild(c) { this._children.push(c); return c },
      append(...cs) { for (const c of cs) this._children.push(c) },
      setAttribute(k, v) { this._attrs[k] = String(v) },
      getAttribute(k) { return this._attrs[k] },
      addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
      querySelector(sel) {
        // Support one attribute selector shape: '.trace-tri-chip.active'
        // used by the export button click path. We walk children.
        const bits = String(sel).split(/[.\s]/).filter(Boolean)
        const stack = [this]
        while (stack.length) {
          const cur = stack.pop()
          if (cur !== this && cur._attrs && cur._attrs['class']) {
            const cls = cur._attrs['class'].split(/\s+/)
            if (bits.every(b => cls.includes(b))) return cur
          }
          for (const c of cur._children || []) stack.push(c)
        }
        return null
      },
    }
    return el
  }
  return {
    createElement(tag) { return makeEl(tag) },
    createElementNS(_ns, tag) { return makeEl(tag) },
    body: makeEl('body'),
  }
}

function collectByClass(root, cls) {
  const out = []
  function walk(el) {
    if (!el) return
    if (el.classList && el.classList._s && el.classList._s.has(cls)) out.push(el)
    for (const c of el._children || []) walk(c)
  }
  walk(root)
  return out
}

test('buildTriView emits three chips and matching panels', () => {
  const doc = makeDoc()
  const tree = doc.createElement('div')
  tree.textContent = 'pre-rendered trace card'
  const el = TRI.buildTriView(doc, { treeEl: tree, records: {}, scope: 'turn' })
  assert.ok(el.classList.contains('trace-tri-view'))
  const chips = collectByClass(el, 'trace-tri-chip')
  assert.strictEqual(chips.length, 3)
  assert.deepStrictEqual(chips.map(c => c.textContent), ['Tree', 'Timeline', 'Graph'])
  const panels = collectByClass(el, 'trace-tri-panel')
  assert.strictEqual(panels.length, 3)
  // Tree active by default.
  assert.strictEqual(chips[0].classList._s.has('active'), true)
  assert.strictEqual(panels[0].hidden, false)
  assert.strictEqual(panels[1].hidden, true)
  assert.strictEqual(panels[2].hidden, true)
})

test('buildTriView: Tree panel adopts the caller treeEl', () => {
  const doc = makeDoc()
  const tree = doc.createElement('div')
  tree.dataset.tag = 'mine'
  const el = TRI.buildTriView(doc, { treeEl: tree, records: {} })
  const panels = collectByClass(el, 'trace-tri-panel')
  // Panel now carries the tree-side toolbar (2026-07-17 addendum) before
  // the caller's treeEl — find `mine` anywhere inside instead of at [0].
  const found = (panels[0]._children || []).some(c => c && c.dataset && c.dataset.tag === 'mine')
  assert.ok(found, 'treeEl mounted inside Tree panel')
})

test('Tree panel carries a toolbar with filter + Waterfall + Expand/Collapse + Settings', () => {
  const doc = makeDoc()
  const tree = doc.createElement('div')
  const el = TRI.buildTriView(doc, { treeEl: tree, records: {} })
  const bar = collectByClass(el, 'trace-tree-toolbar')[0]
  assert.ok(bar, 'toolbar renders in Tree panel')
  assert.ok(collectByClass(bar, 'trace-tree-filter').length, 'filter input present')
  assert.ok(collectByClass(bar, 'trace-tree-waterfall').length, 'Waterfall toggle present')
  assert.ok(collectByClass(bar, 'trace-tree-expand').length, 'Expand all present')
  assert.ok(collectByClass(bar, 'trace-tree-collapse').length, 'Collapse all present')
  assert.ok(collectByClass(bar, 'trace-tree-settings').length, 'Settings present')
})

test('buildTreeToolbar Waterfall toggle flips .waterfall-off on the tree root', () => {
  const doc = makeDoc()
  const tree = doc.createElement('div')
  const tb = TRI.buildTreeToolbar(doc, {})
  tb.attach(tree)
  const wf = collectByClass(tb.el, 'trace-tree-waterfall')[0]
  assert.ok(wf)
  const before = tree.classList._s.has('waterfall-off')
  wf._listeners.click[0]({})
  assert.notStrictEqual(before, tree.classList._s.has('waterfall-off'),
    'first click toggles waterfall-off')
})

test('clicking Timeline chip activates the panel and lazy-builds it', () => {
  const doc = makeDoc()
  const stub = doc.createElement('div')
  stub.dataset.stub = 'timeline'
  global.window = {
    __dshTraceTimeline: {
      renderTimeline() { return stub },
    },
  }
  try {
    const el = TRI.buildTriView(doc, { treeEl: null, records: {} })
    const chips = collectByClass(el, 'trace-tri-chip')
    // Chip for Timeline is the second one.
    const listeners = chips[1]._listeners.click
    listeners[0]({})
    const panels = collectByClass(el, 'trace-tri-panel')
    assert.strictEqual(panels[1].hidden, false)
    // Panel now contains the stub returned by renderTimeline.
    const found = panels[1]._children.some(c => c.dataset && c.dataset.stub === 'timeline')
    assert.ok(found, 'timeline stub mounted')
  } finally {
    delete global.window
  }
})

test('Export button hidden on Tree, visible on Timeline/Graph', () => {
  const doc = makeDoc()
  const el = TRI.buildTriView(doc, { treeEl: null, records: {} })
  const exportBtn = collectByClass(el, 'trace-tri-export')[0]
  assert.ok(exportBtn)
  assert.strictEqual(exportBtn.hidden, true, 'hidden on default Tree view')
  const chips = collectByClass(el, 'trace-tri-chip')
  // Simulate a switch to Graph (chip index 2).
  global.window = { __dshTraceGraph: { renderGraph() { return doc.createElement('div') } } }
  try { chips[2]._listeners.click[0]({}) } finally { delete global.window }
  assert.strictEqual(exportBtn.hidden, false, 'visible after Graph switch')
})

test('sessionTraceRecords delegates to __dshTraceAgg.aggregateSteps', () => {
  const events = [{ type: 'step/start', seq: 1 }, { type: 'step/end', seq: 2 }]
  const seen = []
  global.window = {
    __dshTraceAgg: {
      aggregateSteps(input) { seen.push(input); return [{ turn: 0, step: 0 }] },
    },
  }
  try {
    const out = TRI.sessionTraceRecords(events)
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(out.length, 1)
  } finally { delete global.window }
})

test('missing treeEl renders an explanatory stub', () => {
  const doc = makeDoc()
  const el = TRI.buildTriView(doc, { treeEl: null, records: {} })
  const panels = collectByClass(el, 'trace-tri-panel')
  const stubs = collectByClass(panels[0], 'trace-tri-stub')
  assert.strictEqual(stubs.length, 1)
  assert.match(stubs[0].textContent, /per-turn/i)
})
