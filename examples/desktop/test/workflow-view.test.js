// workflow-view.test.js — task #138 batch 3 §1.6.
// Verifies:
//   1. classifyWorkflowKind normalises 'fanout' → 'fan-out' and rejects unknown kinds
//   2. summariseWorkflowProgress counts done/running/pending/failed across seq/iter shapes
//   3. buildWorkflowCard for seq shows the step list with statuses in order
//   4. buildWorkflowCard for dag stacks nodes by BFS level (in → out adjacency)
//   5. buildWorkflowCard for iter renders the predicate + iteration list
//   6. isMock adds the '未上 wire' chip; absent isMock leaves it off
//   7. showReplayBar mounts prev/next with correct enable/disable at ends
//   8. onStepClick fires with the step id

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const view = require('../src/renderer/workflow-view.js')

function makeDoc() {
  const store = new Map()
  const doc = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        _children: [],
        _listeners: {},
        dataset: {},
        style: {},
        textContent: '',
        appendChild(c) { this._children.push(c); return c },
        append(...cs) { for (const c of cs) this._children.push(c) },
        addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
        setAttribute() {},
        removeAttribute() {},
        classList: {
          _s: new Set(),
          add(c) { this._s.add(c) },
          remove(c) { this._s.delete(c) },
          contains(c) { return this._s.has(c) },
        },
      }
      Object.defineProperty(el, 'children', { get() { return this._children } })
      Object.defineProperty(el, 'firstChild', { get() { return this._children[0] || null } })
      Object.defineProperty(el, 'lastChild', { get() { return this._children[this._children.length - 1] || null } })
      Object.defineProperty(el, 'disabled', {
        get() { return this._disabled === true },
        set(v) { this._disabled = v },
      })
      return el
    },
  }
  return doc
}

function collectByClass(root, className, out = []) {
  if (!root) return out
  if (root.className && root.className.split(' ').includes(className)) out.push(root)
  for (const c of (root._children || [])) collectByClass(c, className, out)
  return out
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'trace-samples', name), 'utf-8'))
}

test('classifyWorkflowKind normalises fanout to fan-out and drops garbage', () => {
  assert.strictEqual(view.classifyWorkflowKind('seq'), 'seq')
  assert.strictEqual(view.classifyWorkflowKind('fanout'), 'fan-out')
  assert.strictEqual(view.classifyWorkflowKind('fan-out'), 'fan-out')
  assert.strictEqual(view.classifyWorkflowKind('DAG'), 'dag')
  assert.strictEqual(view.classifyWorkflowKind('unknown-kind'), 'unknown')
  assert.strictEqual(view.classifyWorkflowKind(null), 'unknown')
})

test('summariseWorkflowProgress counts across seq/iter', () => {
  const seq = loadFixture('1.6-workflow-seq.json')
  const p = view.summariseWorkflowProgress(seq.workflow)
  assert.strictEqual(p.total, 5)
  assert.strictEqual(p.done, 2)
  assert.strictEqual(p.running, 1)
  assert.strictEqual(p.pending, 2)
  assert.strictEqual(p.failed, 0)
  const iter = loadFixture('1.6-workflow-iter.json')
  const q = view.summariseWorkflowProgress(iter.workflow)
  assert.strictEqual(q.total, 3)
  assert.strictEqual(q.done, 2)
  assert.strictEqual(q.running, 1)
})

test('buildWorkflowCard for seq mounts step rows in order', () => {
  const doc = makeDoc()
  const seq = loadFixture('1.6-workflow-seq.json')
  const card = view.buildWorkflowCard(doc, seq.workflow, {})
  const steps = collectByClass(card, 'workflow-step')
  assert.strictEqual(steps.length, 5)
  // First step is done (has glyph ✓), third step is running (⋯).
  const glyphs = steps.map(s => collectByClass(s, 'workflow-step-glyph')[0].textContent)
  assert.strictEqual(glyphs[0], '✓')
  assert.strictEqual(glyphs[2], '⋯')
  assert.strictEqual(glyphs[3], '·')
})

test('buildWorkflowCard for dag stacks nodes by BFS level', () => {
  const doc = makeDoc()
  const dag = loadFixture('1.6-workflow-dag.json')
  const card = view.buildWorkflowCard(doc, dag.workflow, {})
  const layers = collectByClass(card, 'workflow-dag-layer')
  // The dag fixture has a root (checkout) with two out edges — two levels at
  // least. We don't hard-code the exact count (fixture shape may evolve) but
  // require ≥2 layers and that the total node count matches step count.
  assert.ok(layers.length >= 2, `expected ≥2 layers, got ${layers.length}`)
  const nodes = collectByClass(card, 'workflow-dag-node')
  assert.strictEqual(nodes.length, dag.workflow.steps.length)
})

test('buildWorkflowCard for iter renders predicate + iterations', () => {
  const doc = makeDoc()
  const iter = loadFixture('1.6-workflow-iter.json')
  const card = view.buildWorkflowCard(doc, iter.workflow, {})
  const pred = collectByClass(card, 'workflow-iter-predicate')[0]
  assert.ok(pred)
  assert.match(pred.textContent, /while \(hasMoreFiles/)
  const items = collectByClass(card, 'workflow-step')
  assert.strictEqual(items.length, 3)
})

test('isMock flag adds the mock chip; without it, chip is absent', () => {
  const doc = makeDoc()
  const seq = loadFixture('1.6-workflow-seq.json')
  const withMock = view.buildWorkflowCard(doc, seq.workflow, { isMock: true })
  assert.strictEqual(collectByClass(withMock, 'workflow-card-chip--mock').length, 1)
  const doc2 = makeDoc()
  const withoutMock = view.buildWorkflowCard(doc2, seq.workflow, { isMock: false })
  assert.strictEqual(collectByClass(withoutMock, 'workflow-card-chip--mock').length, 0)
})

test('isLive flag adds the live chip (not the mock chip); the two are exclusive', () => {
  const seq = loadFixture('1.6-workflow-seq.json')
  const live = view.buildWorkflowCard(makeDoc(), seq.workflow, { isLive: true })
  assert.strictEqual(collectByClass(live, 'workflow-card-chip--live').length, 1)
  assert.strictEqual(collectByClass(live, 'workflow-card-chip--mock').length, 0)
  // isMock wins when both are (wrongly) set — a card is never both live+mock.
  const both = view.buildWorkflowCard(makeDoc(), seq.workflow, { isMock: true, isLive: true })
  assert.strictEqual(collectByClass(both, 'workflow-card-chip--mock').length, 1)
  assert.strictEqual(collectByClass(both, 'workflow-card-chip--live').length, 0)
})

test('showReplayBar mounts prev/next and clamps at ends', () => {
  const doc = makeDoc()
  const seq = loadFixture('1.6-workflow-seq.json')
  const moves = []
  const card = view.buildWorkflowCard(doc, seq.workflow, {
    showReplayBar: true,
    onReplayMove: (id) => moves.push(id),
  })
  const bar = collectByClass(card, 'workflow-replay-bar')[0]
  assert.ok(bar, 'expected a replay bar')
  const buttons = collectByClass(bar, 'workflow-replay-btn')
  assert.strictEqual(buttons.length, 2)
  // Default idx = running step (s3, index 2). prev should be enabled, next enabled.
  assert.strictEqual(buttons[0].disabled, false)
  // Firing next twice takes us to s5 (idx 4), then a third click clamps.
  const next = buttons[1]
  const nextClick = (next._listeners.click || [])[0]
  nextClick(); nextClick()
  assert.deepStrictEqual(moves.slice(-2), ['s4', 's5'])
  assert.strictEqual(next.disabled, true)
})

test('onStepClick fires with the step id when a seq step is clicked', () => {
  const doc = makeDoc()
  const seq = loadFixture('1.6-workflow-seq.json')
  const clicked = []
  const card = view.buildWorkflowCard(doc, seq.workflow, {
    onStepClick: (id) => clicked.push(id),
  })
  const steps = collectByClass(card, 'workflow-step')
  const clickFn = (steps[0]._listeners.click || [])[0]
  assert.ok(clickFn, 'expected a click listener on the first step')
  clickFn()
  assert.deepStrictEqual(clicked, ['s1'])
})
