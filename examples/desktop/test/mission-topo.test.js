// Pure unit tests for the mission-topo view's helper functions.
//
// mission-topo.js is a script-tag IIFE that renders SVG when `render()`
// runs, but its helpers (assignFamilies, radiusFor, shortLabel) are pure —
// they only touch closure-scoped inputs. The module exposes them on
// `_internal` so we can exercise the branchy bits (family propagation
// across edges, radius clamps, label ellipsize) without a DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function loadModule() {
  const p = require.resolve('../src/renderer/mission-topo.js')
  delete require.cache[p]
  return require('../src/renderer/mission-topo.js')
}

const { _internal } = loadModule()
const { assignFamilies, radiusFor, shortLabel, FAMILY_PALETTE, pickLabeledNodes } = _internal

// ---- assignFamilies --------------------------------------------------------

test('assignFamilies: one root paints its whole subtree', () => {
  const graph = {
    nodes: [
      { sessionId: 'root', rank: 0, lastEventTime: 100 },
      { sessionId: 'child', rank: 1 },
      { sessionId: 'grand', rank: 2 },
    ],
    edges: [
      { from: 'root', to: 'child' },
      { from: 'child', to: 'grand' },
    ],
  }
  const { familyOf, colorOf, roots } = assignFamilies(graph)
  assert.equal(familyOf.get('root'), 'root')
  assert.equal(familyOf.get('child'), 'root')
  assert.equal(familyOf.get('grand'), 'root')
  assert.equal(colorOf.get('root'), FAMILY_PALETTE[0])
  assert.equal(roots.length, 1)
})

test('assignFamilies: separate roots get separate palette slots', () => {
  const graph = {
    nodes: [
      { sessionId: 'a', rank: 0, lastEventTime: 300 },
      { sessionId: 'b', rank: 0, lastEventTime: 200 },
      { sessionId: 'c', rank: 0, lastEventTime: 100 },
      { sessionId: 'a1', rank: 1 },
      { sessionId: 'b1', rank: 1 },
    ],
    edges: [
      { from: 'a', to: 'a1' },
      { from: 'b', to: 'b1' },
    ],
  }
  const { familyOf, colorOf, roots } = assignFamilies(graph)
  // Root order = lastEventTime desc, so a→0, b→1, c→2.
  assert.equal(roots.map((r) => r.sessionId).join(','), 'a,b,c')
  assert.equal(familyOf.get('a1'), 'a')
  assert.equal(familyOf.get('b1'), 'b')
  assert.equal(colorOf.get('a'), FAMILY_PALETTE[0])
  assert.equal(colorOf.get('b'), FAMILY_PALETTE[1])
  assert.equal(colorOf.get('c'), FAMILY_PALETTE[2])
})

test('assignFamilies: palette wraps past the last color', () => {
  const roots = Array.from({ length: FAMILY_PALETTE.length + 2 }, (_, i) => ({
    sessionId: `r${i}`, rank: 0, lastEventTime: 1000 - i, // strict desc
  }))
  const { colorOf } = assignFamilies({ nodes: roots, edges: [] })
  assert.equal(colorOf.get('r0'), FAMILY_PALETTE[0])
  assert.equal(colorOf.get(`r${FAMILY_PALETTE.length}`), FAMILY_PALETTE[0])
  assert.equal(colorOf.get(`r${FAMILY_PALETTE.length + 1}`), FAMILY_PALETTE[1])
})

test('assignFamilies: out-of-order edges still propagate', () => {
  // Edge list arrives child-first, then parent. Single-pass BFS would miss
  // this; the guarded loop should catch it in ≤2 iterations.
  const graph = {
    nodes: [
      { sessionId: 'root', rank: 0, lastEventTime: 1 },
      { sessionId: 'mid', rank: 1 },
      { sessionId: 'leaf', rank: 2 },
    ],
    edges: [
      { from: 'mid', to: 'leaf' }, // child-of-mid first
      { from: 'root', to: 'mid' },
    ],
  }
  const { familyOf } = assignFamilies(graph)
  assert.equal(familyOf.get('leaf'), 'root')
})

test('assignFamilies: orphan (no root ancestor) stays unassigned', () => {
  // An edge whose parent isn't a rank-0 node and never becomes one shouldn't
  // crash the assignment or graft the child into an unrelated family.
  const graph = {
    nodes: [
      { sessionId: 'r', rank: 0, lastEventTime: 1 },
      { sessionId: 'ghost', rank: 1 }, // not connected to r
      { sessionId: 'orphan', rank: 1 },
    ],
    edges: [
      { from: 'ghost', to: 'orphan' },
    ],
  }
  const { familyOf } = assignFamilies(graph)
  assert.equal(familyOf.get('r'), 'r')
  assert.equal(familyOf.has('ghost'), false)
  assert.equal(familyOf.has('orphan'), false)
})

test('assignFamilies: cycle edge does not loop forever', () => {
  // Not physically expected (the model produces a DAG), but the guarded
  // 8-pass loop should still terminate cleanly if one appears.
  const graph = {
    nodes: [
      { sessionId: 'r', rank: 0, lastEventTime: 1 },
      { sessionId: 'a', rank: 1 },
      { sessionId: 'b', rank: 1 },
    ],
    edges: [
      { from: 'r', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }, // cycle back
    ],
  }
  const { familyOf } = assignFamilies(graph)
  assert.equal(familyOf.get('a'), 'r')
  assert.equal(familyOf.get('b'), 'r')
})

test('assignFamilies: empty graph returns empty maps', () => {
  const { familyOf, colorOf, roots } = assignFamilies({ nodes: [], edges: [] })
  assert.equal(familyOf.size, 0)
  assert.equal(colorOf.size, 0)
  assert.equal(roots.length, 0)
})

// ---- radiusFor -------------------------------------------------------------

test('radiusFor: zero events pins to the low floor (6px)', () => {
  assert.equal(radiusFor({ eventCount: 0 }), 6)
  assert.equal(radiusFor({}), 6) // missing count treated as 0
  assert.equal(radiusFor({ eventCount: -5 }), 6) // negatives clamp too
})

test('radiusFor: monotonically non-decreasing with event count', () => {
  const counts = [0, 1, 5, 10, 50, 100, 1000, 10000]
  const radii = counts.map((c) => radiusFor({ eventCount: c }))
  for (let i = 1; i < radii.length; i++) {
    assert.ok(radii[i] >= radii[i - 1], `r(${counts[i]})=${radii[i]} < r(${counts[i - 1]})=${radii[i - 1]}`)
  }
})

test('radiusFor: huge event count caps at 14px', () => {
  assert.equal(radiusFor({ eventCount: 1e6 }), 14)
  assert.equal(radiusFor({ eventCount: 1e9 }), 14)
})

test('radiusFor: mid-range integer output', () => {
  // log2(4+1)*2+6 ≈ 10.64 → 11. Just pins the rounding rule.
  assert.equal(radiusFor({ eventCount: 4 }), 11)
})

// ---- shortLabel ------------------------------------------------------------

test('shortLabel: short titles pass through', () => {
  assert.equal(shortLabel('build agent', 'abc12345'), 'build agent')
})

test('shortLabel: 20-char boundary stays intact', () => {
  const s20 = 'a'.repeat(20)
  assert.equal(shortLabel(s20, 'abc12345'), s20)
})

test('shortLabel: longer than 20 chars ellipsizes at 18', () => {
  const s = 'the quick brown fox jumps over'
  const out = shortLabel(s, 'abc12345')
  assert.equal(out, 'the quick brown fo' + '…')
  assert.equal(out.length, 19) // 18 chars + ellipsis
})

test('shortLabel: empty title falls back to short session id', () => {
  assert.equal(shortLabel('', 'abcd1234ef'), 'abcd1234')
  assert.equal(shortLabel(null, 'abcd1234ef'), 'abcd1234')
  assert.equal(shortLabel('   ', 'abcd1234ef'), 'abcd1234')
})

// ---- pickLabeledNodes ------------------------------------------------------
//
// The topology view refused to draw a `<text>` for every node once N grew
// past ~25 roots — labels overran each other into `smoke-tsmoke-ts…`. This
// helper picks a subset of nodes to keep labeled, in priority order:
//   1. rank-0 roots always win (they anchor a family)
//   2. within a rank row, nodes are considered left-to-right; a node loses
//      its label if it sits within `minPx` of the last-kept node's label.
// Unlabeled nodes still render dots + native `<title>` tooltips + the hover
// tip, so hover disambiguates them; the SVG just stops trying to name
// every dot when there's no room. Pure input/output — no DOM.

test('pickLabeledNodes: below threshold, every node keeps its label', () => {
  const nodes = [
    { sessionId: 'a', rank: 0, x: 0.1, y: 0.0 },
    { sessionId: 'b', rank: 0, x: 0.5, y: 0.0 },
    { sessionId: 'c', rank: 0, x: 0.9, y: 0.0 },
  ]
  const kept = pickLabeledNodes(nodes, { width: 1000, orientation: 'vertical', minPx: 60 })
  assert.equal(kept.size, 3)
  assert.ok(kept.has('a'))
  assert.ok(kept.has('b'))
  assert.ok(kept.has('c'))
})

test('pickLabeledNodes: dense row drops leaves before roots', () => {
  // 3 roots at x=0.1/0.5/0.9 — well-spaced — plus 5 leaves at rank 1
  // packed into 0.1..0.3. Roots must survive; leaves get demoted.
  const nodes = [
    { sessionId: 'r1', rank: 0, x: 0.1, y: 0.0 },
    { sessionId: 'r2', rank: 0, x: 0.5, y: 0.0 },
    { sessionId: 'r3', rank: 0, x: 0.9, y: 0.0 },
    { sessionId: 'l1', rank: 1, x: 0.10, y: 0.5 },
    { sessionId: 'l2', rank: 1, x: 0.12, y: 0.5 },
    { sessionId: 'l3', rank: 1, x: 0.14, y: 0.5 },
    { sessionId: 'l4', rank: 1, x: 0.16, y: 0.5 },
    { sessionId: 'l5', rank: 1, x: 0.18, y: 0.5 },
  ]
  const kept = pickLabeledNodes(nodes, { width: 800, orientation: 'vertical', minPx: 60 })
  // All 3 roots kept
  assert.ok(kept.has('r1'))
  assert.ok(kept.has('r2'))
  assert.ok(kept.has('r3'))
  // Leaves within 60px of each other collapse to first kept
  assert.ok(kept.has('l1'))
  assert.ok(!kept.has('l2'))
  assert.ok(!kept.has('l3'))
})

test('pickLabeledNodes: 25 crushed roots collide, subset is kept', () => {
  // 25 roots strung across the top at 1440px viewport ≈ 58px between
  // centres. At minPx=80 the labels crush into a smear — pickLabeledNodes
  // drops labels within the collision window so what stays is readable.
  // (Round-2 fix, 2026-07-16: roots are subject to collision detection
  // like any other rank row; the earlier "roots always survive" rule
  // failed on exactly this input.)
  const nodes = Array.from({ length: 25 }, (_, i) => ({
    sessionId: `r${i}`,
    rank: 0,
    x: (i + 0.5) / 25,
    y: 0,
    eventCount: i, // strictly ascending so highest-events is deterministic
  }))
  const kept = pickLabeledNodes(nodes, { width: 1440, orientation: 'vertical', minPx: 80 })
  // 1440 / 80 = 18 max labels; we should be under that.
  assert.ok(kept.size <= 18, `kept ${kept.size} > 18 caps`)
  assert.ok(kept.size >= 8, `kept ${kept.size} too aggressive`)
})

test('pickLabeledNodes: collision cluster keeps highest-eventCount node', () => {
  // Three nodes on the same rank row, all within collision distance.
  // The one with the highest eventCount wins — it's the "biggest dot",
  // labeling it is a stable, importance-driven pick.
  const nodes = [
    { sessionId: 'r', rank: 0, x: 0.50, y: 0, eventCount: 0 },
    { sessionId: 's', rank: 0, x: 0.52, y: 0, eventCount: 50 }, // winner
    { sessionId: 't', rank: 0, x: 0.54, y: 0, eventCount: 3 },
  ]
  const kept = pickLabeledNodes(nodes, { width: 1000, orientation: 'vertical', minPx: 80 })
  assert.equal(kept.size, 1)
  assert.ok(kept.has('s'))
})

test('pickLabeledNodes: two well-spaced roots both kept', () => {
  // Sanity: when roots aren't crushed, both survive. Round-1 test still
  // passes intent — the rule is "kept if there's room", not "always kept".
  const nodes = [
    { sessionId: 'a', rank: 0, x: 0.10, y: 0, eventCount: 5 },
    { sessionId: 'b', rank: 0, x: 0.90, y: 0, eventCount: 5 },
  ]
  const kept = pickLabeledNodes(nodes, { width: 1000, orientation: 'vertical', minPx: 80 })
  assert.equal(kept.size, 2)
})

test('pickLabeledNodes: horizontal orientation collapses by y not x', () => {
  // In horizontal mode rank is the x axis, cross is y — labels stack
  // vertically so proximity is measured on y. The two roots at y=0.10/0.11
  // collide; the far root at y=0.90 stays. Two survive (winner of the
  // cluster + the far one), matching how the collision loop works.
  const nodes = [
    { sessionId: 'r1', rank: 0, x: 0.05, y: 0.10, eventCount: 3 },
    { sessionId: 'r2', rank: 0, x: 0.05, y: 0.11, eventCount: 10 }, // winner (higher count)
    { sessionId: 'r3', rank: 0, x: 0.05, y: 0.90, eventCount: 0 },
  ]
  const kept = pickLabeledNodes(nodes, { width: 1000, orientation: 'horizontal', minPx: 60 })
  assert.equal(kept.size, 2)
  assert.ok(kept.has('r2'))
  assert.ok(kept.has('r3'))
})

test('pickLabeledNodes: leaves at different rank do not collide (compare per row)', () => {
  // Two leaves at nearly identical x but different rank sit far apart on the
  // main axis, so their labels don't collide. Collision only checks nodes on
  // the same rank row.
  const nodes = [
    { sessionId: 'r', rank: 0, x: 0.5, y: 0.0 },
    { sessionId: 'a', rank: 1, x: 0.10, y: 0.5 },
    { sessionId: 'b', rank: 2, x: 0.11, y: 0.9 }, // very close in x, different rank
  ]
  const kept = pickLabeledNodes(nodes, { width: 800, orientation: 'vertical', minPx: 60 })
  assert.ok(kept.has('a'))
  assert.ok(kept.has('b'))
})

test('pickLabeledNodes: empty node list returns empty set', () => {
  const kept = pickLabeledNodes([], { width: 800, orientation: 'vertical', minPx: 60 })
  assert.equal(kept.size, 0)
})
