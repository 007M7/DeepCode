// context-meter unit tests. Runs under `node --test`, no Electron / DOM.
//
// The module is pure by design — no `document`, no `window`, no timers —
// so we exercise it directly against synthetic session events shaped like
// the ones renderer.js hands it. See src/renderer/context-meter.js for the
// mode / threshold contract.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

// Delete require-cache each load so the module-under-test's `if (typeof
// window)` guard doesn't leak state across cases (only the CommonJS branch
// runs under node:test, but future edits could add a persistent module var).
function load() {
  const p = require.resolve(path.resolve(__dirname, '..', 'src', 'renderer', 'context-meter.js'))
  delete require.cache[p]
  return require(p)
}

test('levelForFraction: threshold ladder', () => {
  const { levelForFraction } = load()
  assert.equal(levelForFraction(0), 'nominal')
  assert.equal(levelForFraction(0.49), 'nominal')
  assert.equal(levelForFraction(0.5), 'warn')
  assert.equal(levelForFraction(0.79), 'warn')
  assert.equal(levelForFraction(0.8), 'high')
  assert.equal(levelForFraction(0.94), 'high')
  assert.equal(levelForFraction(0.95), 'critical')
  assert.equal(levelForFraction(2.0), 'critical')
  // Non-finite defaults to nominal so a bad denominator can't nuke the UI
  // (e.g. budget=0 → division would go infinite; we'd rather fall silent
  // than flash critical over an accounting bug).
  assert.equal(levelForFraction(NaN), 'nominal')
  assert.equal(levelForFraction(Infinity), 'nominal')
})

test('createTracker: initial snapshot is empty + approx', () => {
  const { createTracker } = load()
  const t = createTracker()
  const s = t.snapshot()
  assert.equal(s.tokens, 0)
  assert.equal(s.mode, 'approx')
  assert.equal(s.level, 'nominal')
  assert.equal(s.eventCount, 0)
  assert.equal(s.lastCompactTokens, null)
  assert.equal(s.budget, 128000)
})

test('createTracker: approx mode accumulates byte-based tokens', () => {
  const { createTracker } = load()
  const t = createTracker()
  // ~40 chars payload → ~10 pseudo-tokens.
  t.ingest({ type: 'user/message', data: { content: 'x'.repeat(40) } })
  const s = t.snapshot()
  assert.equal(s.mode, 'approx')
  assert.ok(s.tokens >= 10, `expected tokens >= 10, got ${s.tokens}`)
  assert.equal(s.eventCount, 1)
})

test('createTracker: assistant/message.usage flips mode to precise', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest({ type: 'user/message', data: { content: 'hello' } })
  t.ingest({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: 'hi' }], usage: { inputTokens: 100, outputTokens: 50 } },
  })
  const s = t.snapshot()
  assert.equal(s.mode, 'precise')
  assert.equal(s.tokens, 150)
})

test('createTracker: subsequent assistant/message updates the precise total', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest({ type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50 } } })
  t.ingest({ type: 'assistant/message', data: { usage: { inputTokens: 200, outputTokens: 80 } } })
  const s = t.snapshot()
  assert.equal(s.tokens, 280)
  assert.equal(s.mode, 'precise')
})

test('createTracker: assistant/message without usage keeps approx mode', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'no usage report' }] } })
  const s = t.snapshot()
  assert.equal(s.mode, 'approx')
  assert.ok(s.tokens > 0)
})

test('createTracker: compact/summary records shadowedTokenCount, clamps approx down', () => {
  const { createTracker } = load()
  const t = createTracker()
  // Grow the approx tally past a known amount, then compact.
  t.ingest({ type: 'user/message', data: { content: 'x'.repeat(4000) } })
  const before = t.snapshot()
  assert.ok(before.tokens > 0)
  t.ingest({
    type: 'compact/summary',
    data: { summary: [], shadowedRange: {start:0, end:1}, shadowedSeqs: [], shadowedTokenCount: 800, model: 'mock' },
  })
  const after = t.snapshot()
  assert.equal(after.lastCompactTokens, 800)
  // Approx should have subtracted shadowedTokenCount × 4 bytes; clamped at 0.
  assert.ok(after.tokens <= before.tokens, 'compact should not increase approx tokens')
})

test('createTracker: compact/summary in precise mode records the count but leaves precise total intact', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest({ type: 'assistant/message', data: { usage: { inputTokens: 900, outputTokens: 100 } } })
  t.ingest({
    type: 'compact/summary',
    data: { shadowedTokenCount: 400, model: 'mock' },
  })
  const s = t.snapshot()
  assert.equal(s.mode, 'precise')
  assert.equal(s.tokens, 1000, 'precise total should wait for the next assistant/message.usage')
  assert.equal(s.lastCompactTokens, 400)
})

test('createTracker: budget override propagates through fraction + level', () => {
  const { createTracker } = load()
  const t = createTracker({ budgetTokens: 1000 })
  t.ingest({ type: 'assistant/message', data: { usage: { inputTokens: 800, outputTokens: 50 } } })
  const s = t.snapshot()
  assert.equal(s.budget, 1000)
  assert.equal(s.tokens, 850)
  assert.equal(s.level, 'high') // 850/1000 = 0.85 → high
})

test('createTracker: reset clears all state', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest({ type: 'assistant/message', data: { usage: { inputTokens: 500, outputTokens: 100 } } })
  t.ingest({ type: 'compact/summary', data: { shadowedTokenCount: 100, model: 'mock' } })
  t.reset()
  const s = t.snapshot()
  assert.equal(s.tokens, 0)
  assert.equal(s.mode, 'approx')
  assert.equal(s.eventCount, 0)
  assert.equal(s.lastCompactTokens, null)
})

test('createTracker: ignores non-object events safely', () => {
  const { createTracker } = load()
  const t = createTracker()
  t.ingest(null)
  t.ingest(undefined)
  t.ingest('nope')
  t.ingest(42)
  const s = t.snapshot()
  assert.equal(s.tokens, 0)
  assert.equal(s.eventCount, 0)
})

test('usageTokensFromEvent: returns null on missing/malformed usage', () => {
  const { usageTokensFromEvent } = load()
  assert.equal(usageTokensFromEvent(null), null)
  assert.equal(usageTokensFromEvent({ type: 'user/message' }), null)
  assert.equal(usageTokensFromEvent({ type: 'assistant/message' }), null)
  assert.equal(usageTokensFromEvent({ type: 'assistant/message', data: {} }), null)
  assert.equal(usageTokensFromEvent({ type: 'assistant/message', data: { usage: {} } }), null)
  // Partial usage still counts.
  assert.equal(
    usageTokensFromEvent({ type: 'assistant/message', data: { usage: { inputTokens: 10 } } }),
    10,
  )
})

test('estimateEventBytes: JSON-serializable + safe on cyclic', () => {
  const { estimateEventBytes } = load()
  assert.ok(estimateEventBytes({ data: { text: 'hello' } }) > 0)
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(estimateEventBytes({ data: cyclic }), 0)
  assert.equal(estimateEventBytes(null), 0)
})

// -- P0-2 (budgetSource + setBudget + contextWindowFromEntry) --------------
//
// The renderer distinguishes "the wire told us this model's real context
// window" from "we're guessing at 128k default", so a user with a 32k
// model never sees "5k / 128k" and thinks they have headroom they don't.
// The three tests below pin the classifier's three moving parts.

test('createTracker: default budget snapshot exposes budgetSource: "assumed"', () => {
  const { createTracker } = load()
  const t = createTracker()
  const s = t.snapshot()
  assert.equal(s.budget, 128000, 'default budget still 128000 as fallback')
  assert.equal(s.budgetSource, 'assumed',
    'no explicit budgetTokens → source is "assumed"; UI must not pretend precision')
})

test('createTracker: explicit budgetTokens marks source "server"', () => {
  const { createTracker } = load()
  const t = createTracker({ budgetTokens: 32000 })
  const s = t.snapshot()
  assert.equal(s.budget, 32000)
  assert.equal(s.budgetSource, 'server',
    'explicit budgetTokens comes from the wire — mark as authoritative')
})

test('createTracker.setBudget: server → assumed → server round-trip', () => {
  const { createTracker } = load()
  const t = createTracker()
  // Start assumed.
  assert.equal(t.snapshot().budgetSource, 'assumed')
  // Promote when the wire delivers a real number.
  t.setBudget(32000)
  assert.equal(t.snapshot().budget, 32000)
  assert.equal(t.snapshot().budgetSource, 'server')
  // Clear back to fallback if the shell loses the field (profile switch
  // to a daemon that doesn't project it).
  t.setBudget(null)
  assert.equal(t.snapshot().budget, 128000)
  assert.equal(t.snapshot().budgetSource, 'assumed')
  t.setBudget(0)
  assert.equal(t.snapshot().budgetSource, 'assumed', 'non-positive treated as clear')
  t.setBudget(NaN)
  assert.equal(t.snapshot().budgetSource, 'assumed')
})

test('contextWindowFromEntry: reads nested header.model.contextWindow', () => {
  const { contextWindowFromEntry } = load()
  const entry = {
    sessionId: 'x',
    header: { model: { contextWindow: 32000 } },
  }
  assert.equal(contextWindowFromEntry(entry), 32000)
})

test('contextWindowFromEntry: reads flat entry.contextWindow (wire variant)', () => {
  const { contextWindowFromEntry } = load()
  assert.equal(contextWindowFromEntry({ sessionId: 'x', contextWindow: 65536 }), 65536)
})

test('contextWindowFromEntry: prefers nested over flat when both present', () => {
  const { contextWindowFromEntry } = load()
  const entry = {
    sessionId: 'x',
    header: { model: { contextWindow: 32000 } },
    contextWindow: 99999,
  }
  assert.equal(contextWindowFromEntry(entry), 32000, 'nested descriptor wins over flat')
})

test('contextWindowFromEntry: null when entry lacks the field (never derive from name)', () => {
  // P0-2 red-line — "不许从模型名反查". No inference from `entry.model` or
  // similar; only accept the wire's explicit number. Return null so the
  // caller stays on the assumed default rather than fabricating a value.
  const { contextWindowFromEntry } = load()
  assert.equal(contextWindowFromEntry({ sessionId: 'x' }), null)
  assert.equal(contextWindowFromEntry({ sessionId: 'x', header: {} }), null)
  assert.equal(contextWindowFromEntry({ sessionId: 'x', header: { model: { name: 'deepseek-v4' } } }),
    null, 'model name alone must not resolve — only a real contextWindow number')
  assert.equal(contextWindowFromEntry({ sessionId: 'x', model: { name: 'deepseek-chat' } }), null,
    'top-level model.name alone must not fabricate a window either')
  assert.equal(contextWindowFromEntry({ sessionId: 'x', contextWindow: 0 }), null)
  assert.equal(contextWindowFromEntry({ sessionId: 'x', contextWindow: -100 }), null)
  assert.equal(contextWindowFromEntry(null), null)
  assert.equal(contextWindowFromEntry(undefined), null)
})

test('contextWindowFromEntry: reads the top-level daemon model projection first', () => {
  // The daemon's session-query projection now ships a top-level
  // `entry.model.contextWindow` (live sessions only, sourced from the
  // mounted ctx.compact.config). That takes priority over the phantom
  // header shape and the flat wire variant so shells see the same
  // authoritative budget across all three surface variants.
  const { contextWindowFromEntry } = load()
  const projectedOnly = { sessionId: 's', model: { name: 'deepseek-chat', contextWindow: 128000 } }
  assert.equal(contextWindowFromEntry(projectedOnly), 128000)
  // Priority: top-level projection beats nested header AND flat field.
  const mixed = {
    sessionId: 's',
    model: { name: 'live-model', contextWindow: 128000 },
    header: { model: { contextWindow: 32000 } },
    contextWindow: 99999,
  }
  assert.equal(contextWindowFromEntry(mixed), 128000, 'top-level projection wins')
})

test('modelNameFromEntry: reads name from projection, then phantom header, else null', () => {
  // Symmetric with contextWindowFromEntry: never fabricate. Projection
  // wins; the phantom-header shape is retained only for shells still
  // consuming the pre-projection wire. Empty strings and missing entries
  // both collapse to null so the header chip renders "unknown" (or
  // omits the chip) rather than an empty pill.
  const { modelNameFromEntry } = load()
  assert.equal(modelNameFromEntry({ sessionId: 's', model: { name: 'deepseek-chat' } }), 'deepseek-chat')
  assert.equal(modelNameFromEntry({
    sessionId: 's',
    model: { name: 'projected' },
    header: { model: { name: 'phantom' } },
  }), 'projected', 'projection wins over phantom')
  assert.equal(modelNameFromEntry({ sessionId: 's', header: { model: { name: 'legacy-name' } } }), 'legacy-name')
  assert.equal(modelNameFromEntry({ sessionId: 's', model: { name: '' } }), null,
    'empty string is not a name — omit the chip')
  assert.equal(modelNameFromEntry({ sessionId: 's' }), null)
  assert.equal(modelNameFromEntry({ sessionId: 's', header: {} }), null)
  assert.equal(modelNameFromEntry(null), null)
  assert.equal(modelNameFromEntry(undefined), null)
})
