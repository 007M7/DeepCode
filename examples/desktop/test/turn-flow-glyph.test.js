// Unit tests for turn-flow-glyph — the per-turn inline flow shape (task
// #201, trace-viz-forms.md §4d). Focus: kind derivation priority, glyph
// spec shape, and SVG DOM structure via a jsdom-shaped document stub.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  deriveGlyphSpec, buildTurnFlowGlyph, stepKind, stepLabel, computeWidth, STEP_KIND_ORDER,
} = require('../src/renderer/turn-flow-glyph.js')

// ---- minimal SVG-aware doc stub (mirrors buildTurnFooter tests style)

function makeDoc() {
  function make(tag) {
    return {
      tag, ns: null, children: [],
      attrs: {},
      _listeners: {},
      _title: '',
      get textContent() { return this._title },
      set textContent(v) { this._title = String(v) },
      setAttribute(k, v) { this.attrs[k] = String(v) },
      getAttribute(k) { return this.attrs[k] },
      appendChild(c) { this.children.push(c); return c },
      addEventListener(k, fn) { (this._listeners[k] ||= []).push(fn) },
      querySelector(sel) {
        // very small: `.class` and `[data-x]`
        for (const c of this.children) {
          if (matches(c, sel)) return c
          const q = c.querySelector && c.querySelector(sel)
          if (q) return q
        }
        return null
      },
      querySelectorAll(sel) {
        const out = []
        for (const c of this.children) {
          if (matches(c, sel)) out.push(c)
          if (c.querySelectorAll) out.push(...c.querySelectorAll(sel))
        }
        return out
      },
      dispatchEvent(e) {
        const list = this._listeners[e.type] || []
        for (const fn of list) fn(e)
      },
    }
  }
  function matches(node, sel) {
    if (!node || !node.attrs) return false
    if (sel.startsWith('.')) {
      const cls = sel.slice(1)
      return (node.attrs.class || '').split(/\s+/).includes(cls)
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1)
      const [k, vRaw] = inner.split('=')
      if (vRaw === undefined) return k in node.attrs
      const v = vRaw.replace(/^"|"$/g, '')
      return node.attrs[k] === v
    }
    return node.tag === sel
  }
  return {
    defaultView: {
      CustomEvent: function CustomEvent(type, init) {
        this.type = type; this.detail = (init && init.detail) || null; this.bubbles = !!(init && init.bubbles)
      },
    },
    createElement: make,
    createElementNS(_ns, tag) { const n = make(tag); n.ns = _ns; return n },
  }
}

// ---- kind derivation

test('stepKind: pure assistant message → llm', () => {
  const step = { events: [], outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'ok' }] } }] }
  assert.equal(stepKind(step), 'llm')
})

test('stepKind: tool call present → tool', () => {
  const step = { events: [], outputs: [{ type: 'tool/call', data: { name: 'Read' } }] }
  assert.equal(stepKind(step), 'tool')
})

test('stepKind: subagent event → subagent (over tool)', () => {
  const step = {
    events: [{ type: 'subagent/started', data: {} }],
    outputs: [{ type: 'tool/call', data: { name: 'Read' } }],
  }
  assert.equal(stepKind(step), 'subagent')
})

test('stepKind: compact/summary event → compact (over tool)', () => {
  const step = {
    events: [{ type: 'compact/summary', data: {} }],
    outputs: [{ type: 'tool/call', data: { name: 'X' } }],
  }
  assert.equal(stepKind(step), 'compact')
})

test('stepKind: error event dominates everything else', () => {
  const step = {
    events: [{ type: 'subagent/started' }, { type: 'error', data: { error: { message: 'boom' } } }],
    outputs: [{ type: 'tool/call', data: { name: 'X' } }],
  }
  assert.equal(stepKind(step), 'error')
})

test('stepKind: empty step falls back to llm (reasoning-only turn)', () => {
  assert.equal(stepKind({ events: [], outputs: [] }), 'llm')
})

test('stepKind: undefined/null → llm safe default', () => {
  assert.equal(stepKind(null), 'llm')
  assert.equal(stepKind(undefined), 'llm')
})

test('stepLabel: includes kind + step number + trimmed summary', () => {
  const step = { turn: 1, step: 2, summary: '  reading types.ts  ', outputs: [{ type: 'assistant/message', data: { content: [] } }] }
  const l = stepLabel(step)
  assert.match(l, /llm/)
  assert.match(l, /1\.2/)
  assert.match(l, /reading types\.ts/)
})

test('stepLabel: no turn falls back to `?`', () => {
  assert.match(stepLabel({ turn: null, step: null, summary: 'x' }), /step \?/)
})

// ---- spec derivation

test('deriveGlyphSpec: null when no steps', () => {
  assert.equal(deriveGlyphSpec(null), null)
  assert.equal(deriveGlyphSpec([]), null)
  assert.equal(deriveGlyphSpec(undefined), null)
})

test('deriveGlyphSpec: single-step with no outputs/events → null (min-info threshold)', () => {
  // User 2026-07-17 実機 zero-data screenshot: a step that recorded a
  // kind but had no outputs and no events is not worth drawing — the
  // glyph would be a lonely dot in a 120×24 frame. Threshold hardened
  // 2026-07-18 (echo-profile screenshot): `<2 steps → null` regardless
  // of payload signal, because the single dot horizontally centered
  // inside the 120px fixed frame reads as random indent next to real
  // metrics chips.
  assert.equal(deriveGlyphSpec([{ outputs: [], events: [] }]), null)
  assert.equal(deriveGlyphSpec([{}]), null)
})

test('deriveGlyphSpec: single-step WITH outputs still returns null (2026-07-18 threshold hardening)', () => {
  // 2026-07-18 echo-profile fix: the previous rule kept a single-dot glyph
  // when the step had outputs. Real echo turns hit this path (one step,
  // one assistant/message output) — and the resulting lone dot floating in
  // the 120px frame is the exact "glyph 只剩一个孤点悬空缩进" symptom the
  // user flagged. Threshold is now strict: <2 dots → null unconditionally.
  // The step's signal is still reachable one layer down via the trace
  // drawer summary immediately below the footer.
  const spec = deriveGlyphSpec([{ outputs: [{ type: 'assistant/message', data: { content: [] } }] }])
  assert.equal(spec, null)
})

test('deriveGlyphSpec: dot per step in order', () => {
  const steps = [
    { outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'Read' } }] },
    { outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'done' }] } }] },
  ]
  const spec = deriveGlyphSpec(steps)
  assert.equal(spec.count, 3)
  assert.deepEqual(spec.dots.map(d => d.kind), ['llm', 'tool', 'llm'])
  assert.deepEqual(spec.dots.map(d => d.index), [0, 1, 2])
})

test('deriveGlyphSpec: multi-tool-loop shape (llm→tool→llm→tool→llm)', () => {
  const steps = [
    { outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'a' }] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'A' } }] },
    { outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'b' }] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'B' } }] },
    { outputs: [{ type: 'assistant/message', data: { content: [{ type: 'text', text: 'c' }] } }] },
  ]
  const spec = deriveGlyphSpec(steps)
  assert.equal(spec.count, 5)
  assert.deepEqual(spec.dots.map(d => d.kind), ['llm', 'tool', 'llm', 'tool', 'llm'])
})

// ---- SVG build

test('buildTurnFlowGlyph: returns null on null spec', () => {
  const doc = makeDoc()
  assert.equal(buildTurnFlowGlyph(doc, null), null)
  assert.equal(buildTurnFlowGlyph(doc, { dots: [], count: 0 }), null)
})

test('buildTurnFlowGlyph: correct SVG shell + one circle per dot', () => {
  const doc = makeDoc()
  const spec = deriveGlyphSpec([
    { outputs: [{ type: 'assistant/message', data: { content: [] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'X' } }] },
    { events: [{ type: 'subagent/started' }], outputs: [] },
  ])
  const svg = buildTurnFlowGlyph(doc, spec)
  assert.equal(svg.tag, 'svg')
  assert.equal(svg.attrs.class, 'turn-flow-glyph')
  // Spec §7: click target ≥24px; H bumped from 20 → 24. Fixed W=120
  // eliminates row-jitter as steps stream in.
  assert.equal(svg.attrs.height, '24')
  assert.equal(svg.attrs.width, '120')
  assert.equal(svg.attrs.role, 'button')
  assert.equal(svg.attrs.tabindex, '0')
  const circles = svg.querySelectorAll('circle')
  assert.equal(circles.length, 3)
  const classes = circles.map(c => c.attrs.class)
  assert(classes[0].includes('kind-llm'))
  assert(classes[1].includes('kind-tool'))
  assert(classes[2].includes('kind-subagent'))
  const polyline = svg.querySelector('polyline')
  assert(polyline, 'expected connector polyline for count > 1')
})

test('buildTurnFlowGlyph: single-dot spec has no connector polyline', () => {
  // deriveGlyphSpec now suppresses single-dot glyphs entirely (2026-07-18
  // hardened threshold), but the builder still has to handle a hand-crafted
  // single-dot spec correctly — otherwise a future caller that bypasses
  // deriveGlyphSpec would emit a malformed connector. Feed the spec
  // directly to lock the builder's behavior independent of derivation.
  const doc = makeDoc()
  const spec = { dots: [{ kind: 'llm', label: 'solo', index: 0 }], count: 1 }
  const svg = buildTurnFlowGlyph(doc, spec)
  assert.equal(svg.querySelectorAll('circle').length, 1)
  assert.equal(svg.querySelector('polyline'), null)
})

test('buildTurnFlowGlyph: aria-label + <title> reflect step count', () => {
  const doc = makeDoc()
  const spec = deriveGlyphSpec([
    { outputs: [{ type: 'assistant/message', data: { content: [] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'X' } }] },
  ])
  const svg = buildTurnFlowGlyph(doc, spec)
  assert.match(svg.attrs['aria-label'], /2 steps/)
  const title = svg.querySelector('title')
  assert.match(title.textContent, /2 steps/)
})

test('buildTurnFlowGlyph: click fires onOpen callback', () => {
  const doc = makeDoc()
  const spec = deriveGlyphSpec([
    { outputs: [{ type: 'assistant/message', data: { content: [] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'X' } }] },
  ])
  let fired = 0
  const svg = buildTurnFlowGlyph(doc, spec, { onOpen: () => { fired++ } })
  svg.dispatchEvent({ type: 'click' })
  assert.equal(fired, 1)
})

test('buildTurnFlowGlyph: default click dispatches dsh-open-turn-trace CustomEvent', () => {
  const doc = makeDoc()
  const spec = deriveGlyphSpec([
    { outputs: [{ type: 'assistant/message', data: { content: [] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'X' } }] },
  ])
  const svg = buildTurnFlowGlyph(doc, spec)
  let received = null
  svg.addEventListener('dsh-open-turn-trace', (e) => { received = e })
  svg.dispatchEvent({ type: 'click' })
  assert(received, 'expected dsh-open-turn-trace to bubble on click')
  assert.equal(received.type, 'dsh-open-turn-trace')
})

test('buildTurnFlowGlyph: keyboard Enter/Space also opens', () => {
  const doc = makeDoc()
  const spec = deriveGlyphSpec([
    { outputs: [{ type: 'assistant/message', data: { content: [] } }] },
    { outputs: [{ type: 'tool/call', data: { name: 'X' } }] },
  ])
  let fired = 0
  const svg = buildTurnFlowGlyph(doc, spec, { onOpen: () => { fired++ } })
  const preventable = () => { /* prevented */ }
  svg.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault: preventable })
  svg.dispatchEvent({ type: 'keydown', key: ' ', preventDefault: preventable })
  svg.dispatchEvent({ type: 'keydown', key: 'x', preventDefault: preventable })
  assert.equal(fired, 2)
})

test('buildTurnFlowGlyph: width is fixed at 120px regardless of step count (spec §7 — no row jitter)', () => {
  // Fixed frame: 1, 6, and 20 steps all render at the same width so the
  // footer row does not shift horizontally as new steps stream in during
  // a live turn.
  assert.equal(computeWidth(1), 120)
  assert.equal(computeWidth(6), 120)
  assert.equal(computeWidth(20), 120)
})

test('STEP_KIND_ORDER: exposed and matches trace-viz §4d palette order', () => {
  assert.deepEqual(STEP_KIND_ORDER, ['error', 'subagent', 'compact', 'tool', 'llm'])
})
