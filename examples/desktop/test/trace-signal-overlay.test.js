// trace-signal-overlay.test.js — Timeline + Graph rendering with a
// `signals` bySeq Map should drop badges/rings and expose the tooltip.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const T = require('../src/renderer/trace-timeline.js')
const G = require('../src/renderer/trace-graph.js')
const SD = require('../src/renderer/trace-signal-detect.js')

function makeDoc() {
  function makeEl(nsOrTag, tag) {
    const cls = { _s: new Set(),
      add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c) },
      contains(c) { return this._s.has(c) },
    }
    const el = {
      tagName: (tag || nsOrTag).toUpperCase(),
      _children: [],
      _attrs: {},
      _listeners: {},
      dataset: {},
      style: {},
      textContent: '',
      hidden: false,
      get className() { return Array.from(cls._s).join(' ') },
      set className(v) {
        cls._s.clear()
        String(v || '').split(/\s+/).forEach(x => x && cls._s.add(x))
      },
      classList: cls,
      appendChild(c) { this._children.push(c); return c },
      append(...cs) { for (const c of cs) this._children.push(c) },
      setAttribute(k, v) {
        this._attrs[k] = String(v)
        if (k === 'class') {
          cls._s.clear()
          String(v || '').split(/\s+/).forEach(x => x && cls._s.add(x))
        }
      },
      getAttribute(k) { return this._attrs[k] },
      addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn) },
      querySelector(sel) { return null },
      querySelectorAll() { return [] },
      firstChild: null,
      insertBefore(node) { this._children.unshift(node); return node },
      outerHTML: '',
    }
    return el
  }
  return {
    createElement(tag) { return makeEl(tag) },
    createElementNS(ns, tag) { return makeEl(ns, tag) },
    body: makeEl('body'),
  }
}

function collectByClass(root, cls) {
  const found = []
  const stack = [root]
  while (stack.length) {
    const cur = stack.pop()
    if (cur && cur.classList && cur.classList.contains(cls)) found.push(cur)
    if (cur && cur._children) for (const c of cur._children) stack.push(c)
  }
  return found
}

test('renderTimeline drops one signal badge per row whose seq appears in the map', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 14,
    startTime: 1000, endTime: 1500, durationMs: 500,
    summary: 'read', inputs: [], outputs: [],
    events: [
      { type: 'tool/call', seq: 11, time: 1050, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c1' } },
      { type: 'tool/call', seq: 12, time: 1100, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c2' } },
      { type: 'tool/call', seq: 13, time: 1150, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c3' } },
    ],
  }
  const { bySeq } = SD.detectSignalsFromRecords(rec, { loopN: 3 })
  const el = T.renderTimeline(doc, rec, { signals: bySeq })
  const badges = collectByClass(el, 'trace-timeline-signal-badge')
  assert.ok(badges.length >= 1, 'at least one signal badge drawn for the loop-detected seq (12)')
  // The badge for the loop-detected signal on seq 12 should carry the sig-loop class.
  const loopBadges = badges.filter(b => b.classList.contains('sig-loop'))
  assert.strictEqual(loopBadges.length, 1)
  // Tooltip <title> child is present
  const title = loopBadges[0]._children.find(c => c.tagName === 'TITLE')
  assert.ok(title, 'badge has a <title> tooltip child')
  assert.match(title.textContent, /Loop/)
})

test('renderTimeline draws no badges when signals map is empty', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 12,
    startTime: 1000, endTime: 1200,
    inputs: [], outputs: [],
    events: [
      { type: 'tool/call', seq: 11, time: 1050, data: { name: 'fs.read', arguments: '{}', callId: 'c1' } },
    ],
  }
  const el = T.renderTimeline(doc, rec, { signals: new Map() })
  const badges = collectByClass(el, 'trace-timeline-signal-badge')
  assert.strictEqual(badges.length, 0)
})

test('renderGraph puts a colored ring around a node whose seq matches a signal', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 14,
    startTime: 1000, endTime: 1500,
    inputs: [], outputs: [],
    events: [
      { type: 'tool/call', seq: 11, time: 1050, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c1' } },
      { type: 'tool/result', seq: 12, time: 1080, data: { callId: 'c1', ok: false, error: 'ENOENT' } },
    ],
  }
  const { bySeq } = SD.detectSignalsFromRecords(rec)
  const el = G.renderGraph(doc, rec, { signals: bySeq })
  const rings = collectByClass(el, 'trace-graph-signal-ring')
  assert.ok(rings.length >= 1, 'at least one signal ring around the tool-error seq')
  const errRings = rings.filter(r => r.classList.contains('sig-error'))
  assert.strictEqual(errRings.length, 1, 'ring wears the sig-error class')
})

test('renderGraph draws no rings without a signals map', () => {
  const doc = makeDoc()
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 12,
    startTime: 1000, endTime: 1100,
    inputs: [], outputs: [],
    events: [{ type: 'tool/call', seq: 11, time: 1050, data: { name: 'x', arguments: '{}', callId: 'c' } }],
  }
  const el = G.renderGraph(doc, rec, {})
  assert.strictEqual(collectByClass(el, 'trace-graph-signal-ring').length, 0)
})
