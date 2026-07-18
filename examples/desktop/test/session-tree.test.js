// Unit tests for the pure session-tree helpers. Runs under `node --test`.
// The module has no DOM/protocol dependency, so the tests exercise it
// directly with hand-shaped SessionListEntry / SessionEvent fixtures.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildSessionTree,
  classifyEvent,
  findChildForks,
  forkChildLabel,
  normalizedTitle,
  summarizeContentBlocks,
  classifySessionShape,
  layoutSmartlogRows,
  partitionSmartlog,
} = require('../src/renderer/session-tree.js')

function entry(id, { parent, seedLength, title, running, lastEventTime } = {}) {
  return {
    sessionId: id,
    header: {
      version: 0, id, createdAt: 0,
      parentSession: parent,
      seedLength,
    },
    live: true,
    persisted: true,
    title,
    running,
    lastEventTime,
  }
}

test('buildSessionTree returns roots for parentless entries and nests children', () => {
  const list = [
    entry('a'),
    entry('b', { parent: 'a', seedLength: 4 }),
    entry('c', { parent: 'b', seedLength: 2 }),
    entry('d'),
  ]
  const tree = buildSessionTree(list)
  assert.equal(tree.length, 2)
  const a = tree.find((n) => n.entry.sessionId === 'a')
  const d = tree.find((n) => n.entry.sessionId === 'd')
  assert.ok(a && d)
  assert.equal(a.children.length, 1)
  assert.equal(a.children[0].entry.sessionId, 'b')
  assert.equal(a.children[0].depth, 1)
  assert.equal(a.children[0].children[0].entry.sessionId, 'c')
  assert.equal(a.children[0].children[0].depth, 2)
  assert.equal(d.children.length, 0)
})

test('buildSessionTree treats an unknown parent as a root and tags orphaned', () => {
  const list = [entry('x', { parent: 'ghost', seedLength: 1 })]
  const tree = buildSessionTree(list)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].orphaned, true)
})

test('buildSessionTree tolerates malformed input', () => {
  assert.deepEqual(buildSessionTree(null), [])
  assert.deepEqual(buildSessionTree(undefined), [])
  // A row without sessionId is skipped from the index but still contributes
  // no root; input remains stable.
  const tree = buildSessionTree([{ header: {} }, entry('a')])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].entry.sessionId, 'a')
})

test('classifyEvent buckets each SessionEventMap type into a render category', () => {
  assert.equal(classifyEvent({ type: 'user/message' }), 'user')
  assert.equal(classifyEvent({ type: 'assistant/message' }), 'assistant')
  assert.equal(classifyEvent({ type: 'assistant/chunk' }), 'stream-chunk')
  assert.equal(classifyEvent({ type: 'tool/call' }), 'tool-call')
  assert.equal(classifyEvent({ type: 'tool/result' }), 'tool-result')
  assert.equal(classifyEvent({ type: 'context/message' }), 'context-injection')
  assert.equal(classifyEvent({ type: 'steering/message' }), 'context-injection')
  assert.equal(classifyEvent({ type: 'compact/start' }), 'compact-begin')
  assert.equal(classifyEvent({ type: 'compact/summary' }), 'compact-summary')
  assert.equal(classifyEvent({ type: 'compact/end' }), 'compact-end')
  assert.equal(classifyEvent({ type: 'turn/start' }), 'turn-boundary')
  assert.equal(classifyEvent({ type: 'turn/end' }), 'turn-boundary')
  assert.equal(classifyEvent({ type: 'step/start' }), 'step-boundary')
  assert.equal(classifyEvent({ type: 'step/end' }), 'step-boundary')
  assert.equal(classifyEvent({ type: 'todo/write' }), 'todo')
  assert.equal(classifyEvent({ type: 'prompt/blocked' }), 'blocked')
  assert.equal(classifyEvent({ type: 'request/header' }), 'header')
  assert.equal(classifyEvent({ type: 'request/header-delta' }), 'header')
  assert.equal(classifyEvent({ type: 'plugin/unknown-thing' }), 'other')
  assert.equal(classifyEvent(null), null)
})

test('findChildForks returns child entries with the fork seq (seedLength − 1)', () => {
  const list = [
    entry('parent'),
    entry('child-a', { parent: 'parent', seedLength: 4, title: 'question about loader', running: true }),
    entry('child-b', { parent: 'parent', seedLength: 7 }),
    entry('grandchild', { parent: 'child-a', seedLength: 5 }),
    entry('other', { parent: 'someone-else' }),
  ]
  const forks = findChildForks('parent', list)
  assert.equal(forks.length, 2)
  assert.deepEqual(
    forks.map((f) => ({ id: f.childSessionId, seq: f.forkSeq, running: f.running })),
    [
      { id: 'child-a', seq: 3, running: true },
      { id: 'child-b', seq: 6, running: false },
    ],
  )
})

test('findChildForks reports forkSeq=null when seedLength is missing', () => {
  const list = [entry('p'), entry('c', { parent: 'p' })]
  const forks = findChildForks('p', list)
  assert.equal(forks.length, 1)
  assert.equal(forks[0].forkSeq, null)
})

test('summarizeContentBlocks collapses text blocks and caps length', () => {
  assert.equal(summarizeContentBlocks([]), '')
  assert.equal(summarizeContentBlocks([{ type: 'text', text: 'hello world' }]), 'hello world')
  assert.equal(
    summarizeContentBlocks([{ type: 'image', image: 'x' }, { type: 'text', text: 'caption' }]),
    '[image] caption',
  )
  // Longer than 20 chars? Truncate with an ellipsis.
  const long = 'a'.repeat(30)
  const short = summarizeContentBlocks([{ type: 'text', text: long }], 10)
  assert.equal(short.length, 10)
  assert.ok(short.endsWith('…'))
})

// -- classifySessionShape (M5) ----------------------------------------------
//
// Maps a session-list entry to one of the five smartlog shapes borrowed from
// jj / git-branchless / ISL. Discriminant priority (most-informative wins):
//   interrupted/errored → '✕'
//   running turn        → '●'
//   subagent origin     → '⇢'
//   fork with a parent  → '⌘'
//   done or idle root   → '◇' (compacted / immutable ancestor)
// The color/label are baked in so views don't have to re-derive them.

test('classifySessionShape returns ● for a running session', () => {
  const info = classifySessionShape({ sessionId: 'a', running: true })
  assert.equal(info.shape, '●')
  assert.equal(info.role, 'running')
})

test('classifySessionShape returns ⇢ for a subagent-origin child', () => {
  const info = classifySessionShape({
    sessionId: 'a',
    header: { parentSession: 'p', originKind: 'subagent' },
  })
  assert.equal(info.shape, '⇢')
  assert.equal(info.role, 'subagent')
})

test('classifySessionShape returns ⌘ for a user-initiated fork', () => {
  const info = classifySessionShape({
    sessionId: 'a',
    header: { parentSession: 'p', seedLength: 3 },
  })
  assert.equal(info.shape, '⌘')
  assert.equal(info.role, 'fork')
})

test('classifySessionShape returns ✕ for an interrupted/failed session', () => {
  // Ticket B §B-4/B-5: `lastError` moved off `header` (phantom — never on
  // the wire) to `entry.meta.lastError`, which the renderer derives from
  // SessionFinishedNotification. Reading TurnEndReason.kind !== 'ok'
  // covers both error and user-cancel with one signal.
  const info = classifySessionShape({
    sessionId: 'a',
    meta: { lastError: { kind: 'error', message: 'user_aborted' } },
  })
  assert.equal(info.shape, '✕')
  assert.equal(info.role, 'interrupted')
})

test('classifySessionShape returns ◇ for a root or dormant session', () => {
  const rootInfo = classifySessionShape({ sessionId: 'a' })
  assert.equal(rootInfo.shape, '◇')
  assert.equal(rootInfo.role, 'idle')
})

test('classifySessionShape prefers running over subagent/fork', () => {
  // A subagent that is currently running should still read as "running" —
  // the pulsing dot is the higher-value signal for the reader.
  const info = classifySessionShape({
    sessionId: 'a',
    running: true,
    header: { parentSession: 'p', originKind: 'subagent' },
  })
  assert.equal(info.shape, '●')
  assert.equal(info.role, 'running')
})

// -- partitionSmartlog (M2) --------------------------------------------------
//
// Split raw entries into "meaningful" (real title, has children, or has a
// user message) vs "dormant" (0-event untitled leaves). The dormant group is
// what the "⋮ N dormant sessions" fold row summarizes. Uses the shared
// filterEmptySessions predicate when provided; falls back to a local check.

test('partitionSmartlog keeps rooted + titled sessions, folds untitled leaves', () => {
  const list = [
    { sessionId: 'a', title: 'Real work' },                                      // meaningful (titled)
    { sessionId: 'b', title: '', header: { parentSession: 'a', seedLength: 2 } }, // meaningful (child of a)
    { sessionId: 'c', title: '' },                                               // dormant
    { sessionId: 'd', title: '', hasUserMessage: false, eventCount: 0 },         // dormant
    { sessionId: 'e', title: '', hasUserMessage: true },                         // meaningful (user typed something)
  ]
  const p = partitionSmartlog(list)
  const meaningfulIds = p.meaningful.map((e) => e.sessionId).sort()
  const dormantIds = p.dormant.map((e) => e.sessionId).sort()
  assert.deepEqual(meaningfulIds, ['a', 'b', 'e'])
  assert.deepEqual(dormantIds, ['c', 'd'])
})

test('partitionSmartlog keeps a dormant session whose child is meaningful', () => {
  // A titleless root that has a titled child must survive the cut — losing
  // it would orphan the child in the graph.
  const list = [
    { sessionId: 'root', title: '' },
    { sessionId: 'child', title: 'nested', header: { parentSession: 'root', seedLength: 2 } },
  ]
  const p = partitionSmartlog(list)
  assert.deepEqual(p.meaningful.map((e) => e.sessionId).sort(), ['child', 'root'])
  assert.equal(p.dormant.length, 0)
})

test('partitionSmartlog handles null / empty input gracefully', () => {
  assert.deepEqual(partitionSmartlog(null), { meaningful: [], dormant: [] })
  assert.deepEqual(partitionSmartlog([]), { meaningful: [], dormant: [] })
})

// -- layoutSmartlogRows (M1) -------------------------------------------------
//
// Given the forest produced by buildSessionTree, return a flat row list in
// smartlog order (root then descendants, DFS, siblings by recency). Each row
// carries a `lane` (0..N-1) — the rail column it occupies. Lanes are assigned
// greedily and released the moment a subtree ends, so the picture is compact.
// The row also lists the `parentLane` so the SVG renderer can draw the curve.

test('layoutSmartlogRows returns roots on lane 0 in recency order', () => {
  const forest = [
    { entry: { sessionId: 'a', lastEventTime: 200 }, depth: 0, children: [] },
    { entry: { sessionId: 'b', lastEventTime: 300 }, depth: 0, children: [] },
    { entry: { sessionId: 'c', lastEventTime: 100 }, depth: 0, children: [] },
  ]
  const rows = layoutSmartlogRows(forest)
  assert.deepEqual(rows.map((r) => r.entry.sessionId), ['b', 'a', 'c'])
  for (const r of rows) assert.equal(r.lane, 0)
})

test('layoutSmartlogRows assigns a fresh lane per branch, inherits only-child lane, reuses on subtree exit', () => {
  // Shape:
  //   a         lane 0   (root)
  //   ├─ b      lane 1   (first of multiple — branch to new lane)
  //   │  └─ d   lane 1   (only child of b — inherit parent's lane)
  //   └─ c      lane 1   (b's subtree exited, lane 1 is free; c reuses it)
  //
  // "Only-child inherits, non-only-child branches, branched lane releases on
  // subtree exit" is enough to keep the picture narrow in the common case
  // (many forks over time, few concurrent forks at any one row).
  const forest = [{
    entry: { sessionId: 'a', lastEventTime: 500 },
    depth: 0,
    children: [
      {
        entry: { sessionId: 'b', lastEventTime: 400 },
        depth: 1,
        children: [{ entry: { sessionId: 'd', lastEventTime: 300 }, depth: 2, children: [] }],
      },
      { entry: { sessionId: 'c', lastEventTime: 100 }, depth: 1, children: [] },
    ],
  }]
  const rows = layoutSmartlogRows(forest)
  assert.deepEqual(rows.map((r) => r.entry.sessionId), ['a', 'b', 'd', 'c'])
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 1, 1])
  // Each non-root row records the lane its parent occupies so an SVG renderer
  // can trace a curve from (parentLane, parentRow) to (lane, thisRow).
  assert.equal(rows[1].parentLane, 0) // b's parent a is lane 0
  assert.equal(rows[2].parentLane, 1) // d's parent b is lane 1
  assert.equal(rows[3].parentLane, 0) // c's parent a is lane 0
})

test('layoutSmartlogRows branches multi-child parents to distinct lanes and reuses on subtree exit', () => {
  // Multi-child parent p with two subtrees of its own:
  //   p         lane 0 (root)
  //   ├─ q      lane 1 (first of 2 → branch)
  //   │  └─ qq  lane 1 (only child → inherit)
  //   └─ r      lane 1 (q's subtree exited, lane 1 free again → reuse)
  //      └─ rr  lane 1 (only child → inherit)
  //
  // Lane 1 is reused because q's subtree closed and the picture stays narrow.
  // If q and r had been going concurrently in wall-clock terms they'd sit on
  // different rails — but in the DFS walk order they don't, and the smartlog
  // convention (only-child inherits, siblings branch, branched columns
  // release on subtree exit) gives the compact reuse pattern.
  const forest = [{
    entry: { sessionId: 'p', lastEventTime: 500 },
    depth: 0,
    children: [
      {
        entry: { sessionId: 'q', lastEventTime: 400 },
        depth: 1,
        children: [{ entry: { sessionId: 'qq', lastEventTime: 350 }, depth: 2, children: [] }],
      },
      {
        entry: { sessionId: 'r', lastEventTime: 300 },
        depth: 1,
        children: [{ entry: { sessionId: 'rr', lastEventTime: 250 }, depth: 2, children: [] }],
      },
    ],
  }]
  const rows = layoutSmartlogRows(forest)
  assert.deepEqual(rows.map((r) => r.entry.sessionId), ['p', 'q', 'qq', 'r', 'rr'])
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 1, 1, 1])
  assert.equal(rows[0].parentLane, null)
  assert.equal(rows[1].parentLane, 0)
  assert.equal(rows[2].parentLane, 1)
  assert.equal(rows[3].parentLane, 0)
  assert.equal(rows[4].parentLane, 1)
})

test('layoutSmartlogRows returns [] for empty forest', () => {
  assert.deepEqual(layoutSmartlogRows([]), [])
  assert.deepEqual(layoutSmartlogRows(null), [])
})

// -- forkChildLabel / normalizedTitle (task #198 readability fix) -----------
//
// The bug: fork children are seeded from the parent's event log at
// `Session.create` time, which includes the first user message, so the
// daemon derives an IDENTICAL title from the same first message. Rendering
// `child.title` verbatim produced rows that looked like duplicates of the
// parent — the user's "不太看得懂" feedback. forkChildLabel replaces the
// visible label with a fork-point identity string so a row's own signal
// (its NEW user message, or "no new messages yet") reads at a glance.

test('normalizedTitle prefers header.title, falls back to entry.title, strips placeholders', () => {
  assert.equal(normalizedTitle(null), '')
  assert.equal(normalizedTitle({}), '')
  assert.equal(normalizedTitle({ title: '  hello  ' }), 'hello')
  assert.equal(normalizedTitle({ header: { title: 'from-header' }, title: 'from-entry' }), 'from-header')
  // Smoke fixtures and the "(shortId)" fallback are treated as no-title.
  assert.equal(normalizedTitle({ title: 'smoke-abc' }), '')
  assert.equal(normalizedTitle({ title: '(smoke-abc)' }), '')
  assert.equal(normalizedTitle({ sessionId: '0123456789ab', title: '(01234567)' }), '')
})

test('forkChildLabel: parent-title copy collapses to "no new messages yet"', () => {
  const parent = { title: 'parent turn one', header: { title: 'parent turn one' } }
  const child = { title: 'parent turn one', header: { title: 'parent turn one', parentSession: { id: 'p', seq: 3 }, seedLength: 4 } }
  const label = forkChildLabel(child, parent, 3)
  assert.equal(label.text, 'fork @ seq 3 · (no new messages yet)')
  assert.equal(label.hasOwnMessage, false)
  assert.equal(label.forkSeq, 3)
})

test('forkChildLabel: child with its own message wins', () => {
  const parent = { title: 'debug the tree page' }
  const child = { title: 'try a different palette', header: { seedLength: 8, parentSession: { id: 'p', seq: 7 } } }
  const label = forkChildLabel(child, parent, 7)
  assert.equal(label.text, 'fork @ seq 7 · try a different palette')
  assert.equal(label.hasOwnMessage, true)
})

test('forkChildLabel: null forkSeq omits the seq part', () => {
  const parent = { title: 'shared' }
  const child = { title: 'shared' }
  const label = forkChildLabel(child, parent, null)
  assert.equal(label.text, 'fork · (no new messages yet)')
  assert.equal(label.forkSeq, null)
})

test('forkChildLabel: subagent origin swaps the kind prefix', () => {
  const parent = { title: 'debug tree page' }
  const child = { title: 'run lint report', header: { seedLength: 5, parentSession: 'p', originKind: 'subagent' } }
  const label = forkChildLabel(child, parent, 4)
  assert.equal(label.text, 'subagent @ seq 4 · run lint report')
  assert.equal(label.kind, 'subagent')
})

test('forkChildLabel: missing parent still produces a usable label', () => {
  // Defensive path: when the parent entry is null (e.g. wire race, parent
  // filtered out of the visible list), fall back to "no new messages yet"
  // unless the child has a non-placeholder title. This keeps the row from
  // ever crashing when the seed race between parent list + child list races.
  const child = { title: '', header: { seedLength: 3 } }
  const label = forkChildLabel(child, null, 2)
  assert.equal(label.text, 'fork @ seq 2 · (no new messages yet)')
})
