// fix/code-bugs-batch — locks the five fixes from review-code-bugs.md:
//   P0-2  artifacts-board.diffLines size guard (LCS OOM)
//   P1-2  chat-side-drawer.deriveTurnRows barge-in flush
//   P1-3  chat-refresh-throttle rAF coalescing
//   P1-4  artifacts.js history session scope
//   P1-5  rubric-fusion-model.loadFixture idempotence
//
// Each test asserts the invariant the fix locks; the fixtures deliberately
// exercise the exact failure mode the review flagged. See:
// /tmp/review-code-bugs.md (or the parent commit's report copy).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// -------------------------------------------------------------------------
// P0-2 — diffLines returns a note for oversized blobs and does not OOM.
// -------------------------------------------------------------------------
const board = require(path.join(ROOT, 'src/renderer/artifacts-board.js'))

test('P0-2: diffLines returns a note branch for 6000-line blobs (LCS guard)', () => {
  // 6000 lines each side = 36M grid cells => ~144MB Int32 without the guard.
  // Build the input as a single string join so we don't churn heap allocating
  // per-line strings.
  const bigA = new Array(6000).fill('line-a').join('\n')
  const bigB = new Array(6000).fill('line-b').join('\n')
  const started = Date.now()
  const result = board.diffLines(bigA, bigB)
  const elapsed = Date.now() - started
  // The guard should fire well under a second; the actual LCS grid would take
  // multiple seconds and hundreds of MB. Threshold generous for CI variance.
  assert.ok(elapsed < 1000, `guard should short-circuit; took ${elapsed}ms`)
  assert.ok(result && typeof result === 'object', 'result should be an object, not an array')
  assert.equal(typeof result.note, 'string', 'note branch should carry a string')
  assert.match(result.note, /too large/i, 'note text should call out size')
  assert.ok(!Array.isArray(result), 'note branch should not be an array (renderer distinguishes)')
})

test('P0-2: diffLines still computes real diff for small blobs (regression guard)', () => {
  const before = 'line-a\nline-b\nline-c'
  const after = 'line-a\nline-B\nline-c'
  const result = board.diffLines(before, after)
  assert.ok(Array.isArray(result), 'small-blob path stays as an array of line diffs')
  const kinds = result.map((ln) => ln.kind)
  assert.ok(kinds.includes('add') && kinds.includes('del'),
    'a line change should surface both add and del entries')
})

// -------------------------------------------------------------------------
// P1-2 — deriveTurnRows flushes the current turn when a user message
// (barge-in) or a second turn/start arrives before turn/end.
// -------------------------------------------------------------------------
const drawer = require(path.join(ROOT, 'src/renderer/chat-side-drawer.js'))

test('P1-2: barge-in user/message before turn/end seals current turn (interrupted)', () => {
  const events = [
    { type: 'user/message', seq: 1, data: { text: 'run task A' } },
    { type: 'turn/start', seq: 2, data: { turnId: 't0', model: 'r1' } },
    { type: 'assistant/message', seq: 3, data: { text: 'starting A' } },
    // Barge-in: user sends a second message before A's turn/end.
    { type: 'user/message', seq: 4, data: { text: 'stop, do B instead' } },
    { type: 'turn/start', seq: 5, data: { turnId: 't1', model: 'r1' } },
    { type: 'assistant/message', seq: 6, data: { text: 'switching to B' } },
    { type: 'turn/end', seq: 7, data: { turnId: 't1', usage: { total_tokens: 42 }, durationMs: 200 } },
  ]
  const rows = drawer.deriveTurnRows(events)
  const turns = rows.filter((r) => r.kind === 'turn')
  assert.equal(turns.length, 2, 'both turns must appear in history — A was not silently dropped')
  const [tA, tB] = turns
  assert.equal(tA.turnId, 't0')
  assert.equal(tA.interrupted, true,
    'the barged-in turn must be flagged interrupted so History renders it, not blank')
  // A's summary came from its assistant/message BEFORE the barge-in — must
  // survive the flush.
  assert.equal(tA.summary, 'starting A',
    'the old turn keeps its assistant summary; barge-in must not blank it')
  // B's tokens must NOT accrue onto A. Even though A never saw turn/end,
  // its tokens should remain 0 (unknown), and B's 42 must land on B.
  assert.equal(tA.tokens, 0, 'A gets no tokens attributed since it never sealed')
  assert.equal(tB.tokens, 42, 'B keeps its own token count intact')
})

test('P1-2: double turn/start without turn/end also seals the older turn', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turnId: 't0', model: 'r1' } },
    { type: 'assistant/message', seq: 2, data: { text: 'first response' } },
    // Second turn/start with no intervening turn/end. Should mark t0 as
    // interrupted rather than let its summary get overwritten.
    { type: 'turn/start', seq: 3, data: { turnId: 't1', model: 'r1' } },
    { type: 'turn/end', seq: 4, data: { turnId: 't1', usage: { total_tokens: 10 } } },
  ]
  const rows = drawer.deriveTurnRows(events)
  const turns = rows.filter((r) => r.kind === 'turn')
  assert.equal(turns.length, 2)
  assert.equal(turns[0].turnId, 't0')
  assert.equal(turns[0].summary, 'first response',
    'first turn keeps its summary — must not be clobbered by t1 push')
  assert.equal(turns[0].interrupted, true)
})

// -------------------------------------------------------------------------
// P1-3 — chat-refresh-throttle collapses multiple schedule() calls per
// rAF frame into a single callback invocation.
// -------------------------------------------------------------------------
const throttleMod = require(path.join(ROOT, 'src/renderer/chat-refresh-throttle.js'))

test('P1-3: rAF-coalesced throttle fires the callback once per frame regardless of N', () => {
  const rafQueue = []
  const raf = (cb) => { rafQueue.push(cb) }
  let fired = 0
  const t = throttleMod.create(() => { fired += 1 }, { raf })
  // 200 rapid-fire event calls, all inside a single "frame" (no rAF drain).
  for (let i = 0; i < 200; i++) t.schedule()
  assert.equal(fired, 0, 'no callback until the rAF drains')
  assert.equal(rafQueue.length, 1,
    '200 schedule calls must coalesce to a single rAF entry — long sessions ' +
    'used to hit O(N²) here')
  // Drain the frame — callback runs exactly once.
  const cb = rafQueue.shift()
  cb()
  assert.equal(fired, 1)
  // After the drain, the throttle should re-arm — a fresh schedule enqueues
  // a new rAF.
  t.schedule()
  assert.equal(rafQueue.length, 1)
})

// -------------------------------------------------------------------------
// P1-4 — artifacts.js history is bucketed per session. Session A's three
// versions must not appear in B's stream and must survive a switch back.
// The IIFE requires window / document / streamEl to be present; we stub a
// minimal DOM so the module can load.
// -------------------------------------------------------------------------
test('P1-4: artifact history is scoped per session (A→B→A shows only A)', () => {
  // Minimal DOM stub: getElementById returns null (streamEl access is
  // guarded), addEventListener no-ops, window.dsh is absent so the module
  // doesn't try to subscribe. document.readyState = 'complete' so the
  // module skips its DOMContentLoaded branch.
  const stubEl = {
    appendChild() {}, querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, classList: { add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {},
    isConnected: true, hidden: false,
    dataset: {}, style: {},
    remove() {}, cloneNode() { return this },
    dispatchEvent() {}, ownerDocument: null,
  }
  const stubDoc = {
    getElementById() { return null },
    createElement() { return { ...stubEl, children: [], append() {}, appendChild() {}, dataset: {} } },
    addEventListener() {},
    readyState: 'complete',
  }
  const oldWindow = global.window
  const oldDocument = global.document
  global.window = { addEventListener() {}, __dshArtifactsBoard: null }
  global.document = stubDoc
  // Fresh require — bust the cache so a prior test's window mutation doesn't
  // leak the singleton.
  const artifactsPath = path.join(ROOT, 'src/renderer/artifacts.js')
  delete require.cache[artifactsPath]
  require(artifactsPath)
  const api = global.window.__dshArtifacts
  assert.ok(api, 'artifacts module should have installed its window API')
  assert.equal(typeof api.setActiveSession, 'function',
    'session-scope fix must expose setActiveSession on the window API')

  // Session A: push three versions of foo.md.
  api.setActiveSession('sess-A')
  api.onArtifactEvent({ artifactId: 'foo.md', version: 1, kind: 'md', path: '/tmp/foo.md' })
  api.onArtifactEvent({ artifactId: 'foo.md', version: 2, kind: 'md', path: '/tmp/foo.md' })
  api.onArtifactEvent({ artifactId: 'foo.md', version: 3, kind: 'md', path: '/tmp/foo.md' })
  const aHistory = api.history.get('foo.md')
  assert.equal(aHistory.length, 3, 'session A should track its three versions')

  // Session B: push two versions of the same artifactId.
  api.setActiveSession('sess-B')
  const bBefore = api._bySession.get('sess-B').history.get('foo.md')
  assert.ok(!bBefore, "B's bucket should not inherit A's history")
  api.onArtifactEvent({ artifactId: 'foo.md', version: 1, kind: 'md', path: '/tmp/foo.md' })
  api.onArtifactEvent({ artifactId: 'foo.md', version: 2, kind: 'md', path: '/tmp/foo.md' })
  assert.equal(api.history.get('foo.md').length, 2, 'B should track only its own two versions')

  // Switch back to A — must still see A's three versions untouched.
  api.setActiveSession('sess-A')
  const aAgain = api.history.get('foo.md')
  assert.equal(aAgain.length, 3, 'A retains its three versions after B interleave')
  assert.deepEqual(aAgain.map((r) => r.version), [1, 2, 3])

  // Cleanup — restore globals so later tests get a clean slate.
  global.window = oldWindow
  global.document = oldDocument
})

// -------------------------------------------------------------------------
// P1-5 — rubric-fusion-model.loadFixture is idempotent even when the same
// singleton is seeded from three different pages.
// -------------------------------------------------------------------------
const fusion = require(path.join(ROOT, 'src/renderer/rubric-fusion-model.js'))

test('P1-5: loadFixture is idempotent — two consecutive seeds do not double events', () => {
  const store = fusion.create()
  const seed = {
    rubrics: [{
      id: 'r1', name: 'R1',
      dims: [{ id: 'd1', type: 'continuous', min: 0, max: 1 }],
    }],
    events: [
      { ts: 1000, rubricId: 'r1', dimId: 'd1', sessionId: 's1', turnId: 't1', rolloutIdx: 0, score: 0.8 },
      { ts: 2000, rubricId: 'r1', dimId: 'd1', sessionId: 's2', turnId: 't2', rolloutIdx: 0, score: 0.6 },
      { ts: 3000, rubricId: 'r1', dimId: 'd1', sessionId: 's3', turnId: 't3', rolloutIdx: 0, score: 0.9 },
    ],
  }
  store.loadFixture(seed)
  const first = store.listEvents().length
  assert.equal(first, 3, 'first seed should install all three events')

  // Second call with the same seed reference — WeakSet fast path.
  store.loadFixture(seed)
  assert.equal(store.listEvents().length, first,
    'same-ref reseed must not double the event count')

  // Deep-copied seed (different ref, same rows) — falls back to per-event
  // key dedupe. Still must not double.
  const seedCopy = JSON.parse(JSON.stringify(seed))
  store.loadFixture(seedCopy)
  assert.equal(store.listEvents().length, first,
    'fresh-ref seed with identical rows must dedupe by (ts,rubric,dim,session,turn,rollout) key')
})

test('P1-5: clearAll resets the fixture-loaded and event-key sets', () => {
  const store = fusion.create()
  const seed = {
    rubrics: [{ id: 'r1', name: 'R1', dims: [{ id: 'd1', type: 'continuous', min: 0, max: 1 }] }],
    events: [
      { ts: 1000, rubricId: 'r1', dimId: 'd1', sessionId: 's1', turnId: 't1', rolloutIdx: 0, score: 0.5 },
    ],
  }
  store.loadFixture(seed)
  assert.equal(store.listEvents().length, 1)
  store.clearAll()
  assert.equal(store.listEvents().length, 0)
  // After clearAll, a re-seed with the same ref must repopulate — the
  // dedupe cache is intentionally reset so users can start fresh.
  store.loadFixture(seed)
  assert.equal(store.listEvents().length, 1,
    'clearAll should reset both stores; a follow-up seed must repopulate')
})

// -------------------------------------------------------------------------
// Source-string sanity — the fix commits are present in the source (not
// merely the test file). Catches accidental revert during merge.
// -------------------------------------------------------------------------
test('sanity: fixes present in source (not just tests)', () => {
  const boardSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts-board.js'), 'utf8')
  assert.match(boardSrc, /n \* m > 1e6/, 'artifacts-board.js keeps the LCS size guard')

  const drawerSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/chat-side-drawer.js'), 'utf8')
  assert.match(drawerSrc, /Barge-in/, 'chat-side-drawer.js keeps the barge-in flush')

  const throttleSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/chat-refresh-throttle.js'), 'utf8')
  assert.match(throttleSrc, /coalesced/i, 'chat-refresh-throttle.js is present')

  const artifactsSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/artifacts.js'), 'utf8')
  assert.match(artifactsSrc, /bySession/, 'artifacts.js keeps the per-session buckets')

  const fusionSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/rubric-fusion-model.js'), 'utf8')
  assert.match(fusionSrc, /loadedFixtures/, 'rubric-fusion-model.js keeps the seed dedupe')
  assert.match(fusionSrc, /eventKeys/, 'rubric-fusion-model.js keeps the event-key dedupe')
})
