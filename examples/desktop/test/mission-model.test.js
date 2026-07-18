// Unit tests for the Mission Control pure data model. Runs under
// `node --test`. Exercises the reducers (applySessionList, applyEvent,
// applySubagentEdge) and each projection (tree rows, topology, board,
// summary, ticker) with hand-shaped SessionListEntry / SessionEvent
// fixtures, mirroring session-tree.test.js.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createMissionState,
  applySessionList,
  applyEvent,
  applySubagentEdge,
  projectTreeRows,
  projectTopology,
  projectBoard,
  projectSummary,
  projectTicker,
} = require('../src/renderer/mission-model.js')

function entry(id, opts) {
  const o = opts || {}
  return {
    sessionId: id,
    header: {
      version: 0, id, createdAt: 0,
      parentSession: o.parent,
      seedLength: o.seedLength,
    },
    title: o.title,
    running: !!o.running,
    lastEventTime: o.lastEventTime || 0,
    live: true, persisted: true,
  }
}

test('applySessionList registers sessions and records parent edges', () => {
  const s = createMissionState()
  applySessionList(s, [
    entry('root'),
    entry('child', { parent: 'root', seedLength: 3, title: 'sub', lastEventTime: 10 }),
  ])
  assert.equal(s.sessions.size, 2)
  const child = s.sessions.get('child')
  assert.equal(child.parentSession, 'root')
  assert.equal(child.seedLength, 3)
  assert.equal(s.edges.get('root').has('child'), true)
})

test('applySessionList prunes vanished sessions but keeps referenced parents', () => {
  const s = createMissionState()
  applySessionList(s, [entry('a'), entry('b'), entry('c', { parent: 'a' })])
  applySessionList(s, [entry('a'), entry('c', { parent: 'a' })])
  assert.equal(s.sessions.has('b'), false)
  assert.equal(s.sessions.has('c'), true)
  assert.equal(s.sessions.has('a'), true)
})

test('applyEvent counts tool calls, assistant/user messages, and refreshes tail', () => {
  const s = createMissionState()
  applyEvent(s, 'x', { type: 'turn/start', time: 1, data: { turn: 0, trigger: {} } })
  applyEvent(s, 'x', { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: 'user' } })
  applyEvent(s, 'x', { type: 'tool/call', time: 3, data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } })
  applyEvent(s, 'x', { type: 'assistant/message', time: 4, data: { turn: 0, step: 0, content: [{ type: 'text', text: 'ok' }] } })
  applyEvent(s, 'x', { type: 'turn/end', time: 5, data: { turn: 0, reason: { kind: 'complete' } } })
  const rec = s.sessions.get('x')
  assert.equal(rec.eventCount, 5)
  assert.equal(rec.userMessageCount, 1)
  assert.equal(rec.assistantMessageCount, 1)
  assert.equal(rec.toolCallCount, 1)
  assert.equal(rec.running, false)
  assert.equal(rec.lastEventTime, 5)
})

test('applyEvent captures todo/write snapshot and records write-tool paths', () => {
  const s = createMissionState()
  applyEvent(s, 'x', { type: 'todo/write', time: 1, data: { todos: [
    { content: 'A', status: 'pending' },
    { content: 'B', status: 'in_progress' },
  ] } })
  applyEvent(s, 'x', { type: 'tool/call', time: 2, data: {
    turn: 0, step: 0, callId: 'c', name: 'edit_file',
    arguments: JSON.stringify({ path: '/tmp/foo.txt' }),
  } })
  const rec = s.sessions.get('x')
  assert.equal(rec.todos.length, 2)
  assert.equal(rec.todos[1].status, 'in_progress')
  assert.deepEqual(rec.writes, ['/tmp/foo.txt'])
})

test('applySubagentEdge grows the graph before the next list refresh', () => {
  const s = createMissionState()
  applySessionList(s, [entry('p')])
  applySubagentEdge(s, { parentSessionId: 'p', childSessionId: 'k', status: 'started' })
  assert.equal(s.sessions.has('k'), true)
  assert.equal(s.sessions.get('k').running, true)
  assert.equal(s.edges.get('p').has('k'), true)
  applySubagentEdge(s, { parentSessionId: 'p', childSessionId: 'k', status: 'finished' })
  assert.equal(s.sessions.get('k').running, false)
  // Edge stays in place after finish.
  assert.equal(s.edges.get('p').has('k'), true)
})

test('projectTreeRows returns roots-first with children flattened by depth', () => {
  const s = createMissionState()
  applySessionList(s, [
    entry('a', { lastEventTime: 5 }),
    entry('b', { parent: 'a', lastEventTime: 4 }),
    entry('c', { parent: 'b', lastEventTime: 3 }),
    entry('d', { lastEventTime: 10 }),
  ])
  const rows = projectTreeRows(s)
  const ids = rows.map((r) => r.sessionId)
  // Roots ordered by lastEventTime desc → d first, then a. Children flatten.
  assert.deepEqual(ids, ['d', 'a', 'b', 'c'])
  const depths = rows.map((r) => r.depth)
  assert.deepEqual(depths, [0, 0, 1, 2])
  const bRow = rows.find((r) => r.sessionId === 'b')
  assert.equal(bRow.hasChildren, true)
})

test('projectTreeRows surfaces orphan when parent is missing', () => {
  const s = createMissionState()
  applySessionList(s, [entry('x', { parent: 'ghost' })])
  const rows = projectTreeRows(s)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].orphan, true)
})

test('projectTopology assigns ranks by depth and returns pixel-space fractions', () => {
  const s = createMissionState()
  applySessionList(s, [
    entry('root'),
    entry('a', { parent: 'root' }),
    entry('b', { parent: 'root' }),
    entry('a1', { parent: 'a' }),
  ])
  const g = projectTopology(s)
  const node = (id) => g.nodes.find((n) => n.sessionId === id)
  assert.equal(node('root').rank, 0)
  assert.equal(node('a').rank, 1)
  assert.equal(node('a1').rank, 2)
  for (const n of g.nodes) {
    assert.ok(n.x >= 0 && n.x <= 1)
    assert.ok(n.y >= 0 && n.y <= 1)
  }
  // Root sits above children in vertical orientation (smaller y).
  assert.ok(node('root').y < node('a').y)
  assert.ok(node('a').y < node('a1').y)
  // Two edges: root→a, root→b, a→a1.
  const edgeCount = g.edges.length
  assert.equal(edgeCount, 3)
})

test('projectTopology honors horizontal orientation', () => {
  const s = createMissionState()
  applySessionList(s, [entry('root'), entry('a', { parent: 'root' })])
  const g = projectTopology(s, { orientation: 'horizontal' })
  const root = g.nodes.find((n) => n.sessionId === 'root')
  const a = g.nodes.find((n) => n.sessionId === 'a')
  assert.ok(root.x < a.x)
})

test('projectBoard groups todos by status and omits sessions with none', () => {
  const s = createMissionState()
  applySessionList(s, [entry('sess1', { title: 'Q1' }), entry('sess2', { title: 'Q2' }), entry('empty')])
  applyEvent(s, 'sess1', { type: 'todo/write', time: 1, data: { todos: [
    { content: 'design plan', status: 'in_progress' },
    { content: 'write test', status: 'pending' },
  ] } })
  applyEvent(s, 'sess2', { type: 'todo/write', time: 1, data: { todos: [
    { content: 'ship it', status: 'completed' },
  ] } })
  const b = projectBoard(s)
  assert.equal(b.pending.length, 1)
  assert.equal(b.in_progress.length, 1)
  assert.equal(b.completed.length, 1)
  assert.equal(b.pending[0].sessionId, 'sess1')
  assert.equal(b.pending[0].content, 'write test')
  // "empty" has no todos → doesn't appear.
  const allSessions = new Set()
  for (const bucket of Object.values(b)) for (const c of bucket) allSessions.add(c.sessionId)
  assert.equal(allSessions.has('empty'), false)
})

// C-P0-1 (2026-07-16): the chat pane's `state.sessions.running` flag reflects
// turn/start faster than the periodic session/list snapshot the server sends.
// The mission-controller now re-emits the entry list with `running=true`
// forced for the active in-flight session. This test locks in that reapplying
// the same session set with a flipped `running` bit updates the running
// counter without recreating the session record (so counters like eventCount
// don't reset).
test('applySessionList re-applied with flipped running flips the running counter', () => {
  const s = createMissionState()
  const now = Date.now()
  applySessionList(s, [
    entry('a', { running: false, lastEventTime: now }),
    entry('b', { running: false, lastEventTime: now }),
  ])
  applyEvent(s, 'a', { type: 'tool/call', time: now, data: { turn: 0, step: 0, callId: 'x', name: 'bash', arguments: '{}' } })
  assert.equal(projectSummary(s, 0).runningSessions, 0)
  // Re-apply with a running override on 'a' — matches how mission-controller
  // seedFromChat re-emits when getInflightTurn() is true for the active id.
  applySessionList(s, [
    entry('a', { running: true, lastEventTime: now }),
    entry('b', { running: false, lastEventTime: now }),
  ])
  const summary = projectSummary(s, 0)
  assert.equal(summary.runningSessions, 1)
  assert.equal(summary.totalSessions, 2)
  // Counters from applyEvent above should be preserved, not reset.
  assert.equal(summary.totalToolCalls, 1)
})

test('projectSummary aggregates totals + running + recent-events window', () => {
  const s = createMissionState()
  const now = Date.now()
  applySessionList(s, [
    entry('a', { running: true, lastEventTime: now }),
    entry('b', { running: false, lastEventTime: now - 500 }),
  ])
  applyEvent(s, 'a', { type: 'tool/call', time: now, data: { turn: 0, step: 0, callId: 'x', name: 'bash', arguments: '{}' } })
  applyEvent(s, 'b', { type: 'todo/write', time: now, data: { todos: [
    { content: 'p', status: 'pending' },
    { content: 'i', status: 'in_progress' },
  ] } })
  const summary = projectSummary(s, 0)
  assert.equal(summary.totalSessions, 2)
  assert.equal(summary.runningSessions, 1)
  assert.equal(summary.totalToolCalls, 1)
  assert.equal(summary.todosPending, 1)
  assert.equal(summary.todosInProgress, 1)
  assert.ok(summary.recentEvents >= 1)
})

test('projectTicker returns newest entries first, bounded by cap', () => {
  const s = createMissionState()
  applySessionList(s, [entry('a', { title: 'sess-a' })])
  for (let i = 0; i < 5; i++) {
    applyEvent(s, 'a', { type: 'assistant/chunk', time: i, data: { turn: 0, step: 0, chunk: { type: 'text-delta', text: 'x' } } })
  }
  const t = projectTicker(s, 3)
  assert.equal(t.length, 3)
  assert.equal(t[0].sessionTitle, 'sess-a')
  assert.equal(t[0].type, 'assistant/chunk')
})

test('applyEvent ignores malformed events', () => {
  const s = createMissionState()
  applyEvent(s, 'a', null)
  applyEvent(s, 'a', {})
  applyEvent(s, '', { type: 'user/message' })
  assert.equal(s.sessions.size, 0)
})

test('applySessionList is a no-op on bad input', () => {
  const s = createMissionState()
  applySessionList(s, null)
  applySessionList(s, undefined)
  assert.equal(s.sessions.size, 0)
})

// C-P0-1 integration pin (2026-07-16): the sidebar and Mission Control read
// the same server-authoritative session/list, but they used to disagree
// because Mission's summary counted every empty smoke-st ghost while the
// sidebar filtered them out via mergeRecentSessions. mission-controller now
// runs panels-c.filterEmptySessions before applySessionList; this test
// documents the intended pipeline behaviour end-to-end.
test('pipeline: filterEmptySessions upstream + applySessionList yields sidebar-consistent counters', () => {
  const { filterEmptySessions } = require('../src/renderer/panels-c.js')
  const now = Date.now()
  // Realistic mix seen in qa-walkthrough round-2 shots: 3 real active
  // sessions, 12 empty smoke-st ghosts left by the CDP driver, one active
  // "just clicked +" empty session at the top of the sidebar.
  const raw = [
    { sessionId: 'real-a', live: true, hasUserMessage: true, running: true,  lastEventTime: now - 1_000 },
    { sessionId: 'real-b', live: true, hasUserMessage: true, running: false, lastEventTime: now - 60_000 },
    { sessionId: 'real-c', live: false, persisted: true, hasUserMessage: true, running: false, lastEventTime: now - 3_600_000 },
    { sessionId: 'just-clicked-new', live: true, hasUserMessage: false, running: false, lastEventTime: now - 100 },
  ]
  for (let i = 0; i < 12; i++) {
    raw.push({
      sessionId: `smoke-st-${i}`, live: true, hasUserMessage: false, running: false,
      lastEventTime: now - 3_600_000 - i * 1000,
    })
  }
  const filtered = filterEmptySessions(raw, { activeSessionId: 'just-clicked-new' })
  const s = createMissionState()
  applySessionList(s, filtered)
  const summary = projectSummary(s, 0)
  // 3 real + 1 active-empty (kept because it's the active session) = 4
  assert.equal(summary.totalSessions, 4)
  // Only real-a is running — the empty smoke ghosts are gone, so the
  // Running number doesn't get diluted by 12 ghosts stuck at 0.
  assert.equal(summary.runningSessions, 1)
})

// Round-3 regression pin (2026-07-16): the Mission-side data source is chat's
// getSessions() projection, which historically did NOT include hasUserMessage.
// The filter kept every smoke-st row because the flag was undefined. The
// fix routes both surfaces through the same fixture — projections that lack
// hasUserMessage but carry eventCount === 0 are dropped, matching what the
// sidebar sees.
test('pipeline: unannotated chat-side projection is filtered by eventCount fallback', () => {
  const { filterEmptySessions } = require('../src/renderer/panels-c.js')
  const now = Date.now()
  // What getSessions() used to return before this fix — no hasUserMessage on
  // any row. The daemon-side session/list carries eventCount for persisted
  // rows; the round-3 fix forwards it into meta and thence into this shape.
  const projection = [
    { sessionId: 'real-a', live: true, running: true,  lastEventTime: now - 1_000, eventCount: 5 },
    { sessionId: 'real-b', live: true, running: false, lastEventTime: now - 60_000, eventCount: 3 },
    { sessionId: 'just-new', live: true, running: false, lastEventTime: now - 100, eventCount: 0 },
  ]
  for (let i = 0; i < 12; i++) {
    projection.push({
      sessionId: `smoke-st-${i}`, live: true, persisted: true, running: false,
      lastEventTime: now - 3_600_000 - i * 1000, eventCount: 0,
    })
  }
  const filtered = filterEmptySessions(projection, { activeSessionId: 'just-new' })
  const s = createMissionState()
  applySessionList(s, filtered)
  const summary = projectSummary(s, 0)
  // 2 real + 1 active-empty (kept because active) = 3; 12 smoke ghosts dropped.
  assert.equal(summary.totalSessions, 3)
  assert.equal(summary.runningSessions, 1)
})

// Regression (2026-07-16, mission-model.js:114): the daemon now projects a real
// eventCount for every SessionListEntry (both live via count-of-appended-events
// and persisted via SessionPersistence.countEvents). Persisted rows never fire
// applyEvent through this module — before the fix they rendered `0 ev` for
// every prior session after a daemon restart. Adopt the wire value here.
test('applySessionList adopts entry.eventCount so persisted rows show real totals', () => {
  const s = createMissionState()
  const persistedEntry = {
    sessionId: 'persisted-a',
    header: { version: 0, id: 'persisted-a', createdAt: 0 },
    title: 'Prior run',
    running: false,
    lastEventTime: 100,
    live: false, persisted: true,
    eventCount: 42,
  }
  applySessionList(s, [persistedEntry])
  assert.equal(s.sessions.get('persisted-a').eventCount, 42)
  const rows = projectTreeRows(s)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].eventCount, 42)
  // A refreshed snapshot with a bumped count adopts the new value (server is
  // authoritative for persisted rows between resumes).
  applySessionList(s, [{ ...persistedEntry, eventCount: 57 }])
  assert.equal(s.sessions.get('persisted-a').eventCount, 57)
  // Entries without eventCount (e.g., older daemon builds mid-rollout)
  // preserve the last known value rather than clobbering with 0.
  const { eventCount: _drop, ...noCount } = persistedEntry
  void _drop
  applySessionList(s, [noCount])
  assert.equal(s.sessions.get('persisted-a').eventCount, 57)
})
