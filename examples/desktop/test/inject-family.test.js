// Tests for src/renderer/inject-family.js (task #136). The pure
// classifier decides which of the eight §1.3 families a `context/message`
// (or compact-shadow `user/message`) lands in. Tests assert against the
// real wire shape from `fixtures/trace-samples/1.3-*.json` so the
// classifier stays faithful to daemon output — no idealized inputs
// (memory/multi-agent-shared-repo-rules.md rule #4).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { classifyInjectEvent, collapseRuns, FAMILIES } = require(
  '../src/renderer/inject-family.js',
)

function loadFixture(name) {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', name)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function firstOfType(events, type) {
  return events.find((e) => e && e.type === type)
}

test('family A — hooks-claude context/message on first turn', () => {
  const events = loadFixture('1.3-A-inject-session-start.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: true })
  assert.equal(result.family, 'A')
  assert.equal(result.plugin, 'hooks-claude')
  assert.equal(result.meta.kind, 'session-start')
  assert.equal(result.meta.icon, '>')
})

test('family A — hooks-* on non-first turn demotes to family B', () => {
  const ev = {
    type: 'context/message',
    seq: 900,
    time: 1,
    data: {
      content: [{ type: 'text', text: 're-injected CLAUDE.md' }],
      source: { kind: 'plugin', plugin: 'hooks-claude' },
    },
  }
  const result = classifyInjectEvent(ev, { isFirstTurn: false })
  assert.equal(result.family, 'B')
  assert.equal(result.plugin, 'hooks-claude')
})

test('family B — tool-bash mid-turn hint', () => {
  const events = loadFixture('1.3-B-inject-mid-plugin.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'B')
  assert.equal(result.plugin, 'tool-bash')
})

test('family C — time-context tick maps to time family regardless of turn', () => {
  const events = loadFixture('1.3-C-inject-time-tick.json')
  const ctx = firstOfType(events, 'context/message')
  const resA = classifyInjectEvent(ctx, { isFirstTurn: true })
  const resB = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(resA.family, 'C')
  assert.equal(resB.family, 'C')
  assert.equal(resA.meta.icon, '·')
})

test('family D — repeat-tool-guard by literal name', () => {
  const events = loadFixture('1.3-D-inject-guard.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'D')
  assert.equal(result.plugin, 'repeat-tool-guard')
})

test('family D — any *-guard sibling routes to guard family', () => {
  const ev = {
    type: 'context/message',
    seq: 10,
    time: 1,
    data: {
      content: [{ type: 'text', text: 'loop detected' }],
      source: { kind: 'plugin', plugin: 'loop-detect-guard' },
    },
  }
  const result = classifyInjectEvent(ev, { isFirstTurn: false })
  assert.equal(result.family, 'D')
  assert.equal(result.plugin, 'loop-detect-guard')
})

test('family E — compact plugin shadow user/message', () => {
  const events = loadFixture('1.3-E-inject-compact-shadow.json')
  const shadowUserMsg = firstOfType(events, 'user/message')
  assert.ok(shadowUserMsg, 'compact fixture must contain the shadow user/message')
  const result = classifyInjectEvent(shadowUserMsg, { isFirstTurn: false })
  assert.equal(result.family, 'E')
  assert.equal(result.plugin, 'compact')
  assert.equal(result.meta.kind, 'compact-shadow')
})

test('family F — user-approval policy change', () => {
  const events = loadFixture('1.3-F-inject-approval-policy.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'F')
  assert.equal(result.plugin, 'user-approval')
  assert.equal(result.meta.tone, 'danger')
})

test('family G — unknown plugins land in G/muted (task #141)', () => {
  const events = loadFixture('1.3-G-inject-unknown-plugin.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'G')
  assert.equal(result.plugin, 'acme-notifier')
  assert.equal(result.meta.tone, 'muted')
})

test('family B — runtime-advertised plugin (knownPlugins set) promotes G → B', () => {
  // Same fixture, but this time the daemon says the plugin IS mounted.
  const events = loadFixture('1.3-G-inject-unknown-plugin.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, {
    isFirstTurn: false,
    knownPlugins: new Set(['acme-notifier']),
  })
  assert.equal(result.family, 'B')
  assert.equal(result.plugin, 'acme-notifier')
  assert.equal(result.meta.tone, 'plugin')
})

test('family B — official first-party plugin (tool-bash) stays B without runtime hint', () => {
  const events = loadFixture('1.3-B-inject-mid-plugin.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'B')
  assert.equal(result.plugin, 'tool-bash')
  assert.equal(result.meta.tone, 'plugin')
})

test('knownPlugins accepts an array (not just a Set) for convenience', () => {
  const ev = {
    type: 'context/message',
    seq: 5,
    data: {
      content: [{ type: 'text', text: 'notice' }],
      source: { kind: 'plugin', plugin: 'acme-notifier' },
    },
  }
  const result = classifyInjectEvent(ev, {
    isFirstTurn: false,
    knownPlugins: ['acme-notifier', 'other-plugin'],
  })
  assert.equal(result.family, 'B')
})

test('family H — user-source context/message (skill include etc.)', () => {
  const events = loadFixture('1.3-H-inject-user.json')
  const ctx = firstOfType(events, 'context/message')
  const result = classifyInjectEvent(ctx, { isFirstTurn: false })
  assert.equal(result.family, 'H')
  assert.equal(result.plugin, null)
  assert.equal(result.meta.icon, '@')
})

test('non-inject events return null (assistant/message, tool/result)', () => {
  assert.equal(
    classifyInjectEvent({
      type: 'assistant/message',
      seq: 1,
      data: { content: [{ type: 'text', text: 'hi' }] },
    }),
    null,
  )
  assert.equal(
    classifyInjectEvent({
      type: 'tool/result',
      seq: 1,
      data: { content: [], callId: 'x' },
    }),
    null,
  )
})

test('malformed inputs return null instead of crashing', () => {
  assert.equal(classifyInjectEvent(null), null)
  assert.equal(classifyInjectEvent(undefined), null)
  assert.equal(classifyInjectEvent({}), null)
  assert.equal(classifyInjectEvent({ type: 'context/message' }), null)
  assert.equal(
    classifyInjectEvent({ type: 'context/message', data: { source: { kind: 'plugin' } } }),
    null,
  )
})

test('collapseRuns leaves runs of 1 or 2 alone', () => {
  const entries = [
    { family: 'A', event: {} },
    { family: 'A', event: {} },
    { family: 'B', event: {} },
  ]
  const out = collapseRuns(entries)
  assert.equal(out.length, 3)
  for (const row of out) assert.equal(row.kind, 'single')
})

test('collapseRuns folds ≥3 same-family in a row into a single run bucket', () => {
  const entries = [
    { family: 'A', event: { seq: 1 } },
    { family: 'A', event: { seq: 2 } },
    { family: 'A', event: { seq: 3 } },
    { family: 'B', event: { seq: 4 } },
  ]
  const out = collapseRuns(entries)
  assert.equal(out.length, 2)
  assert.equal(out[0].kind, 'run')
  assert.equal(out[0].family, 'A')
  assert.equal(out[0].entries.length, 3)
  assert.equal(out[1].kind, 'single')
  assert.equal(out[1].family, 'B')
})

test('collapseRuns preserves stream order across mixed runs', () => {
  const entries = [
    { family: 'A', event: { seq: 1 } },
    { family: 'A', event: { seq: 2 } },
    { family: 'A', event: { seq: 3 } },
    { family: 'A', event: { seq: 4 } },
    { family: 'B', event: { seq: 5 } },
    { family: 'C', event: { seq: 6 } },
    { family: 'C', event: { seq: 7 } },
    { family: 'C', event: { seq: 8 } },
  ]
  const out = collapseRuns(entries)
  assert.equal(out.length, 3)
  assert.equal(out[0].kind, 'run')
  assert.equal(out[0].family, 'A')
  assert.equal(out[0].entries.length, 4)
  assert.equal(out[1].kind, 'single')
  assert.equal(out[1].family, 'B')
  assert.equal(out[2].kind, 'run')
  assert.equal(out[2].family, 'C')
  assert.equal(out[2].entries.length, 3)
})

test('FAMILIES exports the eight expected keys', () => {
  assert.deepEqual(
    Object.keys(FAMILIES).sort(),
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
  )
})
