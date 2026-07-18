// Ticket B (task #124) — phantom-header pinning tests.
//
// Backstory (docs/tickets/ticket-B-phantom-header.md + docs/capability-frontend-audit.md §1.6):
// `SessionHeader` on the wire (packages/core/session/src/types.ts:29-49)
// actually ships only 6 fields — `version / id / createdAt / cwd? /
// parentSession? / seedLength?` — but the shell used to read 7 phantom
// fields that only exist in demo mocks. Real daemons return `undefined`
// for every phantom, and the audit's §1.6 concluded the tests never
// noticed because fixtures were hand-shaped to whatever the read site
// wanted (rule #4 of memory/multi-agent-shared-repo-rules.md — the very
// bug this file exists to prevent).
//
// This file's job is the wire-shape pinning gate: fixtures MUST match
// the real daemon's `Object.keys(header)` output exactly, so future code
// can't sneak a new phantom read back in by re-hand-shaping a fixture.
//
// If Ticket A (task #123) lands and adds `title / model / originKind`
// to the wire, extend WIRE_HEADER_KEYS below to match. Do NOT add
// mock-only keys.
//
// Runs under `node --test` — no DOM, no daemon.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildSessionTree,
  findChildForks,
  classifySessionShape,
} = require('../src/renderer/session-tree.js')

// The canonical wire header shape as verified by CDP on port 9224
// (docs/capability-frontend-audit.md §1.6 CDP verification cell).
// Optional fields listed for completeness; presence is not required
// (e.g. a root session has no `parentSession`).
const WIRE_HEADER_REQUIRED = ['version', 'id', 'createdAt']
const WIRE_HEADER_OPTIONAL = ['cwd', 'parentSession', 'seedLength']
const WIRE_HEADER_ALLOWED = new Set([...WIRE_HEADER_REQUIRED, ...WIRE_HEADER_OPTIONAL])

// After Ticket A (#123) lands, add: 'title', 'model'. After Ticket B-1
// (S-class, this Ticket) lands: 'originKind'. Keep this comment in sync so
// the fixture reviewer knows what to expand.

// Real-shape fixture factory. Any test that asserts against the tree
// helpers should build entries with this so the pinning tests below stay
// meaningful — a fixture that adds keys via ad-hoc `header: { foo: 1 }`
// merges bypasses the gate.
function wireEntry(id, opts = {}) {
  const header = {
    version: 0,
    id,
    createdAt: opts.createdAt || 0,
  }
  if (opts.cwd !== undefined) header.cwd = opts.cwd
  if (opts.parent !== undefined) {
    // The wire shape for `parentSession` is `{ id, seq }`, NOT bare string
    // and NOT `{ sessionId, seq }`. See types.ts:44.
    header.parentSession = typeof opts.parent === 'string'
      ? { id: opts.parent, seq: opts.parentSeq || 0 }
      : opts.parent
  }
  if (opts.seedLength !== undefined) header.seedLength = opts.seedLength
  return {
    sessionId: id,
    header,
    live: opts.live !== false,
    persisted: opts.persisted === true,
    running: opts.running === true,
    lastEventTime: opts.lastEventTime || 0,
  }
}

// -- B-7/B-8/B-9 pinning: every wireEntry must expose exactly the allowed keys.

test('B-7/8/9: wireEntry header contains only wire-truth keys (no phantoms)', () => {
  const entry = wireEntry('sess-abc', {
    cwd: '/tmp/proj',
    parent: 'sess-root',
    parentSeq: 42,
    seedLength: 42,
  })
  const keys = Object.keys(entry.header)
  for (const k of keys) {
    assert.ok(
      WIRE_HEADER_ALLOWED.has(k),
      `phantom key on header: "${k}" is not one of ${[...WIRE_HEADER_ALLOWED].join('/')}`,
    )
  }
  // Required keys always present.
  for (const k of WIRE_HEADER_REQUIRED) {
    assert.ok(keys.includes(k), `required wire key missing: ${k}`)
  }
})

test('B-8 shape: parentSession is { id, seq }, not bare string, not { sessionId }', () => {
  // Real bug we are guarding against: fixtures used to say
  //   header: { parentSession: 'parent-id' }
  // which happened to work because buildSessionTree/findChildForks were also
  // written to consume the string form. Wire truth (types.ts:44) is
  // `{ id: SessionId, seq: number }`. If a fixture regresses to the bare
  // string form, the mock will silently drift from the real daemon again.
  const entry = wireEntry('child', { parent: 'root', parentSeq: 3 })
  assert.equal(typeof entry.header.parentSession, 'object')
  assert.equal(entry.header.parentSession.id, 'root')
  assert.equal(entry.header.parentSession.seq, 3)
  assert.equal(entry.header.parentSession.sessionId, undefined,
    'parentSession must use `id` (not `sessionId`) per types.ts:44')
})

test('B-9 shape: seedLength is present on fork children, absent on user-created sessions', () => {
  const forkChild = wireEntry('child', { parent: 'root', parentSeq: 41, seedLength: 42 })
  const rootUser = wireEntry('root')
  assert.equal(typeof forkChild.header.seedLength, 'number')
  assert.equal(rootUser.header.seedLength, undefined,
    'user-created sessions never have seedLength — see types.ts:49')
})

// -- session-tree.js consumers must handle the real wire shape correctly.

test('B-8 consumer: buildSessionTree links parent/child using { id, seq } shape', () => {
  const list = [
    wireEntry('a'),
    wireEntry('b', { parent: 'a', parentSeq: 5, seedLength: 5 }),
    wireEntry('c', { parent: 'a', parentSeq: 8, seedLength: 8 }),
  ]
  // NOTE: as of Ticket B (#124), session-tree.js reads parentSession as if
  // it were a bare string ("parent !== parentSessionId"). The real wire
  // shape is `{ id, seq }`. This test asserts the fix: consumers unwrap
  // `.id` before comparing.
  const tree = buildSessionTree(list)
  assert.equal(tree.length, 1, 'a is the only root; b & c hang off it')
  const rootA = tree[0]
  assert.equal(rootA.entry.sessionId, 'a')
  const childIds = rootA.children.map((c) => c.entry.sessionId).sort()
  assert.deepEqual(childIds, ['b', 'c'])
})

test('B-8 consumer: findChildForks matches parentSession.id against parentSessionId', () => {
  const list = [
    wireEntry('parent'),
    wireEntry('child-a', { parent: 'parent', parentSeq: 3, seedLength: 4 }),
    wireEntry('child-b', { parent: 'parent', parentSeq: 6, seedLength: 7 }),
    wireEntry('other', { parent: 'someone-else', parentSeq: 0 }),
  ]
  const forks = findChildForks('parent', list)
  assert.equal(forks.length, 2)
  assert.deepEqual(
    forks.map((f) => ({ id: f.childSessionId, seq: f.forkSeq })).sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'child-a', seq: 3 },
      { id: 'child-b', seq: 6 },
    ],
  )
})

// -- B-4/B-5 (interrupted/lastError) consolidation on classifySessionShape.

test('B-4/5 classifySessionShape treats meta.lastError with kind !== "ok" as interrupted', () => {
  // Wire truth: `SessionFinishedNotification.reason` is a `TurnEndReason`
  // (types.ts:94-120) whose kind is one of `ok / cancelled / error / stopped`.
  // Any non-ok reason should read as ✕ (interrupted) — B-5 (cancelled) and
  // B-4 (error) share the same visual affordance.
  const errored = { sessionId: 'e', meta: { lastError: { kind: 'error', message: 'oops' } } }
  const cancelled = { sessionId: 'c', meta: { lastError: { kind: 'cancelled', reason: 'user' } } }
  const ok = { sessionId: 'o', meta: { lastError: { kind: 'ok' } } }
  assert.equal(classifySessionShape(errored).role, 'interrupted')
  assert.equal(classifySessionShape(cancelled).role, 'interrupted')
  assert.equal(classifySessionShape(ok).role, 'idle',
    'kind:"ok" is a successful finish — should NOT trigger interrupted glyph')
})

test('B-4/5 classifySessionShape: clean session (no meta.lastError) stays idle', () => {
  const clean = { sessionId: 'x' }
  assert.equal(classifySessionShape(clean).role, 'idle')
})

// -- B-1 (originKind) fallback behaviour: fork glyph when originKind absent.

test('B-1 originKind: absent → falls back to fork classification (safe for old daemons)', () => {
  // Ticket A + B-1 will add `originKind: 'user'|'subagent'|'fork'` to
  // SessionHeader. Before that lands, `originKind` is undefined and the
  // classifier must still work: if `parentSession` is set, it's a fork
  // (subagent info is lost but the row still shows the right shape).
  const child = { sessionId: 'c', header: { parentSession: { id: 'p', seq: 0 } } }
  const shape = classifySessionShape(child)
  assert.equal(shape.role, 'fork',
    'no originKind → fork fallback per docs/tickets/ticket-B-phantom-header.md B-1')
})

test('B-1 originKind: subagent value → subagent classification', () => {
  const subagent = {
    sessionId: 'c',
    header: { parentSession: { id: 'p', seq: 0 }, originKind: 'subagent' },
  }
  assert.equal(classifySessionShape(subagent).role, 'subagent')
})

// -- Documentation cross-check: the audit-corrected phantom count.

test('audit-correction: config.model is not a shell read site anymore', () => {
  // This is a documentation pinning: docs/tickets/ticket-B-phantom-header.md
  // §B-6 removed `header.config.model` from the phantom list because the
  // shell has zero readers. If a new reader appears, this test flips and
  // forces us to re-classify it (add to a bucket rather than let it slide
  // into another phantom).
  const fs = require('node:fs')
  const path = require('node:path')
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer')
  const files = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js'))
  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(path.join(rendererDir, f), 'utf8')
    // Match `header.config` or `entry.header.config` — this is a phantom
    // path that has never existed on the wire. `entry.config` (without the
    // `header.` prefix) is unrelated (part of setSessionConfig round-trip).
    if (/header\.config\b/.test(src)) offenders.push(f)
  }
  assert.deepEqual(offenders, [],
    `header.config is a phantom read path; found in: ${offenders.join(', ')}. ` +
    'If you meant to read model config, use the wire path from Ticket A instead.')
})

// -- D: usageFraction has no phantom fallback anymore (B-3).

test('B-3 usageFraction: session-tree-page must not fall back to header.usageFraction', () => {
  // Wire never shipped `header.usageFraction`. The tracker
  // (context-meter.js) is the sole source; the previous fallback was dead
  // code that only fired on hand-shaped mocks. Delete of that fallback is
  // enforced here so a future PR doesn't reintroduce it.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'session-tree-page.js'),
    'utf8',
  )
  assert.doesNotMatch(src, /header\.usageFraction/,
    'session-tree-page.js must not read header.usageFraction — the tracker is the sole source')
})

// -- D: interrupted alias is retired in favor of meta.lastError (B-5).

test('B-5 interrupted alias retired: session-tree.js reads meta.lastError only', () => {
  // Historical: `session-tree.js:202` checked `header.lastError ||
  // header.interrupted || entry.interrupted`. `header.interrupted` was
  // never a wire field; `entry.interrupted` was a mock convenience. Both
  // are gone as of Ticket B-5, replaced by the derived `meta.lastError`
  // (whose `kind !== 'ok'` covers both error and cancelled).
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'session-tree.js'),
    'utf8',
  )
  assert.doesNotMatch(src, /header\.interrupted/,
    'session-tree.js must not read header.interrupted — see Ticket B §B-5')
  assert.doesNotMatch(src, /entry\.interrupted\b/,
    'session-tree.js must not read entry.interrupted — see Ticket B §B-5')
})
