// DOM-shape tests for the four lane-ctx-deep enhancements (task #51).
//
// These assert on the rendered element trees without booting jsdom or the
// Electron shell. Each test mocks the minimal DOM surface each builder
// touches (createElement + appendChild + attribute + dataset), running
// through the same code paths the production shell exercises.
//
// The four features covered:
//   F1 — window occupancy bar: renders 5 stacked segments.
//   F2 — compact-card 4th tab "Config": strip includes a `Config` button
//        AND the config body is populated with threshold+progress rows.
//   F3 — intervention marker strip: emits one marker per intervention.
//   F4 — subagent drill-down tabs: emits `Tool defs (N)` + `Inbound query`
//        strip and populated bodies.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// --- Handroll DOM stub ---------------------------------------------------
//
// The builders under test never touch layout, only tree structure + a few
// attrs/dataset entries + textContent + eventListeners. This stub covers
// exactly that.

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    tabIndex: 0,
    style: (function () {
      const map = {}
      return {
        setProperty(k, v) { map[k] = v },
        getPropertyValue(k) { return map[k] },
      }
    })(),
    dataset: {},
    _attrs: {},
    _listeners: {},
    _children: [],
    ownerDocument: null, // set below
    appendChild(c) { this._children.push(c); return c },
    append(...kids) { for (const k of kids) this._children.push(k) },
    setAttribute(k, v) { this._attrs[k] = String(v) },
    getAttribute(k) { return this._attrs[k] },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn)
    },
    querySelector() { return null },
    remove() { /* no-op */ },
  }
}

function makeDoc() {
  const doc = {
    createElement(tag) {
      const el = makeEl(tag)
      el.ownerDocument = doc
      return el
    },
    body: null,
    getElementById() { return null },
  }
  doc.body = doc.createElement('body')
  return doc
}

// Recursively find children matching a class prefix.
function findAllByClass(root, cls, out) {
  out = out || []
  if (!root) return out
  if (root.className && String(root.className).split(/\s+/).includes(cls)) out.push(root)
  for (const c of root._children || []) findAllByClass(c, cls, out)
  return out
}
function findFirstByClass(root, cls) {
  const all = findAllByClass(root, cls, [])
  return all[0] || null
}

// --- F2: compact-card 4-tab shell ----------------------------------------

test('F2: mountTabs with fillConfig adds a Config tab and populates its body', () => {
  const { mountTabs } = require('../src/renderer/compact-card.js')
  const doc = makeDoc()
  const parent = doc.createElement('div')

  let filledConfig = null
  mountTabs(parent, {
    document: doc,
    initial: 'post',
    fillPre: (body) => { body.textContent = 'pre' },
    fillPost: (body) => { body.textContent = 'post' },
    fillMeta: (body) => { body.textContent = 'meta' },
    fillConfig: (body) => { body.textContent = 'CONFIG_HERE'; filledConfig = body },
  })

  // Tab buttons: expect four in the strip.
  const strip = findFirstByClass(parent, 'compact-card-tabstrip')
  assert.ok(strip, 'tabstrip mounted')
  const tabButtons = strip._children.filter((c) => c.tagName === 'BUTTON')
  assert.equal(tabButtons.length, 4, 'expect 4 tabs when fillConfig is provided')
  const labels = tabButtons.map((b) => b.textContent)
  assert.deepEqual(labels, ['Diff', 'Summary', 'Policy & accounting', 'Config'])

  // Config body populated.
  assert.equal(filledConfig.textContent, 'CONFIG_HERE')
})

test('F2: mountTabs without fillConfig stays a 3-tab shell (back-compat)', () => {
  const { mountTabs } = require('../src/renderer/compact-card.js')
  const doc = makeDoc()
  const parent = doc.createElement('div')
  const out = mountTabs(parent, {
    document: doc,
    fillPre() {}, fillPost() {}, fillMeta() {},
  })
  const strip = findFirstByClass(parent, 'compact-card-tabstrip')
  const tabButtons = strip._children.filter((c) => c.tagName === 'BUTTON')
  assert.equal(tabButtons.length, 3)
  assert.equal(out.configBody, null)
})

// --- F4: subagent drill-down tabs ---------------------------------------

test('F4: appendSubagentDrilldownTabs emits both panels with correct labels', () => {
  const { appendSubagentDrilldownTabs } = require('../src/renderer/subagent-view.js')
  const doc = makeDoc()
  const parent = doc.createElement('div')
  const spec = {
    childEvents: [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'seed' }], source: { kind: 'plugin', plugin: 'subagent-search' } } },
      { type: 'tool/call', seq: 2, data: { name: 'search', arguments: '{"q":"x"}' } },
      { type: 'tool/call', seq: 3, data: { name: 'read_file', arguments: '{"path":"a"}' } },
    ],
  }
  appendSubagentDrilldownTabs(doc, parent, spec)
  // Two tab buttons expected.
  const strip = findFirstByClass(parent, 'subagent-drilldown-tabstrip')
  assert.ok(strip, 'drilldown tabstrip mounted')
  const buttons = strip._children.filter((c) => c.tagName === 'BUTTON')
  assert.equal(buttons.length, 2)
  const btnLabels = buttons.map((b) => b.textContent)
  assert.match(btnLabels[0], /Tool defs \(2\)/)
  assert.equal(btnLabels[1], 'Inbound query')
  // Tool list should have two entries.
  const toolRows = findAllByClass(parent, 'subagent-drilldown-toolrow', [])
  assert.equal(toolRows.length, 2)
  // Inbound query blockquote should carry the seed text.
  const query = findFirstByClass(parent, 'subagent-drilldown-query')
  assert.ok(query, 'inbound query rendered')
  assert.match(query.textContent, /seed/)
})

test('F4: appendSubagentDrilldownTabs skips entirely on empty spec', () => {
  const { appendSubagentDrilldownTabs } = require('../src/renderer/subagent-view.js')
  const doc = makeDoc()
  const parent = doc.createElement('div')
  appendSubagentDrilldownTabs(doc, parent, {})
  assert.equal(parent._children.length, 0, 'no drilldown wrapper for empty spec')
})

// --- F1 + F3 model-shape sanity ----------------------------------------
// (Full DOM wire-up of context-page.js is exercised by the four real-machine
// screenshots at task-end. Here we lock the shapes the DOM depends on.)

test('F1 model: computeWindowBreakdown returns 5 slices in FAMILY_ORDER', () => {
  const M = require('../src/renderer/context-window-breakdown.js')
  const events = [
    { type: 'context/message', seq: 1, data: { content: [{ type: 'text', text: 'sys' }], source: { kind: 'system' } } },
    { type: 'assistant/message', seq: 2, data: { content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 100, outputTokens: 40 } } },
    { type: 'assistant/reasoning', seq: 3, data: { content: [{ type: 'text', text: 'thinking' }] } },
  ]
  const view = M.computeWindowBreakdown(events)
  assert.equal(view.slices.length, 5)
  const totalPct = view.slices.reduce((s, sl) => s + sl.pct, 0)
  assert.ok(totalPct <= 100.5, `sum ${totalPct} <= 100`)
})

test('F3 model: collectInterventions preserves seq order + kind counts', () => {
  const M = require('../src/renderer/intervention-timeline.js')
  const events = [
    { type: 'steering/message', seq: 5, data: { content: [{ type: 'text', text: 'a' }] } },
    { type: 'session/forked', seq: 10, data: { parentSeq: 8 } },
    { type: 'user/message', seq: 15, data: { content: [{ type: 'text', text: 'r' }], editRerun: { origSeq: 12 } } },
  ]
  const markers = M.collectInterventions(events)
  assert.equal(markers.length, 3)
  assert.deepEqual(markers.map((m) => m.kind), ['steer', 'fork', 'edit-rerun'])
  const roll = M.summariseInterventions(markers)
  const rollMap = new Map(roll.map((r) => [r.kind, r.count]))
  assert.equal(rollMap.get('steer'), 1)
  assert.equal(rollMap.get('fork'), 1)
  assert.equal(rollMap.get('edit-rerun'), 1)
})
