// Unit tests for reasoning-block — the first-class inline reasoning
// fold used inside the assistant-turn container (#162 rec 21).
// Covers the pure preview helpers + the DOM builder under a JSDOM
// document constructor (Node's built-in DOM shim via document
// polyfill would be heavy — we use a minimal fake instead).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  previewSuffix, sealedPreview,
  buildReasoningBlock, appendReasoningDelta, sealReasoningBlock, setReasoningCollapsed,
  DEFAULT_PREVIEW_CHARS, DEFAULT_SEALED_CAP,
} = require('../src/renderer/reasoning-block.js')

// Minimal DOM shim — enough of `document` + `Element` to exercise the
// builder without pulling in jsdom. The renderer under a browser sees
// the real DOM; tests exercise structure + text mutation, not styling.
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
      type: '',
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
      addEventListener(evt, fn) {
        this._listeners[evt] = this._listeners[evt] || []
        this._listeners[evt].push(fn)
      },
      fire(evt, arg) {
        for (const fn of this._listeners[evt] || []) fn(arg)
      },
    }
  }
  return { createElement: makeEl }
}

// -- pure helpers --------------------------------------------------------

test('previewSuffix: empty / non-string → empty', () => {
  assert.equal(previewSuffix(''), '')
  assert.equal(previewSuffix(null), '')
  assert.equal(previewSuffix(undefined), '')
})

test('previewSuffix: short buffer returned in full', () => {
  assert.equal(previewSuffix('hello world'), 'hello world')
})

test('previewSuffix: long buffer suffix with ellipsis', () => {
  const buf = 'a'.repeat(100)
  const p = previewSuffix(buf, 10)
  assert.equal(p, '…' + 'a'.repeat(10))
})

test('previewSuffix: collapses whitespace to single spaces', () => {
  const p = previewSuffix('one\n\ntwo   three')
  assert.equal(p, 'one two three')
})

test('previewSuffix: default N=40', () => {
  const long = 'x'.repeat(80)
  const p = previewSuffix(long)
  assert.equal(p.length, DEFAULT_PREVIEW_CHARS + 1) // + leading ellipsis
})

test('sealedPreview: empty → empty', () => {
  assert.equal(sealedPreview(''), '')
})

test('sealedPreview: single short sentence returned unchanged', () => {
  assert.equal(sealedPreview('Hello world.'), 'Hello world.')
})

test('sealedPreview: multiple sentences → first sentence only', () => {
  assert.equal(sealedPreview('First one. Second one. Third one.'), 'First one.')
})

test('sealedPreview: no punctuation → capped at N chars', () => {
  const raw = 'nopunctuation'.repeat(20)
  const p = sealedPreview(raw, 40)
  assert.ok(p.length <= 40, `expected ≤40, got ${p.length}: ${p}`)
  assert.ok(p.endsWith('…'), 'should end with ellipsis')
})

test('sealedPreview: long first sentence → truncated with ellipsis', () => {
  const s = 'This is one very long sentence that keeps going on and on and on without stopping until the end mark.'
  const p = sealedPreview(s, 40)
  assert.ok(p.length <= 40)
})

test('sealedPreview: question mark counts as sentence terminator', () => {
  assert.equal(sealedPreview('Is this working? Yes it is.'), 'Is this working?')
})

test('sealedPreview: bang mark counts as sentence terminator', () => {
  assert.equal(sealedPreview('Wow! Amazing.'), 'Wow!')
})

test('sealedPreview: default cap = 80', () => {
  const long = 'x'.repeat(200)
  const p = sealedPreview(long)
  assert.ok(p.length <= DEFAULT_SEALED_CAP, `default cap ${DEFAULT_SEALED_CAP}, got ${p.length}`)
})

// -- DOM builder ---------------------------------------------------------

test('buildReasoningBlock: default (collapsed, unsealed) shape', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 3, initialText: 'thinking about it' })
  assert.equal(el.className, 'turn-child reasoning-block')
  assert.equal(el.dataset.blockIndex, '3')
  assert.equal(el.dataset.sealed, '0')
  assert.equal(el.dataset.collapsed, '1')
  // C15 (drift cycle 13/14): body.textContent is the buffer of record;
  // dataset.buffer was retired to fix O(N²) growth on long reasoning streams.
  const row = el._children[0]
  assert.equal(row.className, 'reasoning-row')
  assert.equal(row.type, 'button')
  const label = el.querySelector('.reasoning-label')
  assert.equal(label.textContent, 'thinking')
  const preview = el.querySelector('.reasoning-preview')
  assert.equal(preview.textContent, 'thinking about it')
  const body = el.querySelector('.reasoning-body')
  assert.equal(body.textContent, 'thinking about it')
  assert.equal(body.hidden, true)
})

test('buildReasoningBlock: open (collapsed:false) reveals body', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 0, initialText: 'hi', collapsed: false })
  const body = el.querySelector('.reasoning-body')
  assert.equal(body.hidden, false)
  assert.equal(el.dataset.collapsed, '0')
})

test('buildReasoningBlock: sealed=true uses sentence preview', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, {
    index: 1,
    initialText: 'Read the file first. Then edit.',
    sealed: true,
  })
  assert.equal(el.dataset.sealed, '1')
  assert.equal(el.querySelector('.reasoning-preview').textContent, 'Read the file first.')
})

test('appendReasoningDelta: mutates buffer/preview/body', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 0, initialText: 'abc' })
  appendReasoningDelta(el, 'def')
  // C15 (drift cycle 13/14): body.textContent is the single source of
  // truth; preview mirrors it. Concatenation happens via appendChild,
  // not string reallocation (O(N) instead of O(N²)).
  assert.equal(el.querySelector('.reasoning-body').textContent, 'abcdef')
  assert.equal(el.querySelector('.reasoning-preview').textContent, 'abcdef')
})

test('appendReasoningDelta: no-op on empty text or missing el', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 0, initialText: 'abc' })
  appendReasoningDelta(el, '')
  assert.equal(el.querySelector('.reasoning-body').textContent, 'abc')
  // No throw when el is null.
  assert.doesNotThrow(() => appendReasoningDelta(null, 'x'))
})

test('sealReasoningBlock: flips sealed flag and re-derives preview', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, {
    index: 0,
    initialText: 'One sentence. Two sentence.',
  })
  assert.equal(el.dataset.sealed, '0')
  sealReasoningBlock(el)
  assert.equal(el.dataset.sealed, '1')
  assert.equal(el.querySelector('.reasoning-preview').textContent, 'One sentence.')
})

test('setReasoningCollapsed: toggles dataset and body.hidden', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 0, initialText: 'x' })
  assert.equal(el.dataset.collapsed, '1')
  setReasoningCollapsed(el, false)
  assert.equal(el.dataset.collapsed, '0')
  assert.equal(el.querySelector('.reasoning-body').hidden, false)
  setReasoningCollapsed(el, true)
  assert.equal(el.dataset.collapsed, '1')
  assert.equal(el.querySelector('.reasoning-body').hidden, true)
})

test('row click toggles collapse and fires onToggle callback', () => {
  const doc = makeDoc()
  const events = []
  const el = buildReasoningBlock(doc, {
    index: 4,
    initialText: 'buffered',
    onToggle: (arg) => events.push(arg),
  })
  const row = el._children[0]
  row.fire('click')
  assert.equal(el.dataset.collapsed, '0')
  assert.deepEqual(events, [{ index: 4, collapsed: false }])
  row.fire('click')
  assert.equal(el.dataset.collapsed, '1')
  assert.deepEqual(events, [
    { index: 4, collapsed: false },
    { index: 4, collapsed: true },
  ])
})

test('block is emoji-free (density-layering §2 rule)', () => {
  const doc = makeDoc()
  const el = buildReasoningBlock(doc, { index: 0, initialText: 'x' })
  // Walk children collecting textContent — no emoji, only typographic
  // marks (▸ ✓ ✗ · —) are allowed.
  function collect(node, out) {
    if (typeof node.textContent === 'string' && (!node._children || node._children.length === 0)) {
      out.push(node.textContent)
    }
    for (const c of node._children || []) collect(c, out)
  }
  const strings = []
  collect(el, strings)
  const joined = strings.join(' ')
  // Emoji block detector: extended pictographic ranges.
  const emoji = joined.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)
  assert.equal(emoji, null, `unexpected emoji: ${JSON.stringify(emoji)}`)
})
