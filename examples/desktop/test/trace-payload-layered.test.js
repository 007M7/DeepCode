// Tests for the task #157 L1 helpers on trace-aggregator.js:
// usage extraction / badge formatting / step + session sums, header
// config/tools/messagePrefix field surfaces, request/header-delta preview.
//
// Fixture discipline (memory/multi-agent-shared-repo-rules.md #4): the
// 1.1-trace-full.json fixture mirrors the real wire shape emitted by the
// daemon — assistant/message carries `data.usage` with the five llm/src/
// types.ts:90 keys (inputTokens/outputTokens/cacheReadTokens/cacheWrite
// Tokens/reasoningTokens); request/header carries `data.header` with
// `config` (model + sampling scalars), `system` (rendered system prompt
// text), `tools` (array of ToolDefinition {name,description,parameters}),
// and `messagePrefix` (rendered message history). If this fixture drifts
// from the daemon wire shape the L1 pane loses fidelity in the real app
// — same failure mode #157 is chasing.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TA = require('../src/renderer/trace-aggregator.js')

function loadFull() {
  const p = path.join(__dirname, '..', 'fixtures', 'trace-samples', '1.1-trace-full.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// --- usageFromMessage -------------------------------------------------------

test('usageFromMessage extracts every wire key, absent fields become null', () => {
  const u = TA.usageFromMessage({
    type: 'assistant/message',
    data: { usage: { inputTokens: 100, outputTokens: 20 } },
  })
  assert.deepEqual(u, {
    inputTokens: 100, outputTokens: 20,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  })
})

test('usageFromMessage returns null when data.usage is missing', () => {
  assert.equal(TA.usageFromMessage({ type: 'assistant/message', data: { content: [] } }), null)
  assert.equal(TA.usageFromMessage({ type: 'assistant/message' }), null)
  assert.equal(TA.usageFromMessage(null), null)
})

test('usageFromMessage keeps zero values (not treated as absent)', () => {
  const u = TA.usageFromMessage({
    type: 'assistant/message',
    data: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } },
  })
  assert.equal(u.inputTokens, 0)
  assert.equal(u.outputTokens, 0)
  assert.equal(u.cacheReadTokens, 0)
  assert.equal(u.cacheWriteTokens, null)
})

test('USAGE_KEYS enumerates the five wire fields in the documented order', () => {
  assert.deepEqual(TA.USAGE_KEYS, [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  ])
})

// --- usageBadgeText ---------------------------------------------------------

test('usageBadgeText formats the five fields with typographic marks (no color emoji)', () => {
  const s = TA.usageBadgeText({
    inputTokens: 842, outputTokens: 126, cacheReadTokens: 3120,
    cacheWriteTokens: 48, reasoningTokens: 15,
  })
  // 3120 → 3.1k, 842 → 842, 126 → 126, reasoning shows word not 🧠 (task #158 emoji-ban fix).
  assert.match(s, /↑842/)
  assert.match(s, /↓126/)
  assert.match(s, /cache 3\.1k/)
  assert.match(s, /reasoning 15/)
})

test('usageBadgeText skips null and zero cacheRead so bare wires stay compact', () => {
  const s = TA.usageBadgeText({
    inputTokens: 100, outputTokens: 20,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  })
  assert.equal(s, '↑100 ↓20')
  const s2 = TA.usageBadgeText({
    inputTokens: 100, outputTokens: 20,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  })
  assert.equal(s2, '↑100 ↓20', 'zero cacheRead/reasoning are hidden from L0 badge')
})

test('usageBadgeText returns empty string when usage is null / empty', () => {
  assert.equal(TA.usageBadgeText(null), '')
  assert.equal(TA.usageBadgeText(undefined), '')
  assert.equal(TA.usageBadgeText({}), '')
})

// --- formatK ----------------------------------------------------------------

test('formatK renders <1k as literal, 1-10k as N.Nk, >=10k as Nk, >=1M as N.NM', () => {
  assert.equal(TA.formatK(0), '0')
  assert.equal(TA.formatK(999), '999')
  assert.equal(TA.formatK(1000), '1.0k')
  assert.equal(TA.formatK(1234), '1.2k')
  assert.equal(TA.formatK(9999), '10.0k')
  assert.equal(TA.formatK(12345), '12k')
  assert.equal(TA.formatK(1_500_000), '1.5M')
  assert.equal(TA.formatK('nope'), '')
  assert.equal(TA.formatK(NaN), '')
})

// --- addUsage / sumUsageForStep / sumUsageForSession -----------------------

test('addUsage sums fields, nulls stay null when both operands lack the key', () => {
  const a = { inputTokens: 10, outputTokens: 5,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }
  const b = { inputTokens: 20, outputTokens: 8,
    cacheReadTokens: 30, cacheWriteTokens: null, reasoningTokens: null }
  const r = TA.addUsage(a, b)
  assert.equal(r.inputTokens, 30)
  assert.equal(r.outputTokens, 13)
  assert.equal(r.cacheReadTokens, 30)      // one operand null, one 30 → 30
  assert.equal(r.cacheWriteTokens, null)   // both null → null
  assert.equal(r.reasoningTokens, null)
})

test('sumUsageForStep sums usage across every assistant/message in the step outputs', () => {
  const step = {
    outputs: [
      { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20 } } },
      { type: 'tool/call', data: { name: 'read' } }, // ignored
      { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 500 } } },
    ],
  }
  const u = TA.sumUsageForStep(step)
  assert.equal(u.inputTokens, 150)
  assert.equal(u.outputTokens, 30)
  assert.equal(u.cacheReadTokens, 500)
  assert.equal(u.cacheWriteTokens, null)
})

test('sumUsageForStep returns null when the step produced no assistant/message', () => {
  assert.equal(TA.sumUsageForStep({ outputs: [{ type: 'tool/call' }] }), null)
  assert.equal(TA.sumUsageForStep({ outputs: [] }), null)
  assert.equal(TA.sumUsageForStep(null), null)
})

test('sumUsageForSession rolls up all steps in the trace', () => {
  const events = loadFull()
  const steps = TA.aggregateSteps(events)
  assert.equal(steps.length, 2, 'fixture has two steps')
  const total = TA.sumUsageForSession(steps)
  // step 0: input=842, output=126, cacheRead=3120, cacheWrite=48
  // step 1: input=112, output=22
  assert.equal(total.inputTokens, 842 + 112)
  assert.equal(total.outputTokens, 126 + 22)
  assert.equal(total.cacheReadTokens, 3120)
  assert.equal(total.cacheWriteTokens, 48)
})

// --- headerConfigFields -----------------------------------------------------

test('headerConfigFields lists model then every sampling scalar the wire ships', () => {
  const events = loadFull()
  const header = events.find((e) => e.type === 'request/header').data.header
  const fields = TA.headerConfigFields(header)
  const keys = fields.map((f) => f.key)
  assert.equal(keys[0], 'model', 'model comes first')
  // priority ordering: temperature/topP/topK/maxTokens/seed/... before stopSequences
  const idxTemp = keys.indexOf('temperature')
  const idxTopP = keys.indexOf('topP')
  const idxStops = keys.indexOf('stopSequences')
  assert.ok(idxTemp !== -1 && idxTopP !== -1 && idxStops !== -1)
  assert.ok(idxTemp < idxTopP)
  assert.ok(idxTopP < idxStops)
  // zero-discard: seed=null is still emitted with value null (not filtered)
  const seed = fields.find((f) => f.key === 'seed')
  assert.ok(seed, 'seed field surfaces even when its value is null')
  assert.equal(seed.value, null)
})

test('headerConfigFields tolerates missing config / non-object header', () => {
  assert.deepEqual(TA.headerConfigFields(null), [])
  assert.deepEqual(TA.headerConfigFields({}), [])
  assert.deepEqual(TA.headerConfigFields({ model: 'foo' }), [{ key: 'model', value: 'foo' }])
})

// --- headerToolSummaries ----------------------------------------------------

test('headerToolSummaries returns {name, description, parameters, raw} per tool', () => {
  const events = loadFull()
  const header = events.find((e) => e.type === 'request/header').data.header
  const tools = TA.headerToolSummaries(header)
  assert.equal(tools.length, 3)
  assert.equal(tools[0].name, 'read')
  assert.match(tools[0].description, /^Read a file/)
  assert.equal(typeof tools[0].parameters, 'object')
  assert.equal(tools[0].parameters.type, 'object')
  assert.equal(tools[0].raw, header.tools[0], 'raw preserves the full wire object')
})

test('headerToolSummaries gives a stable shape when a wire tool lacks fields', () => {
  const tools = TA.headerToolSummaries({ tools: [{ name: 'x' }, { description: 'anon' }] })
  assert.equal(tools[0].name, 'x')
  assert.equal(tools[0].description, '')
  assert.equal(tools[1].name, '(unnamed)')
  assert.equal(tools[1].description, 'anon')
})

// --- headerDeltaPreview + previewForEvent ---------------------------------

test('headerDeltaPreview lists the delta keys with the reason', () => {
  const events = loadFull()
  const delta = events.find((e) => e.type === 'request/header-delta').data
  const s = TA.headerDeltaPreview(delta)
  assert.match(s, /delta\{messagePrefix, config\}/)
  assert.match(s, /post-tool/)
})

test('previewForEvent recognises request/header-delta type', () => {
  const events = loadFull()
  const delta = events.find((e) => e.type === 'request/header-delta')
  const s = TA.previewForEvent(delta)
  assert.match(s, /delta\{/)
})

test('previewForEvent on assistant/message appends the usage badge', () => {
  const events = loadFull()
  const msg = events.find((e) => e.type === 'assistant/message' && e.data.usage.cacheReadTokens === 3120)
  const s = TA.previewForEvent(msg)
  // text body then usage badge, joined by ' · '
  assert.match(s, /↑842/)
  assert.match(s, /↓126/)
  assert.match(s, /cache 3\.1k/)
})

test('previewForEvent falls back to badge-only when the message body is empty', () => {
  const s = TA.previewForEvent({
    type: 'assistant/message',
    data: { content: [], usage: { inputTokens: 50, outputTokens: 10 } },
  })
  assert.equal(s, '↑50 ↓10')
})

// --- stepMetaFields --------------------------------------------------------

test('stepMetaFields emits all five keys even when values are null (zero-discard)', () => {
  const rec = { turn: null, step: 0, startSeq: 201, endSeq: 212, durationMs: null }
  const f = TA.stepMetaFields(rec)
  assert.deepEqual(f.map((x) => x.key), ['turn', 'step', 'startSeq', 'endSeq', 'durationMs'])
  assert.equal(f[0].value, null)
  assert.equal(f[4].value, null)
})

// --- fixture end-to-end sanity ---------------------------------------------

test('1.1-trace-full.json has two steps producing assistant/messages with usage', () => {
  const events = loadFull()
  const steps = TA.aggregateSteps(events)
  assert.equal(steps.length, 2)
  const u0 = TA.sumUsageForStep(steps[0])
  assert.equal(u0.inputTokens, 842)
  assert.equal(u0.outputTokens, 126)
  const u1 = TA.sumUsageForStep(steps[1])
  assert.equal(u1.inputTokens, 112)
  assert.equal(u1.outputTokens, 22)
  // Step 1's usage lacks cache/reasoning, so those must be null on the sum.
  assert.equal(u1.cacheReadTokens, null)
  assert.equal(u1.reasoningTokens, null)
})
