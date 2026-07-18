// settings-model tests (task #193): pure helpers for the localStorage-
// backed price-table override + env-key presence classifier.
//
// The renderer module lives at src/renderer/settings-model.js and
// publishes to window under `window.__dshSettingsModel`. In Node, the
// module ships CommonJS via module.exports; localStorage isn't
// available, so every test that touches storage passes an in-memory
// Map-like shim via the optional `storage` argument.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

// Tiny Storage polyfill matching the subset settings-model uses.
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    _dump: () => Object.fromEntries(map),
  }
}

const M = require('../src/renderer/settings-model.js')

test('readOverrides returns {} for empty storage', () => {
  const s = makeStorage()
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('readOverrides ignores malformed JSON', () => {
  const s = makeStorage({ [M.STORAGE_KEY]: '{not json' })
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('readOverrides ignores non-object JSON (arrays / primitives)', () => {
  for (const raw of ['[]', '"hi"', '42', 'null']) {
    const s = makeStorage({ [M.STORAGE_KEY]: raw })
    assert.deepStrictEqual(M.readOverrides(s), {}, `raw=${raw}`)
  }
})

test('setOverride writes an entry and readOverrides reads it back', () => {
  const s = makeStorage()
  M.setOverride('deepseek-chat', { input: 0.5 }, s)
  assert.deepStrictEqual(M.readOverrides(s), { 'deepseek-chat': { input: 0.5 } })
})

test('setOverride merges with existing entry (partial patch)', () => {
  const s = makeStorage()
  M.setOverride('m', { input: 1 }, s)
  M.setOverride('m', { output: 2 }, s)
  assert.deepStrictEqual(M.readOverrides(s), { m: { input: 1, output: 2 } })
})

test('setOverride with null value deletes that field', () => {
  const s = makeStorage()
  M.setOverride('m', { input: 1, output: 2 }, s)
  M.setOverride('m', { output: null }, s)
  assert.deepStrictEqual(M.readOverrides(s), { m: { input: 1 } })
})

test('setOverride drops the whole model when both fields cleared', () => {
  const s = makeStorage()
  M.setOverride('m', { input: 1 }, s)
  M.setOverride('m', { input: null }, s)
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('setOverride(null) drops the whole model', () => {
  const s = makeStorage()
  M.setOverride('m', { input: 1 }, s)
  M.setOverride('m', null, s)
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('setOverride ignores non-finite / negative numbers', () => {
  const s = makeStorage()
  M.setOverride('m', { input: NaN, output: -1 }, s)
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('setOverride ignores empty / non-string model names', () => {
  const s = makeStorage()
  M.setOverride('', { input: 1 }, s)
  M.setOverride(null, { input: 1 }, s)
  M.setOverride(undefined, { input: 1 }, s)
  assert.deepStrictEqual(M.readOverrides(s), {})
})

test('getEffectivePricing overlays overrides on the default table', () => {
  const s = makeStorage()
  M.setOverride('deepseek-chat', { input: 0.05 }, s)
  const merged = M.getEffectivePricing({
    pricing: {
      'deepseek-chat': { input: 0.14, output: 0.28 },
      'deepseek-reasoner': { input: 0.14, output: 0.55 },
    },
  }, s)
  assert.deepStrictEqual(merged.pricing['deepseek-chat'], { input: 0.05, output: 0.28 })
  assert.deepStrictEqual(merged.pricing['deepseek-reasoner'], { input: 0.14, output: 0.55 })
})

test('getEffectivePricing does not mutate the input table', () => {
  const s = makeStorage()
  M.setOverride('m', { input: 9 }, s)
  const input = { pricing: { m: { input: 1, output: 2 } } }
  const before = JSON.stringify(input)
  M.getEffectivePricing(input, s)
  assert.strictEqual(JSON.stringify(input), before)
})

test('getEffectivePricing carries through override-only models', () => {
  const s = makeStorage()
  M.setOverride('custom-model', { input: 3, output: 5 }, s)
  const merged = M.getEffectivePricing({ pricing: {} }, s)
  assert.deepStrictEqual(merged.pricing['custom-model'], { input: 3, output: 5 })
})

test('getEffectivePricing handles null / bad default table', () => {
  const s = makeStorage()
  const a = M.getEffectivePricing(null, s)
  const b = M.getEffectivePricing({}, s)
  const c = M.getEffectivePricing({ pricing: null }, s)
  for (const r of [a, b, c]) {
    assert.deepStrictEqual(r.pricing, {})
  }
})

test('classifyKeys labels the four known env vars', () => {
  const rows = M.classifyKeys({
    DEEPSEEK_API_KEY: true,
    OPENAI_API_KEY: false,
    ANTHROPIC_API_KEY: false,
    DSH_SERVICE_TOKEN: true,
  })
  assert.strictEqual(rows.length, 4)
  const names = rows.map((r) => r.name).sort()
  assert.deepStrictEqual(names, ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'DSH_SERVICE_TOKEN', 'OPENAI_API_KEY'])
  const service = rows.find((r) => r.name === 'DSH_SERVICE_TOKEN')
  const personal = rows.find((r) => r.name === 'DEEPSEEK_API_KEY')
  assert.strictEqual(service.tier, 'service')
  assert.strictEqual(personal.tier, 'personal')
  assert.strictEqual(personal.present, true)
  const missing = rows.find((r) => r.name === 'OPENAI_API_KEY')
  assert.strictEqual(missing.present, false)
})

test('classifyKeys is safe for bad input', () => {
  const rows = M.classifyKeys(null)
  assert.strictEqual(rows.length, 4)
  for (const r of rows) assert.strictEqual(r.present, false)
})

// Rec 30 (2026-07-17): the resource-table shape means every row has a
// stable schema — name / present / tier / description (string) /
// lastUsed (string|null). The DOM renderer relies on all four columns
// being non-undefined, so lock the shape here.
test('classifyKeys returns the resource-table schema for every row', () => {
  const rows = M.classifyKeys({})
  for (const r of rows) {
    assert.ok(typeof r.name === 'string' && r.name.length > 0)
    assert.ok(typeof r.tier === 'string' && ['personal', 'service'].includes(r.tier))
    assert.ok(typeof r.description === 'string' && r.description.length > 0,
      `${r.name} description must be a non-empty string`)
    assert.strictEqual(r.lastUsed, null,
      `${r.name} default lastUsed is null (no seam yet)`)
    assert.strictEqual(r.present, false)
  }
})

test('classifyKeys carries a lastUsed timestamp when the presence probe supplies one', () => {
  const iso = '2026-07-17T00:00:00Z'
  const rows = M.classifyKeys({
    DEEPSEEK_API_KEY: true,
    __lastUsed: { DEEPSEEK_API_KEY: iso, ANTHROPIC_API_KEY: '' },
  })
  const ds = rows.find((r) => r.name === 'DEEPSEEK_API_KEY')
  assert.strictEqual(ds.lastUsed, iso)
  const claude = rows.find((r) => r.name === 'ANTHROPIC_API_KEY')
  // Empty string is not a valid timestamp — normalize to null so the
  // renderer's `|| '—'` fallback stays consistent.
  assert.strictEqual(claude.lastUsed, null)
})
