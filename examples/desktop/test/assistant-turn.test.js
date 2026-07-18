// Unit tests for assistant-turn.js — the TurnBuilder that owns the
// pi-style assistant-turn container (#162 rec 22-bis). Covers structure
// (six readability rules), streaming API (open/append/seal for reasoning,
// text, tool row + result row), and finishTurn footer + trace drawer.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  TurnBuilder,
  _previewToolArgs,
  _formatDuration,
  REASONING, TEXT, TOOL_ROW, TOOL_RESULT_ROW,
} = require('../src/renderer/assistant-turn.js')

// -- DOM shim (same pattern as reasoning-block.test.js) ---------------------

function makeDoc() {
  function makeEl(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      className: '',
      textContent: '',
      dataset: {},
      hidden: false,
      _children: [],
      _listeners: {},
      _attrs: {},
      type: '',
      setAttribute(k, v) { this._attrs[k] = v },
      appendChild(child) { this._children.push(child); return child },
      append(...kids) { for (const k of kids) this._children.push(k); return this },
      querySelector(sel) {
        const cls = sel.replace(/^\./, '')
        function walk(node) {
          if (!node || !Array.isArray(node._children)) return null
          for (const c of node._children) {
            if (c && typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) return c
            const inner = walk(c)
            if (inner) return inner
          }
          return null
        }
        return walk(this)
      },
      querySelectorAll(sel) {
        const cls = sel.replace(/^\./, '')
        const out = []
        function walk(node) {
          if (!node || !Array.isArray(node._children)) return
          for (const c of node._children) {
            if (c && typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) out.push(c)
            walk(c)
          }
        }
        walk(this)
        return out
      },
      addEventListener(evt, fn) {
        this._listeners[evt] = this._listeners[evt] || []
        this._listeners[evt].push(fn)
      },
    }
  }
  return { createElement: makeEl }
}

// -- constructor + shape ----------------------------------------------------

test('constructor: builds a <section.assistant-turn> with turn-rule + turn-body', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, { turnId: 't1', sessionId: 's1', index: 3 })
  const el = b.element()
  assert.equal(el.tagName, 'SECTION')
  assert.equal(el.className, 'assistant-turn')
  assert.equal(el.dataset.turnId, 't1')
  assert.equal(el.dataset.turnIndex, '3')
  assert.equal(el.dataset.sessionId, 's1')
  assert.equal(el.dataset.turnStatus, 'streaming')
  assert.equal(el._children.length, 2)
  assert.equal(el._children[0].className, 'turn-rule')
  assert.equal(el._children[1].className, 'turn-body')
})

test('constructor: throws on missing doc', () => {
  assert.throws(() => new TurnBuilder(null, {}), /needs a document/)
})

// -- reasoning path ---------------------------------------------------------

test('openReasoning: appends a .turn-child.reasoning-block child; returns { index }', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const r = b.openReasoning({ initialText: 'wait…' })
  assert.equal(r.index, 0)
  const body = b.element()._children[1]
  assert.equal(body._children.length, 1)
  const child = body._children[0]
  // Fallback shim shape (no window.__dshReasoningBlock in node --test).
  assert.match(child.className, /turn-child/)
  assert.match(child.className, /reasoning-block/)
  assert.equal(child.dataset.buffer, 'wait…')
  assert.equal(child.dataset.sealed, '0')
  assert.equal(child.dataset.collapsed, '1')
})

test('appendReasoningDelta: appends to the tracked buffer', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const { index } = b.openReasoning({ initialText: '' })
  b.appendReasoningDelta({ index, text: 'foo ' })
  b.appendReasoningDelta({ index, text: 'bar' })
  const child = b.element()._children[1]._children[0]
  assert.equal(child.dataset.buffer, 'foo bar')
})

test('sealReasoning: sets sealed=1 (via fallback shim)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const { index } = b.openReasoning({ initialText: 'x' })
  b.sealReasoning({ index })
  const child = b.element()._children[1]._children[0]
  assert.equal(child.dataset.sealed, '1')
})

test('reasoning: multiple opens get distinct indices (0,1,2)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  assert.equal(b.openReasoning({}).index, 0)
  assert.equal(b.openReasoning({}).index, 1)
  assert.equal(b.openReasoning({}).index, 2)
  const body = b.element()._children[1]
  assert.equal(body._children.length, 3)
})

// -- text path -------------------------------------------------------------

test('openText: appends .turn-child.text-block; initial text lands in body', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const t = b.openText({ initialText: 'hi' })
  assert.equal(t.index, 0)
  const child = b.element()._children[1]._children[0]
  assert.equal(child.className, 'turn-child text-block')
  assert.equal(child.textContent, 'hi')
  assert.equal(child.dataset.buffer, 'hi')
})

test('appendTextDelta: mutates textContent + buffer in place', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const { index } = b.openText({ initialText: 'Hel' })
  b.appendTextDelta({ index, text: 'lo,' })
  b.appendTextDelta({ index, text: ' world' })
  const child = b.element()._children[1]._children[0]
  assert.equal(child.textContent, 'Hello, world')
  assert.equal(child.dataset.buffer, 'Hello, world')
})

test('sealText: finalText overwrites buffer + textContent', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const { index } = b.openText({ initialText: 'partial' })
  b.sealText({ index, finalText: 'final answer.' })
  const child = b.element()._children[1]._children[0]
  assert.equal(child.textContent, 'final answer.')
  assert.equal(child.dataset.sealed, '1')
})

test('appendTextDelta: no-op for unknown index or empty delta', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const { index } = b.openText({ initialText: 'a' })
  b.appendTextDelta({ index: 999, text: 'x' })
  b.appendTextDelta({ index, text: '' })
  const child = b.element()._children[1]._children[0]
  assert.equal(child.textContent, 'a')
})

// -- tool row + result path -----------------------------------------------

test('openToolRow: appends single-line row with glyph ▸, name, args preview', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const r = b.openToolRow({ callId: 'c1', name: 'write_file', argumentsDelta: '{"path":' })
  assert.equal(r.callId, 'c1')
  const row = b.element()._children[1]._children[0]
  assert.equal(row.className, 'turn-child tool-row')
  assert.equal(row.dataset.callId, 'c1')
  assert.equal(row.dataset.toolName, 'write_file')
  assert.equal(row.dataset.sealed, '0')
  // glyph, name, args children (in that order)
  assert.equal(row._children.length, 3)
  assert.match(row._children[0].className, /turn-glyph/)
  assert.equal(row._children[0].textContent, '▸')
  assert.equal(row._children[1].textContent, 'write_file')
  assert.match(row._children[2].className, /tool-row-args/)
})

test('openToolRow: idempotent for same callId (no duplicate row)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 'read_file' })
  b.openToolRow({ callId: 'c1', name: 'read_file' })
  assert.equal(b.element()._children[1]._children.length, 1)
})

test('updateToolRow: appends argumentsDelta and updates the args preview', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 'write_file', argumentsDelta: '{"path":"' })
  b.updateToolRow({ callId: 'c1', argumentsDelta: 'src/foo.ts' })
  b.updateToolRow({ callId: 'c1', argumentsDelta: '"}' })
  const row = b.element()._children[1]._children[0]
  assert.equal(row.dataset.buffer, '{"path":"src/foo.ts"}')
  const args = row._children[2]
  assert.match(args.textContent, /src\/foo\.ts/)
})

test('sealToolRow: swaps glyph to ✓ and stamps sealed=1', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 'run_bash', argumentsDelta: '{"cmd":"ls"' })
  b.sealToolRow({ callId: 'c1', argumentsSealed: '{"cmd":"ls -la"}' })
  const row = b.element()._children[1]._children[0]
  assert.equal(row.dataset.sealed, '1')
  assert.equal(row.dataset.buffer, '{"cmd":"ls -la"}')
  assert.equal(row._children[0].textContent, '✓')
})

test('openToolResultRow: appends adjacent .tool-result-row with ✓ / summary / duration', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 'run_bash', argumentsSealed: '{}' })
  b.openToolResultRow({ callId: 'c1', ok: true, summary: '0 · 42 lines', durationMs: 245 })
  const body = b.element()._children[1]
  // R3: result immediately follows the call (no interleaving in this fixture).
  assert.equal(body._children.length, 2)
  const result = body._children[1]
  assert.equal(result.className, 'turn-child tool-result-row')
  assert.equal(result.dataset.callId, 'c1')
  assert.equal(result._children[0].textContent, '✓')
  assert.equal(result._children[1].textContent, '0 · 42 lines')
  assert.equal(result._children[2].textContent, '245ms')
})

test('openToolResultRow: ok=false renders ✗ glyph and data-error=1', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 'run_bash', argumentsSealed: '{}' })
  b.openToolResultRow({ callId: 'c1', ok: false, summary: 'exit 1', durationMs: 12000 })
  const result = b.element()._children[1]._children[1]
  assert.equal(result.dataset.error, '1')
  assert.equal(result._children[0].textContent, '✗')
  assert.equal(result._children[2].textContent, '12.0s')
})

test('openToolResultRow: unknown callId is silently ignored (no crash, no orphan row)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolResultRow({ callId: 'nope', ok: true, summary: 'x' })
  assert.equal(b.element()._children[1]._children.length, 0)
})

// -- finishTurn --------------------------------------------------------------

test('finishTurn: seals the turn, sets data-turn-status=sealed, appends <footer.turn-footer>', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openText({ initialText: 'ok' })
  b.finishTurn({ footerSpec: { model: 'deepseek', tokens: '↑1k ↓500', cost: '$0.0100', time: '1.2s', stop: 'stop' } })
  assert.equal(b.isSealed(), true)
  const el = b.element()
  assert.equal(el.dataset.turnStatus, 'sealed')
  const footer = el._children[el._children.length - 1]
  assert.equal(footer.tagName, 'FOOTER')
  assert.equal(footer.className, 'turn-footer')
  // §9 fused-pill shape: 4 fields + 3 separators = 7 children (tokens+cost
  // legacy args fold into a single `usage` chip valued `<tokens> / <cost>`).
  assert.equal(footer._children.length, 7)
  assert.equal(footer._children[2].textContent, '↑1k ↓500 / $0.0100')
})

test('finishTurn: absent footer spec fields are suppressed (no `— · ` fragments)', () => {
  // 2026-07-18 echo-profile fix: chips whose formatted value is a bare
  // ABSENT sentinel are dropped, with their surrounding separator.
  // Result on a model-only spec: one chip, zero separators.
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.finishTurn({ footerSpec: { model: 'deepseek-chat' } })
  const el = b.element()
  const footer = el._children[el._children.length - 1]
  // Exactly one chip, no separators.
  assert.equal(footer._children.length, 1, `expected 1 footer child, got ${footer._children.length}`)
  assert.equal(footer._children[0].textContent, 'deepseek-chat')
  // Regression fence: no em-dash placeholders anywhere.
  const allText = footer._children.map(c => c.textContent).join(' | ')
  assert.ok(!allText.includes('—'), `no `+'`—`'+` sentinels allowed on the L0 footer row: ${allText}`)
  assert.ok(!allText.includes('$?'), `no `+'`$?`'+` on the L0 footer row: ${allText}`)
})

test('finishTurn: traceDrawerEl is wrapped in <details.turn-trace-drawer>', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  const traceEl = doc.createElement('div')
  traceEl.className = 'trace-card'
  b.finishTurn({ footerSpec: { model: 'm' }, traceDrawerEl: traceEl, traceSummaryText: 'trace · 12 events' })
  const footer = b.element()._children[b.element()._children.length - 1]
  const drawer = footer.querySelector('.turn-trace-drawer')
  assert.ok(drawer, 'drawer must exist')
  assert.equal(drawer.tagName, 'DETAILS')
  // summary + inner traceEl
  assert.equal(drawer._children.length, 2)
  assert.equal(drawer._children[0].textContent, 'trace · 12 events')
  assert.equal(drawer._children[1], traceEl)
})

test('finishTurn: subsequent open* calls throw (turn is sealed)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.finishTurn({ footerSpec: {} })
  assert.throws(() => b.openReasoning({}), /sealed/)
  assert.throws(() => b.openText({}), /sealed/)
  assert.throws(() => b.openToolRow({ callId: 'x' }), /sealed/)
})

test('finishTurn: idempotent — calling twice does not re-append footer', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.finishTurn({ footerSpec: {} })
  const countAfterFirst = b.element()._children.length
  b.finishTurn({ footerSpec: {} })
  assert.equal(b.element()._children.length, countAfterFirst)
})

// -- pi §2.3-bis readability invariants ------------------------------------

test('R5 (narration cadence): reasoning + text + tool-row order preserved as opened', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openReasoning({ initialText: 'thought 1' })
  b.openText({ initialText: 'saying 1' })
  b.openToolRow({ callId: 'c1', name: 'write_file', argumentsSealed: '{}' })
  b.openToolResultRow({ callId: 'c1', ok: true, summary: 'wrote' })
  b.openText({ initialText: 'saying 2' })
  b.openReasoning({ initialText: 'thought 2' })
  const kinds = b.element()._children[1]._children.map(c => c.className.split(/\s+/)[1])
  assert.deepEqual(kinds, [
    'reasoning-block',
    'text-block',
    'tool-row',
    'tool-result-row',
    'text-block',
    'reasoning-block',
  ])
})

test('R2 (fixed glyph column): every child row exposes a .turn-glyph child at position 0', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openToolRow({ callId: 'c1', name: 't' })
  b.openToolResultRow({ callId: 'c1', ok: true, summary: '' })
  for (const child of b.element()._children[1]._children) {
    // reasoning fallback shim has no glyph child; the row types do. This
    // invariant is what CSS relies on — assert on tool rows.
    if (/tool-row|tool-result-row/.test(child.className)) {
      assert.match(child._children[0].className, /turn-glyph/, `${child.className} first child must be .turn-glyph`)
    }
  }
})

// -- exported constants ----------------------------------------------------

test('exported child-kind labels match the DOM class conventions', () => {
  assert.equal(REASONING, 'reasoning-block')
  assert.equal(TEXT, 'text-block')
  assert.equal(TOOL_ROW, 'tool-row')
  assert.equal(TOOL_RESULT_ROW, 'tool-result-row')
})

// -- pure helpers ----------------------------------------------------------

test('_previewToolArgs: empty → (…)', () => {
  assert.equal(_previewToolArgs(''), '(…)')
  assert.equal(_previewToolArgs(null), '(…)')
})

test('_previewToolArgs: short buffer wrapped in parens', () => {
  assert.equal(_previewToolArgs('{"path":"foo.ts"}'), '({"path":"foo.ts"})')
})

test('_previewToolArgs: long buffer trimmed at 60 chars with ellipsis', () => {
  const long = '{"path":"' + 'a'.repeat(200) + '"}'
  const out = _previewToolArgs(long)
  assert.ok(out.length <= 62) // parens + 60 chars max
  assert.match(out, /…\)$/)
})

test('_formatDuration: sub-second → "Nms"; second+ → "N.Ns"; invalid → ""', () => {
  assert.equal(_formatDuration(245), '245ms')
  assert.equal(_formatDuration(999), '999ms')
  assert.equal(_formatDuration(1000), '1.0s')
  assert.equal(_formatDuration(12345), '12.3s')
  assert.equal(_formatDuration(-1), '')
  assert.equal(_formatDuration(NaN), '')
  assert.equal(_formatDuration('x'), '')
})

// -- no-emoji guard --------------------------------------------------------

test('no emoji sneaks into turn container or footer text (glyph carve-out ✓✗▸)', () => {
  const doc = makeDoc()
  const b = new TurnBuilder(doc, {})
  b.openReasoning({ initialText: 'r' })
  b.openText({ initialText: 't' })
  b.openToolRow({ callId: 'c', name: 'n', argumentsSealed: '{}' })
  b.openToolResultRow({ callId: 'c', ok: false, summary: 's', durationMs: 100 })
  b.finishTurn({ footerSpec: { model: 'm', tokens: 't', cost: 'c', time: 't', stop: 's' } })
  // Ban list per team-lead 2026-07-17 UI ruling: ⚙🔌📎👤🔒 and any
  // U+1F300–U+1FAFF (pictographs). Typographic symbols ✓ ✗ ▸ ▾ ↑ ↓ · —
  // are the allow-list carve-out. So the guard is a *pictograph* range
  // check, not the broader U+2600–U+27BF miscellaneous block.
  const PICTO = /[\u{1F300}-\u{1FAFF}]/gu
  const BANNED = /[⚙🔌📎👤🔒]/gu
  function walk(node, seen) {
    if (!node) return
    if (typeof node.textContent === 'string') {
      if (node.textContent.match(PICTO) || node.textContent.match(BANNED)) {
        seen.push(node.textContent)
      }
    }
    for (const c of node._children || []) walk(c, seen)
  }
  const flagged = []
  walk(b.element(), flagged)
  assert.deepEqual(flagged, [], `emoji found: ${JSON.stringify(flagged)}`)
})
