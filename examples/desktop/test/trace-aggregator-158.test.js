// Task #158: trace-aggregator additions for cost / TTFT / provider / metadata.
// These helpers are the wire-side derivations the L1 render pulls; the L1
// pane itself is asserted in a companion renderer test file.
//
// Zero-discard contract (memory dsh-product-strategy-2026-07-16, density-spec §3):
//   - cost:      returned display always renders — either `$0.0042` or `$?`
//                (no price table), never blank.
//   - TTFT:      derived only from the first assistant/chunk timestamp minus
//                step.startTime; null if the step has no chunks (still shown
//                as `absent` in L1, but the helper returns null).
//   - provider:  read from header.config.provider first, then header.provider
//                (some daemons ship it flat); null when both absent — renderer
//                will label it "inferred".
//   - meta:      flat kv list from event.data.meta, minus keys the tool card
//                already consumes (card, durationMs, isError).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TA = require('../src/renderer/trace-aggregator.js')

function loadHeavy() {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', '1.1-trace-chunk-heavy.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// ────────────────────────────────────────────────────────────────────
// TTFT: time-to-first-token
// ────────────────────────────────────────────────────────────────────

test('ttftMsForStep returns first-chunk offset from step start', () => {
  const step = {
    startTime: 1000,
    events: [
      { type: 'request/header', time: 1010 },
      { type: 'assistant/chunk', time: 1080 },
      { type: 'assistant/chunk', time: 1090 },
      { type: 'assistant/message', time: 1120 },
    ],
  }
  assert.equal(TA.ttftMsForStep(step), 80)
})

test('ttftMsForStep returns null when step has no assistant/chunk', () => {
  const step = {
    startTime: 1000,
    events: [
      { type: 'request/header', time: 1010 },
      { type: 'assistant/message', time: 1120 },
    ],
  }
  assert.equal(TA.ttftMsForStep(step), null)
})

test('ttftMsForStep returns null when startTime is missing', () => {
  const step = {
    startTime: null,
    events: [{ type: 'assistant/chunk', time: 1080 }],
  }
  assert.equal(TA.ttftMsForStep(step), null)
})

test('ttftMsForStep on real chunk-heavy fixture: sub-second offset', () => {
  const events = loadHeavy()
  const [step] = TA.aggregateSteps(events)
  const ttft = TA.ttftMsForStep(step)
  assert.ok(Number.isFinite(ttft) && ttft >= 0 && ttft < 5000,
    `expected TTFT in a plausible ms range, got ${ttft}`)
})

// ────────────────────────────────────────────────────────────────────
// cost: usage × price table → display string
// ────────────────────────────────────────────────────────────────────

test('costForUsage renders $? when no price table given', () => {
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000 }
  const out = TA.costForUsage(usage, null)
  assert.equal(out.value, null)
  assert.equal(out.display, '$?')
  assert.equal(out.hasPrice, false)
})

test('costForUsage renders $? when price table missing the model', () => {
  const usage = { inputTokens: 1000, outputTokens: 200 }
  const out = TA.costForUsage(usage, { pricing: {} }, 'deepseek-chat')
  assert.equal(out.display, '$?')
  assert.equal(out.value, null)
})

test('costForUsage computes billing input as sum of uncached + cache-read + cache-write', () => {
  // Prices in $/M tokens. Bill = (in + cache_read + cache_write) * inPrice + out * outPrice
  // = (1000 + 3000 + 0) * 0.14 + 200 * 0.28 = 560 + 56 = 616 micro-dollars = $0.000616
  // Note: $/M tokens means 0.14 is $0.14/1M, so per-token = 0.14/1e6.
  // 4000 * 0.14/1e6 = 5.6e-4 = 0.00056; 200 * 0.28/1e6 = 5.6e-5 = 0.000056; total = 0.000616.
  const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000 }
  const priceTable = { pricing: { 'deepseek-chat': { input: 0.14, output: 0.28 } } }
  const out = TA.costForUsage(usage, priceTable, 'deepseek-chat')
  assert.ok(out.hasPrice, 'hasPrice true when model matched')
  assert.ok(out.value !== null && Math.abs(out.value - 0.000616) < 1e-9,
    `expected $0.000616, got $${out.value}`)
  // Small values format to $0.0006, larger ones to $0.0042 (4 decimals)
  assert.match(out.display, /^\$0\.\d{4}$/, `display should be $0.NNNN, got ${out.display}`)
})

test('costForUsage falls back gracefully on null usage', () => {
  const out = TA.costForUsage(null, { pricing: { m: { input: 1, output: 1 } } }, 'm')
  assert.equal(out.value, null)
  assert.equal(out.display, '$?')
})

test('costForUsage treats absent cache fields as zero (not error)', () => {
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: null, cacheWriteTokens: null }
  const priceTable = { pricing: { m: { input: 1, output: 1 } } } // $1/M
  const out = TA.costForUsage(usage, priceTable, 'm')
  // 1000 * 1/1e6 + 100 * 1/1e6 = 0.0011
  assert.ok(Math.abs(out.value - 0.0011) < 1e-9, `got ${out.value}`)
})

// ────────────────────────────────────────────────────────────────────
// DEFAULT_PRICE_TABLE coverage — regression guard for review-wire-live F-A
// (real DeepSeek traffic against the stdio-deepseek profile was rendering
// Total Cost = `$?` because the v4-flash / v4-pro SKUs the internal proxy
// ships were missing from the default table). Any SKU we ship as a default
// profile MUST have a row here or the cost chip degrades to `$?` for every
// real trace out of the box.
// ────────────────────────────────────────────────────────────────────

const { DEFAULT_PRICE_TABLE } = require('../src/renderer/price-table.js')

test('DEFAULT_PRICE_TABLE lookup covers DeepSeek v4 SKUs (F-A regression)', () => {
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const row = DEFAULT_PRICE_TABLE.pricing[model]
    assert.ok(row, `default price table must expose a row for ${model}`)
    assert.equal(typeof row.input, 'number', `${model}.input must be a number`)
    assert.equal(typeof row.output, 'number', `${model}.output must be a number`)
    assert.ok(row.input > 0 && row.output > 0, `${model} rates must be positive`)
  }
})

test('costForUsage produces a real $ display for deepseek-v4-flash (real-traffic shape)', () => {
  // Shape mirrors a small deepseek-v4-flash turn seen during wire complete:
  //   inputTokens ~1500, outputTokens ~200, cacheRead ~0.
  const usage = { inputTokens: 1500, outputTokens: 200 }
  const out = TA.costForUsage(usage, DEFAULT_PRICE_TABLE, 'deepseek-v4-flash')
  assert.ok(out.hasPrice, 'F-A: v4-flash must resolve, not fall back to $?')
  assert.notEqual(out.display, '$?', `expected a real $ display, got ${out.display}`)
  // 1500 * 0.14/1e6 + 200 * 0.28/1e6 = 0.00021 + 0.000056 = 0.000266
  assert.ok(Math.abs(out.value - 0.000266) < 1e-9, `got ${out.value}`)
  assert.match(out.display, /^\$0\.\d+$/)
})

test('costForUsage produces a real $ display for deepseek-v4-pro (reasoning-tier shape)', () => {
  // Reasoning-tier shape: heavier output pool billed at the reasoner rate.
  const usage = { inputTokens: 2000, outputTokens: 800 }
  const out = TA.costForUsage(usage, DEFAULT_PRICE_TABLE, 'deepseek-v4-pro')
  assert.ok(out.hasPrice, 'F-A: v4-pro must resolve, not fall back to $?')
  assert.notEqual(out.display, '$?', `expected a real $ display, got ${out.display}`)
  // 2000 * 0.14/1e6 + 800 * 0.55/1e6 = 0.00028 + 0.00044 = 0.00072
  assert.ok(Math.abs(out.value - 0.00072) < 1e-9, `got ${out.value}`)
})

// ────────────────────────────────────────────────────────────────────
// provider extraction
// ────────────────────────────────────────────────────────────────────

test('providerFromHeader prefers header.config.provider', () => {
  const h = { model: 'x', config: { provider: 'deepseek' }, provider: 'anthropic' }
  assert.equal(TA.providerFromHeader(h), 'deepseek')
})

test('providerFromHeader falls back to header.provider when config lacks it', () => {
  const h = { model: 'x', config: {}, provider: 'deepseek' }
  assert.equal(TA.providerFromHeader(h), 'deepseek')
})

test('providerFromHeader returns null when neither present', () => {
  const h = { model: 'x', config: {} }
  assert.equal(TA.providerFromHeader(h), null)
})

test('providerFromHeader safe on bad input', () => {
  assert.equal(TA.providerFromHeader(null), null)
  assert.equal(TA.providerFromHeader({}), null)
  assert.equal(TA.providerFromHeader({ config: null }), null)
})

// ────────────────────────────────────────────────────────────────────
// meta extraction — flatten event.data.meta to kv rows, drop tool-card
// keys the tool card already consumes.
// ────────────────────────────────────────────────────────────────────

test('metaFieldsForEvent returns [] on absent meta', () => {
  assert.deepEqual(TA.metaFieldsForEvent({ type: 'tool/result', data: {} }), [])
  assert.deepEqual(TA.metaFieldsForEvent({ type: 'tool/result', data: { meta: null } }), [])
  assert.deepEqual(TA.metaFieldsForEvent(null), [])
})

test('metaFieldsForEvent flattens scalar meta keys, drops card/durationMs/isError', () => {
  const event = {
    type: 'tool/result',
    data: {
      meta: {
        card: 'diff',       // consumed by tool-card dispatcher — drop
        durationMs: 42,     // shown as tool-card pill — drop
        isError: false,     // shown as tool-card status — drop
        model: 'deepseek-chat',
        provider: 'deepseek',
        tags: ['plan', 'read-only'],
        source: 'plugin:memory',
      },
    },
  }
  const fields = TA.metaFieldsForEvent(event)
  const keys = fields.map((f) => f.key).sort()
  assert.deepEqual(keys, ['model', 'provider', 'source', 'tags'])
  const tags = fields.find((f) => f.key === 'tags')
  // Arrays are preserved as-is (renderer decides display; L1 renders join())
  assert.ok(Array.isArray(tags.value))
  assert.deepEqual(tags.value, ['plan', 'read-only'])
})

test('metaFieldsForEvent tolerates non-object meta gracefully', () => {
  assert.deepEqual(TA.metaFieldsForEvent({ type: 'x', data: { meta: 'string-not-obj' } }), [])
  assert.deepEqual(TA.metaFieldsForEvent({ type: 'x', data: { meta: 42 } }), [])
})

// ────────────────────────────────────────────────────────────────────
// Emoji ban regression: usageBadgeText must not emit color-emoji glyphs
// for the reasoning-tokens field. Team-lead scan missed this one because
// it only fires when reasoningTokens > 0 (rare in fixtures).
// ────────────────────────────────────────────────────────────────────

test('usageBadgeText emits a monochrome reasoning label (no 🧠 emoji)', () => {
  const badge = TA.usageBadgeText({
    inputTokens: 100, outputTokens: 50, cacheReadTokens: null,
    cacheWriteTokens: null, reasoningTokens: 20,
  })
  // Character code check: any codepoint >= U+1F000 is emoji-plane, banned.
  for (let i = 0; i < badge.length; i++) {
    const cp = badge.codePointAt(i)
    assert.ok(cp < 0x1F000,
      `usageBadgeText emitted emoji-plane codepoint U+${cp.toString(16)} in "${badge}"`)
  }
  // But it must still surface reasoning tokens somehow — the L1 pane
  // relies on it as the first-glance signal. Common alternates: "reasoning 20"
  // or a `∵` glyph (typographic, therefore <0x2100 as the visuals test rule).
  assert.match(badge, /(reasoning|20)/, `badge should surface reasoning tokens, got "${badge}"`)
})
