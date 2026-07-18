// Tests for the Mission Board empty-state builder.
//
// mission-board.js is a script-tag IIFE that renders DOM into a container.
// Its empty-state branch (QA round-3 §5.1) is the interesting bit right
// now: it must render title + hint + a ghost preview grid so a first-time
// user can see the shape their real todos will land in. We install a small
// document stub before requiring the module so buildEmptyState() runs.
//
// The stub mirrors just the surface the builder touches: createElement
// with an attribute setter (setAttribute), a textContent write-through,
// a mutable className, and appendChild that maintains an ordered child
// list. This keeps the test free of jsdom while still asserting real
// tree shape (nesting, class markers, per-column body text).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function mkEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    _children: [],
    _attrs: {},
    appendChild(child) { this._children.push(child); return child },
    append(...kids) { for (const k of kids) this._children.push(k) },
    setAttribute(k, v) { this._attrs[k] = String(v) },
  }
  return el
}

function installDocumentStub() {
  const g = globalThis
  g.document = { createElement: (t) => mkEl(t) }
}

function loadModule() {
  installDocumentStub()
  const p = require.resolve('../src/renderer/mission-board.js')
  delete require.cache[p]
  return require('../src/renderer/mission-board.js')
}

const { _internal } = loadModule()
const { buildEmptyState, PREVIEW_CARDS, COLUMNS } = _internal

// Walk the toy tree collecting nodes that satisfy `pred`. Keeps assertions
// resilient to intermediate wrapper divs.
function walk(node, out = []) {
  out.push(node)
  for (const c of node._children || []) walk(c, out)
  return out
}
function find(root, pred) {
  return walk(root).filter(pred)
}

// ---- shape -----------------------------------------------------------------

test('buildEmptyState: wrapper carries both mission-empty and mission-board-empty', () => {
  const root = buildEmptyState()
  const cls = root.className.split(/\s+/).filter(Boolean).sort()
  assert.deepEqual(cls, ['mission-board-empty', 'mission-empty'])
})

test('buildEmptyState: title and sub read as one coherent explainer', () => {
  const root = buildEmptyState()
  const title = find(root, (n) => n.className === 'mission-empty-title')[0]
  const sub   = find(root, (n) => n.className === 'mission-empty-sub')[0]
  assert.ok(title, 'title node exists')
  assert.ok(sub,   'sub node exists')
  assert.equal(title.textContent, 'No todos yet')
  assert.match(sub.textContent, /todo\/write/, 'names the event that populates the view')
  assert.match(sub.textContent, /three-column board/i, 'primes the reader for the preview shape')
})

// ---- ghost preview grid ----------------------------------------------------

test('buildEmptyState: preview grid renders one column per COLUMN key', () => {
  const root = buildEmptyState()
  const preview = find(root, (n) => n.className === 'mission-board-preview')[0]
  assert.ok(preview, 'preview container exists')
  assert.equal(preview._attrs['aria-hidden'], 'true',
    'preview must be hidden from AT — it is decorative, not real state')
  // fix/demo-labels: preview leads with a "preview" chip (demo-tier marker)
  // before the columns, so filter by column class instead of raw index.
  const cols = preview._children.filter((c) =>
    c.className.includes('mission-board-preview-column'))
  assert.equal(cols.length, COLUMNS.length)
  for (let i = 0; i < COLUMNS.length; i++) {
    const key = COLUMNS[i].key
    assert.ok(cols[i].className.includes(key), `column ${i} carries the ${key} marker`)
  }
})

test('buildEmptyState: each preview column shows label header + a placeholder card', () => {
  const root = buildEmptyState()
  const preview = find(root, (n) => n.className === 'mission-board-preview')[0]
  const cols = preview._children.filter((c) =>
    c.className.includes('mission-board-preview-column'))
  for (let i = 0; i < COLUMNS.length; i++) {
    const col = cols[i]
    const head = col._children.find((c) => c.className.includes('mission-board-preview-head'))
    const card = col._children.find((c) => c.className.includes('mission-board-preview-card'))
    assert.ok(head, `column ${i} has a header`)
    assert.ok(card, `column ${i} has a placeholder card`)
    assert.equal(head.textContent, COLUMNS[i].label)
    assert.equal(card.textContent, PREVIEW_CARDS[COLUMNS[i].key])
    assert.ok(card.className.includes(COLUMNS[i].key),
      'card carries the same status marker as the column for styling')
  }
})

test('buildEmptyState: preview leads with a demo-tier chip (fix/demo-labels P4)', () => {
  // The three PREVIEW_CARDS strings look like real todos at first read
  // ("Draft the release notes", etc.). A muted "preview" chip in front of
  // the columns keeps a fresh reader from mistaking them for actual data.
  const root = buildEmptyState()
  const preview = find(root, (n) => n.className === 'mission-board-preview')[0]
  const chip = preview._children.find((c) =>
    c.className.includes('mission-board-preview-chip'))
  assert.ok(chip, 'preview chip node exists')
  assert.equal(chip.textContent, 'preview')
  assert.ok(chip.className.includes('demo-tier-chip'),
    'chip inherits the shared demo-tier-chip token so page-level chips stay consistent')
})

test('buildEmptyState: preview cards do NOT reuse the live .mission-board-card class', () => {
  // Reverse pin: if the class ever regresses to the live-card class, the
  // real click affordance + solid border kicks in and the preview stops
  // reading as "not real data". Keep the ghost markup on its own class.
  const root = buildEmptyState()
  const liveCard = find(root, (n) =>
    n.className.split(/\s+/).includes('mission-board-card'))
  assert.equal(liveCard.length, 0,
    'ghost preview must not borrow the live-card class name')
})
