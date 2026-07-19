// Lock the lane-artifact-v2 additions (2026-07-19): version-evolution
// chain + Board/Timeline views + panel tab bar. Complements the existing
// artifact-compact-row.test.js which locks the L0 row shape.
//
// Three surfaces:
//   (a) src/renderer/artifacts-board.js — Board/Timeline/Evolution
//       renderers + kind-bucket + diffLines. Testable directly via
//       CommonJS export.
//   (b) src/renderer/artifacts.js       — history tracking, panel
//       building, view switcher. Only source-string assertions here
//       (the module is an IIFE that touches window at load).
//   (c) src/renderer/style.css          — panel + tab + tile + evolution
//       + timeline styling.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const artifactsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts.js'), 'utf8')
const styleCss = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8')

// Load artifacts-board.js as a real module — it emits a CommonJS export
// alongside the window.__dshArtifactsBoard shim (mirrors tool-cards.js).
const board = require(path.join(ROOT, 'src/renderer/artifacts-board.js'))

// -- (a) artifacts-board.js module surface --------------------------------

test('artifacts-board: exports the seven-piece API', () => {
  for (const key of ['KINDS', 'bucketOf', 'groupByKind', 'renderBoard',
                     'renderTimeline', 'renderEvolution', 'diffLines']) {
    assert.ok(board[key], `missing export: ${key}`)
  }
})

test('artifacts-board: bucketOf normalizes freeform kinds to six buckets', () => {
  assert.equal(board.bucketOf('md'), 'md')
  assert.equal(board.bucketOf('markdown'), 'md')
  assert.equal(board.bucketOf('html'), 'html')
  assert.equal(board.bucketOf('htm'), 'html')
  assert.equal(board.bucketOf('svg'), 'svg')
  assert.equal(board.bucketOf('json'), 'json')
  assert.equal(board.bucketOf('py'), 'code')
  assert.equal(board.bucketOf('sh'), 'code')
  assert.equal(board.bucketOf('bin'), 'other')
  assert.equal(board.bucketOf(''), 'other')
  assert.equal(board.bucketOf(null), 'other')
})

test('artifacts-board: groupByKind drops empty buckets so headers do not render blank', () => {
  const groups = board.groupByKind([
    { artifactId: 'a.md', kind: 'md', version: 1 },
    { artifactId: 'b.html', kind: 'html', version: 1 },
  ])
  assert.ok(groups.has('md'))
  assert.ok(groups.has('html'))
  assert.ok(!groups.has('svg'), 'empty buckets must be dropped')
  assert.ok(!groups.has('json'))
  assert.ok(!groups.has('code'))
  assert.ok(!groups.has('other'))
})

test('artifacts-board: diffLines emits ordered add / del / ctx lines', () => {
  const prev = 'a\nb\nc'
  const next = 'a\nx\nc'
  const lines = board.diffLines(prev, next)
  // Must preserve first line as context, then produce a del+add for b→x,
  // then keep last line as context.
  assert.deepEqual(
    lines.map((l) => `${l.kind}:${l.text}`),
    ['ctx:a', 'del:b', 'add:x', 'ctx:c'],
  )
})

test('artifacts-board: diffLines handles pure insertion / pure deletion', () => {
  // Note: '' splits to [''] (one empty line), so an empty→two-line
  // transition is one del (empty) plus two adds, not two bare adds.
  // That's the honest LCS answer — the fixture never diffs empty
  // blobs in real usage, but the shape matters for regressions.
  const ins = board.diffLines('', 'a\nb')
  assert.deepEqual(ins.map((l) => l.kind), ['del', 'add', 'add'])
  const del = board.diffLines('a\nb', '')
  assert.deepEqual(del.map((l) => l.kind), ['del', 'del', 'add'])
})

// -- (a2) artifacts-board.js: DOM-shape asserts ---------------------------
//
// Board / Timeline / Evolution renderers return DOM nodes, so we run
// them against a minimal DOM stub (same idea as renderer-harness.js).
// Kept inline + tiny so the test file stays hermetic.

function makeDom() {
  // Bare-bones stub matching what the renderers touch: createElement,
  // append(), appendChild, dataset, className, textContent, innerHTML,
  // setAttribute, addEventListener, querySelector, querySelectorAll,
  // classList (used only via className strings here), title.
  const install = (tag, extra = {}) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      className: '',
      textContent: '',
      innerHTML: '',
      title: '',
      hidden: false,
      _attrs: {},
      _listeners: {},
      style: {},
      classList: {
        _s: new Set(),
        add(...n) { for (const x of n) this._s.add(x) },
        remove(...n) { for (const x of n) this._s.delete(x) },
        contains(x) { return this._s.has(x) },
      },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child },
      append(...cs) { for (const c of cs) this.appendChild(c) },
      setAttribute(k, v) { this._attrs[k] = String(v) },
      getAttribute(k) { return this._attrs[k] },
      addEventListener(name, fn) {
        (this._listeners[name] = this._listeners[name] || []).push(fn)
      },
      dispatchEvent(name) {
        for (const fn of (this._listeners[name] || [])) {
          fn({ preventDefault() {}, stopPropagation() {} })
        }
      },
      querySelector(sel) { return findFirst(this, sel) },
      querySelectorAll(sel) { return findAll(this, sel) },
      ...extra,
    }
    return el
  }
  function selMatch(el, sel) {
    if (sel.startsWith('.')) return el.className && el.className.split(/\s+/).includes(sel.slice(1))
    if (sel.startsWith('[')) {
      // Only used in this test for `[data-artifact-id="..."]` shape,
      // which isn't hit by these assertions. Return false safely.
      return false
    }
    return el.tagName === sel.toUpperCase()
  }
  function findFirst(root, sel) {
    for (const c of (root.children || [])) {
      if (selMatch(c, sel)) return c
      const nested = findFirst(c, sel)
      if (nested) return nested
    }
    return null
  }
  function findAll(root, sel) {
    const out = []
    const walk = (n) => {
      for (const c of (n.children || [])) {
        if (selMatch(c, sel)) out.push(c)
        walk(c)
      }
    }
    walk(root)
    return out
  }
  global.document = { createElement: (tag) => install(tag) }
  return install
}

test('artifacts-board.renderBoard: one group per kind, tile count matches bucket size', () => {
  makeDom()
  const entries = [
    { artifactId: 'a.md', kind: 'md', version: 3, blob: '# hi' },
    { artifactId: 'b.md', kind: 'md', version: 1, blob: 'hi' },
    { artifactId: 'c.html', kind: 'html', version: 2, blob: '<p>x</p>' },
  ]
  const el = board.renderBoard(entries, { openArtifact: () => {} })
  assert.equal(el.className, 'artifact-board')
  const groups = el.querySelectorAll('.artifact-board-group')
  assert.equal(groups.length, 2, 'md + html only — svg/json/code/other are empty and must be dropped')
  const mdGroup = groups.find ? groups.find((g) => g.dataset.kind === 'md') : groups[0]
  const mdTiles = mdGroup.querySelectorAll('.artifact-tile')
  assert.equal(mdTiles.length, 2, 'both md entries live under the md group')
  // Kind badge on the tile mirrors the bucket so CSS can theme per-kind.
  for (const tile of mdTiles) assert.equal(tile.dataset.kind, 'md')
})

test('artifacts-board.renderTimeline: newest-first ordering across all versions', () => {
  makeDom()
  const entries = [
    { artifactId: 'a.md', kind: 'md', version: 2, seenAt: 100 },
  ]
  const history = new Map([
    ['a.md', [
      { artifactId: 'a.md', version: 1, kind: 'md', seenAt: 50 },
      { artifactId: 'a.md', version: 2, kind: 'md', seenAt: 100 },
    ]],
  ])
  const el = board.renderTimeline(entries, { history, openArtifact: () => {} })
  const rows = el.querySelectorAll('.artifact-timeline-row')
  assert.equal(rows.length, 2, 'both history versions must appear as rows')
  assert.equal(rows[0].dataset.version, '2', 'newest version appears first')
  assert.equal(rows[1].dataset.version, '1')
})

test('artifacts-board.renderEvolution: N versions → N-1 diff panes + honest fallback', () => {
  makeDom()
  const entry = { artifactId: 'a.md', kind: 'md', version: 3 }
  // Chain with two hops. First hop has both blobs (real diff); second
  // hop has one missing (fallback note path).
  const history = [
    { version: 1, seenAt: 100, kind: 'md', blob: 'a\nb' },
    { version: 2, seenAt: 200, kind: 'md', blob: 'a\nB' },
    { version: 3, seenAt: 300, kind: 'md' /* no blob */ },
  ]
  const el = board.renderEvolution(entry, history)
  const steps = el.querySelectorAll('.artifact-evolution-step')
  assert.equal(steps.length, 3, 'one step per version')
  const diffs = el.querySelectorAll('.artifact-evolution-diff')
  assert.equal(diffs.length, 2, 'N-1 diff panes for a chain of N versions')
  // The first diff pane has real content; the second (v2 has blob, v3
  // does not) must fall back to the not-preserved note.
  const notes = el.querySelectorAll('.artifact-evolution-diff-note')
  assert.equal(notes.length, 1, 'exactly one hop falls back to the honest note')
})

test('artifacts-board.renderEvolution: chain summary reads v1 → v2 → v3', () => {
  makeDom()
  const entry = { artifactId: 'a.md', kind: 'md', version: 3 }
  const history = [
    { version: 1, seenAt: 1 },
    { version: 2, seenAt: 2 },
    { version: 3, seenAt: 3 },
  ]
  const el = board.renderEvolution(entry, history)
  const sum = el.querySelector('.artifact-evolution-summary')
  assert.ok(sum, 'summary line must render')
  assert.equal(sum.textContent, 'v1 → v2 → v3',
    'chain summary must list every version in order')
})

// -- (b) artifacts.js source-string locks ---------------------------------

test('artifacts.js: builds an .artifact-panel with a role="tablist" tab bar', () => {
  assert.match(
    artifactsSrc,
    /panel\.className\s*=\s*['"]artifact-panel['"]/,
    'panel container must exist so the tab bar has a scope',
  )
  assert.match(
    artifactsSrc,
    /tabBar\.setAttribute\(['"]role['"],\s*['"]tablist['"]\)/,
    'tab-bar container must carry role="tablist" for a11y',
  )
  assert.match(
    artifactsSrc,
    /['"]list['"],\s*['"]board['"],\s*['"]timeline['"]/,
    'exactly three tabs must exist in the exact order List / Board / Timeline',
  )
})

test('artifacts.js: version chip is a <button> that toggles the evolution strip', () => {
  // The chip changed from <span> to <button> so the click hit-target is
  // an accessible control, not a bare span. Static text lock — if a
  // future edit drops the button back to a span the a11y regresses.
  assert.match(
    artifactsSrc,
    /createElement\(['"]button['"]\)[\s\S]{0,300}verEl\.className\s*=\s*['"]artifact-version['"]/,
    'artifact-version chip must be built as a <button>',
  )
  assert.match(
    artifactsSrc,
    /toggleEvolution\(el,\s*entry\)/,
    'chip click handler must call toggleEvolution(el, entry)',
  )
})

test('artifacts.js: history map tracks per-version records (session-scoped)', () => {
  // fix/code-bugs-batch P1-4: history is bucketed per sessionId to prevent
  // A→B→A version bleed, but the shape it exposes to callers stays
  // Map-like. Assert the bucket structure + the recordHistory helper.
  assert.match(
    artifactsSrc,
    /const\s+bySession\s*=\s*new\s+Map\(\)/,
    'session-bucketed history map must exist to isolate versions across sessions',
  )
  assert.match(
    artifactsSrc,
    /history:\s*new\s+Map\(\)/,
    'each session bucket must own a fresh history Map for its artifacts',
  )
  assert.match(
    artifactsSrc,
    /function\s+recordHistory\(entry\)/,
    'recordHistory must exist and fire per event',
  )
})

test('artifacts.js: switchView flips the panel dataset + aria-selected', () => {
  assert.match(
    artifactsSrc,
    /function\s+switchView\(v\)/,
    'switchView helper must exist',
  )
  assert.match(
    artifactsSrc,
    /panelEl\.dataset\.view\s*=\s*v/,
    'view state must be reflected on the current bucket panel dataset.view for CSS + QA',
  )
  assert.match(
    artifactsSrc,
    /setAttribute\(['"]aria-selected['"],\s*tab\.dataset\.view\s*===\s*v/,
    'aria-selected must flip on tab per current view',
  )
})

test('artifacts.js: __dshArtifacts surface exposes history + switchView', () => {
  assert.match(
    artifactsSrc,
    /window\.__dshArtifacts\s*=\s*\{[\s\S]*?history[\s\S]*?switchView[\s\S]*?\}/,
    'debug seam must include history + switchView so QA / drivers can inspect state',
  )
})

// -- (c) style.css static locks -------------------------------------------

function findRule(css, selector) {
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  const brace = css.indexOf('{', idx)
  const close = css.indexOf('}', brace)
  if (brace < 0 || close < 0) return null
  return css.slice(brace + 1, close)
}

test('style.css: .artifact-panel is a bordered container that wraps the group', () => {
  const body = findRule(styleCss, '.artifact-panel {')
  assert.ok(body, '.artifact-panel rule must exist')
  assert.match(body, /border:\s*1px solid var\(--border\)/, 'panel must render one shared border')
  assert.match(body, /border-radius:\s*8px/, 'panel radius mirrors the card-family radius')
})

test('style.css: .artifact-panel-tabs sit above the body with their own separator', () => {
  const body = findRule(styleCss, '.artifact-panel-tabs {')
  assert.ok(body, '.artifact-panel-tabs rule must exist')
  assert.match(body, /border-bottom:\s*1px solid var\(--border\)/,
    'tab bar must sit on a separator so it reads as chrome, not part of the body')
})

test('style.css: aria-selected tab reads darker than its neighbours', () => {
  // Presence check for the selected-state rule — the visual weight is
  // the whole point of a tab bar, so drift here is a UX regression.
  assert.match(
    styleCss,
    /\.artifact-panel-tab\[aria-selected="true"\]/,
    'selected tab must have a dedicated rule so its visual weight is stable',
  )
})

test('style.css: .artifact-tile is a click-target with hover promotion', () => {
  const body = findRule(styleCss, '.artifact-tile {')
  assert.ok(body, '.artifact-tile rule must exist')
  assert.match(body, /cursor:\s*pointer/, 'tile is a click target')
  const hover = findRule(styleCss, '.artifact-tile:hover {')
  assert.ok(hover, '.artifact-tile:hover rule must exist')
  assert.match(hover, /border-color:\s*var\(--accent\)/,
    'tile hover must promote the border to accent so the click affordance is visible')
})

test('style.css: .artifact-board-grid is a responsive minmax grid', () => {
  const body = findRule(styleCss, '.artifact-board-grid {')
  assert.ok(body, '.artifact-board-grid rule must exist')
  assert.match(body, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(\d+px/,
    'board grid must be a responsive minmax layout so tiles reflow on narrow panels')
})

test('style.css: .artifact-evolution has a subdued background so it reads as an aside', () => {
  const body = findRule(styleCss, '.artifact-evolution {')
  assert.ok(body, '.artifact-evolution rule must exist')
  assert.match(body, /background:\s*var\(--bg-elev-2\)/,
    'evolution strip must sit on the secondary surface so it reads as inline detail, not a peer card')
})

test('style.css: diff-add / diff-del rows use ok / danger colour-mix tints', () => {
  assert.match(
    styleCss,
    /\.artifact-evolution-diff-line\.kind-add\s*\{[^}]*color-mix\([^)]*var\(--ok/,
    'add-lines must tint with the ok token via color-mix so both themes read correctly',
  )
  assert.match(
    styleCss,
    /\.artifact-evolution-diff-line\.kind-del\s*\{[^}]*color-mix\([^)]*var\(--danger/,
    'del-lines must tint with the danger token via color-mix so both themes read correctly',
  )
})

test('style.css: .artifact-timeline-row is a slim border-bottom stripe', () => {
  const body = findRule(styleCss, '.artifact-timeline-row {')
  assert.ok(body, '.artifact-timeline-row rule must exist')
  assert.match(body, /border-bottom:\s*1px dashed var\(--border\)/,
    'timeline rows use a dashed separator so they read as an audit list, not full cards')
})

test('style.css: existing compact-row locks (min-height <= 32) still hold', () => {
  // Belt-and-suspenders — the V2 changes must not regress the L0 row
  // locks that artifact-compact-row.test.js pins.
  const body = findRule(styleCss, '.artifact-row {')
  assert.ok(body, '.artifact-row rule must survive V2')
  const m = body.match(/min-height:\s*(\d+)px/)
  assert.ok(m, '.artifact-row must still declare min-height')
  assert.ok(Number(m[1]) <= 32, 'L0 row compact height must not drift')
})
