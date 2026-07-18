// Unit tests for plugin-runtime-fold.js — the pure fs-vs-runtime pairing that
// backs the Plugins tab's Runtime column. Kept in node:test because the module
// is dependency-free and doesn't need JSDOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { foldRuntime, normalize, healthSnapshot, healthPhrase, unknownReasonPhrase } = require('../src/renderer/plugin-runtime-fold.js')

test('normalize strips scope, relative-path, and separators', () => {
  assert.strictEqual(normalize('@deepseek-ai/dsh-bash-local'), 'bashlocal')
  assert.strictEqual(normalize('../echo-agent/src/mock-llm.ts'), 'mockllm')
  assert.strictEqual(normalize('SessionPersistenceJsonl'), 'sessionpersistencejsonl')
  assert.strictEqual(normalize(''), '')
  assert.strictEqual(normalize('@cordisjs/plugin-timer'), 'plugintimer')
})

test('foldRuntime returns rows with runtime=null when runtimePlugins is undefined', () => {
  const entries = [
    { id: 'a', name: '@deepseek-ai/dsh-bash-local', disabled: false, source: 'base' },
  ]
  const { rows, extras } = foldRuntime(entries, undefined)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].runtime, null)
  assert.deepStrictEqual(extras, [])
})

test('foldRuntime pairs on normalized specifier and reports active state', () => {
  const entries = [
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local', disabled: false, source: 'base' },
    { id: 'llm', name: '@deepseek-ai/dsh-llm-deepseek', disabled: false, source: 'base' },
  ]
  const runtime = [
    { name: 'BashLocal', state: 'active' },
    { name: 'llm-deepseek', state: 'active' },
  ]
  const { rows, extras } = foldRuntime(entries, runtime)
  assert.strictEqual(rows[0].runtime.state, 'active')
  assert.strictEqual(rows[0].runtime.mismatch, false)
  assert.strictEqual(rows[1].runtime.state, 'active')
  assert.strictEqual(rows[1].runtime.mismatch, false)
  assert.deepStrictEqual(extras, [])
})

test('foldRuntime flags "configured enabled but not loaded" when no runtime match', () => {
  const entries = [
    { id: 'ghost', name: '@example/dsh-not-a-thing', disabled: false, source: 'user' },
  ]
  const { rows } = foldRuntime(entries, [{ name: 'SomethingElse', state: 'active' }])
  assert.strictEqual(rows[0].runtime.state, 'absent')
  assert.strictEqual(rows[0].runtime.mismatch, true)
  assert.match(rows[0].runtime.reason, /configured enabled but not loaded/)
})

test('foldRuntime flags "disabled in overlay but still loaded" when runtime keeps a disabled plugin', () => {
  const entries = [
    { id: 'stale', name: '@deepseek-ai/dsh-bash-local', disabled: true, source: 'base' },
  ]
  const { rows } = foldRuntime(entries, [{ name: 'BashLocal', state: 'active' }])
  assert.strictEqual(rows[0].runtime.state, 'active')
  assert.strictEqual(rows[0].runtime.mismatch, true)
  assert.match(rows[0].runtime.reason, /disabled in overlay but still loaded/)
})

test('foldRuntime collects runtime plugins that no fs row claimed into extras', () => {
  const entries = [
    { id: 'bash', name: '@deepseek-ai/dsh-bash-local', disabled: false, source: 'base' },
  ]
  const runtime = [
    { name: 'BashLocal', state: 'active' },
    // The agent-spine bundle plugs the persistence/subagent stack under names
    // that don't appear in the user's cordis.yml — those become "extras",
    // which the UI paints as informational tail rows.
    { name: 'SessionPersistenceJsonl', state: 'active' },
    { name: 'SubagentService', state: 'active' },
  ]
  const { rows, extras } = foldRuntime(entries, runtime)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].runtime.state, 'active')
  assert.strictEqual(extras.length, 2)
  const extraNames = extras.map((e) => e.name).sort()
  assert.deepStrictEqual(extraNames, ['SessionPersistenceJsonl', 'SubagentService'])
})

test('foldRuntime treats pending state as not-yet-a-mismatch', () => {
  const entries = [
    { id: 'waiting', name: '@example/dsh-waiting-on-injection', disabled: false, source: 'user' },
  ]
  const { rows } = foldRuntime(entries, [{ name: 'waiting-on-injection', state: 'pending' }])
  assert.strictEqual(rows[0].runtime.state, 'pending')
  // Pending is legal — the plugin is waiting on an inject, not a mismatch.
  assert.strictEqual(rows[0].runtime.mismatch, false)
})

test('foldRuntime flags a failed runtime state for an enabled row', () => {
  const entries = [
    { id: 'boom', name: '@example/dsh-broken', disabled: false, source: 'user' },
  ]
  const { rows } = foldRuntime(entries, [{ name: 'broken', state: 'failed' }])
  assert.strictEqual(rows[0].runtime.state, 'failed')
  assert.strictEqual(rows[0].runtime.mismatch, true)
  assert.match(rows[0].runtime.reason, /runtime is failed/)
})

// B-P0-1 (2026-07-16): the diagnostics strip used to shout "Configuration
// OK" while every runtime row underneath showed absent. healthSnapshot +
// healthPhrase pin the layered "5 enabled · 3 running · 2 not loaded"
// phrasing the team-lead ruling nailed down.

test('healthSnapshot: no runtime yet → unknown with expected count preserved', () => {
  const fold = {
    rows: [
      { id: 'a', name: 'a', disabled: false, source: 'base', runtime: null },
      { id: 'b', name: 'b', disabled: false, source: 'base', runtime: null },
    ],
  }
  const snap = healthSnapshot(fold)
  assert.strictEqual(snap.status, 'unknown')
  assert.strictEqual(snap.expected, 2)
  assert.strictEqual(snap.active, 0)
})

test('healthSnapshot: all enabled rows active → status=active, running=expected', () => {
  const fold = {
    rows: [
      { id: 'a', disabled: false, runtime: { state: 'active' } },
      { id: 'b', disabled: false, runtime: { state: 'loading' } },
      { id: 'c', disabled: true, runtime: null }, // disabled row is not counted
    ],
  }
  const snap = healthSnapshot(fold)
  assert.deepStrictEqual(snap, {
    status: 'active', expected: 2, active: 2, pending: 0, notLoaded: 0,
  })
})

test('healthSnapshot: some absent → partial, counters split into buckets', () => {
  const fold = {
    rows: [
      { id: 'a', disabled: false, runtime: { state: 'active' } },
      { id: 'b', disabled: false, runtime: { state: 'active' } },
      { id: 'c', disabled: false, runtime: { state: 'active' } },
      { id: 'd', disabled: false, runtime: { state: 'pending' } },
      { id: 'e', disabled: false, runtime: { state: 'absent' } },
    ],
  }
  const snap = healthSnapshot(fold)
  assert.strictEqual(snap.status, 'partial')
  assert.strictEqual(snap.expected, 5)
  assert.strictEqual(snap.active, 3)
  assert.strictEqual(snap.pending, 1)
  assert.strictEqual(snap.notLoaded, 1)
})

test('healthPhrase: layered wording drops zero buckets', () => {
  assert.strictEqual(
    healthPhrase({ status: 'active', expected: 5, active: 5, pending: 0, notLoaded: 0 }),
    '5 enabled · 5 running',
  )
  assert.strictEqual(
    healthPhrase({ status: 'partial', expected: 5, active: 3, pending: 0, notLoaded: 2 }),
    '5 enabled · 3 running · 2 not loaded',
  )
  assert.strictEqual(
    healthPhrase({ status: 'partial', expected: 5, active: 2, pending: 1, notLoaded: 2 }),
    '5 enabled · 2 running · 1 waiting · 2 not loaded',
  )
})

test('healthPhrase: unknown status keeps expected in the message when non-zero', () => {
  assert.strictEqual(
    healthPhrase({ status: 'unknown', expected: 3, active: 0, pending: 0, notLoaded: 0 }),
    '3 enabled · runtime status unknown',
  )
  assert.strictEqual(
    healthPhrase({ status: 'unknown', expected: 0, active: 0, pending: 0, notLoaded: 0 }),
    'runtime status unknown',
  )
})

test('healthPhrase: mismatch (running < enabled) never renders as OK', () => {
  // Regression pin for B-P0-1: the strip shouted "Configuration OK" while
  // every row said absent. Phrase must always name the mismatch.
  const snap = healthSnapshot({
    rows: [
      { id: 'a', disabled: false, runtime: { state: 'absent' } },
      { id: 'b', disabled: false, runtime: { state: 'absent' } },
    ],
  })
  assert.strictEqual(snap.status, 'partial')
  const phrase = healthPhrase(snap)
  assert.doesNotMatch(phrase, /ok/i)
  assert.match(phrase, /not loaded/)
})

// QA round-3 shot 07 regression pins (2026-07-16):
// stdio profiles hit `plugins:listRuntime` with no supervisor to ask, so
// main-side returns `{supported:false, reason:'no-daemon'}`. The strip
// used to compute a fold-based phrase and misread the empty runtime as
// "0/5 mounted"; now it must show the specific unavailability message.

test('unknownReasonPhrase: no-daemon reason wins over generic snapshot', () => {
  const snap = healthSnapshot({
    rows: [
      { id: 'a', disabled: false, runtime: { state: 'absent' } },
      { id: 'b', disabled: false, runtime: { state: 'absent' } },
    ],
  })
  // Even if the caller managed to build a partial snapshot, if the runtime
  // reason is `no-daemon` we surface that — the fold numbers are noise on
  // a profile that never has a runtime to reconcile against.
  const phrase = unknownReasonPhrase(snap, { supported: false, reason: 'no-daemon' })
  assert.strictEqual(phrase, 'runtime state unavailable (no daemon on this profile)')
})

test('unknownReasonPhrase: no-daemon renders regardless of snapshot shape', () => {
  const phrase = unknownReasonPhrase(
    { status: 'unknown', expected: 0, active: 0, pending: 0, notLoaded: 0 },
    { supported: false, reason: 'no-daemon' },
  )
  assert.strictEqual(phrase, 'runtime state unavailable (no daemon on this profile)')
  // Regression guard against the earlier phrasing.
  assert.doesNotMatch(phrase, /mounted/i)
  assert.doesNotMatch(phrase, /0\/\d/) // "0/5 mounted"-style should be gone
})

test('unknownReasonPhrase: MethodNotFound gets its own line', () => {
  const phrase = unknownReasonPhrase(
    { status: 'unknown', expected: 3, active: 0, pending: 0, notLoaded: 0 },
    { supported: false, reason: 'MethodNotFound' },
  )
  assert.strictEqual(phrase, 'runtime state unavailable (daemon does not implement plugins/list)')
})

test('unknownReasonPhrase: fresh boot (no reason) falls back to snapshot + hint', () => {
  const phrase = unknownReasonPhrase(
    { status: 'unknown', expected: 4, active: 0, pending: 0, notLoaded: 0 },
    null,
  )
  assert.match(phrase, /4 enabled · runtime status unknown \(Test boot to check\)/)
})

test('unknownReasonPhrase: unknown reason string treated as generic (not misclassified)', () => {
  const phrase = unknownReasonPhrase(
    { status: 'unknown', expected: 2, active: 0, pending: 0, notLoaded: 0 },
    { supported: false, reason: 'unexpected wire error' },
  )
  // Preserve the fallback hint; do NOT expose the raw reason (it's a wire
  // string not curated for end users).
  assert.match(phrase, /Test boot to check/)
  assert.doesNotMatch(phrase, /unexpected wire error/)
})
