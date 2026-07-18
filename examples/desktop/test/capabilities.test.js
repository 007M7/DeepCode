// Pure-module tests for src/renderer/capabilities.js (Ticket G, task #125).
//
// The normalizer's contract is what every gated UI surface keys off, so
// the "wire didn't say" default is locked here — a regression that grays
// a legacy v1 daemon by silently flipping this default would be
// user-visible in a demo (all buttons in a v1 runtime would go dark).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeCapabilities,
  capabilityDisabledTitle,
  CAPABILITY_KEYS,
  CAPABILITIES_ALL_SUPPORTED,
  DISABLED_TOOLTIPS,
} = require('../src/renderer/capabilities.js')

test('normalizeCapabilities: null / undefined input → all six default to true (v1 server posture)', () => {
  for (const bad of [null, undefined]) {
    const out = normalizeCapabilities(bad)
    for (const key of CAPABILITY_KEYS) {
      assert.equal(out[key], true, `expected caps.${key} === true for ${bad} input, got ${out[key]}`)
    }
  }
})

test('normalizeCapabilities: non-object input → all six default to true (defensive shape)', () => {
  for (const bad of ['yes', 42, true, false]) {
    const out = normalizeCapabilities(bad)
    for (const key of CAPABILITY_KEYS) {
      assert.equal(out[key], true, `expected caps.${key} === true for ${bad} input, got ${out[key]}`)
    }
  }
})

test('normalizeCapabilities: empty object → all six default to true (wire-silent ≠ unsupported)', () => {
  const out = normalizeCapabilities({})
  for (const key of CAPABILITY_KEYS) {
    assert.equal(out[key], true, `caps.${key} should default to true when the envelope lacks the key`)
  }
})

test('normalizeCapabilities: explicit false is the only way to gray a bit', () => {
  const out = normalizeCapabilities({
    cancel: false,
    fork: false,
    plugins: false,
  })
  assert.equal(out.cancel, false)
  assert.equal(out.fork, false)
  assert.equal(out.plugins, false)
  // Untouched bits stay `true` (default posture is preserved).
  assert.equal(out.sessionQuery, true)
  assert.equal(out.setConfig, true)
  assert.equal(out.compact, true)
})

test('normalizeCapabilities: null and undefined for a specific key are NOT gray (only explicit false)', () => {
  // A daemon that ships `capabilities: { cancel: null }` is a bug on that
  // side, but it must not accidentally gray the Cancel button. Only
  // `false` grays.
  const out = normalizeCapabilities({ cancel: null, fork: undefined, plugins: 0 })
  assert.equal(out.cancel, true, 'null must NOT gray cancel — only explicit false does')
  assert.equal(out.fork, true, 'undefined must NOT gray fork — only explicit false does')
  assert.equal(out.plugins, true, '0 must NOT gray plugins — only explicit false does')
})

test('normalizeCapabilities: unknown keys on the envelope are ignored (don\'t leak into the UI)', () => {
  const out = normalizeCapabilities({ cancel: false, mysterious: true, weird: 'value' })
  assert.equal(out.cancel, false)
  assert.equal(out.mysterious, undefined, 'unknown keys must not surface on the normalized shape')
  assert.equal(out.weird, undefined)
  // All six known bits are present.
  for (const key of CAPABILITY_KEYS) {
    assert.ok(key in out, `known capability ${key} must be on the normalized shape`)
  }
})

test('normalizeCapabilities: real integration/echo daemon shape is fully supported', () => {
  // The current integration daemon (packages/ui/jsonrpc/src/server.ts:729)
  // ships all six as `true`. Under the current server, the shell should
  // gray nothing.
  const wireShape = {
    sessionLifecycle: true,
    cancel: true,
    sessionQuery: true,
    setConfig: true,
    fork: true,
    plugins: true,
    compact: true,
  }
  const out = normalizeCapabilities(wireShape)
  for (const key of CAPABILITY_KEYS) {
    assert.equal(out[key], true, `full-support wire shape must not gray ${key}`)
  }
})

test('capabilityDisabledTitle: returns canonical string per capability', () => {
  for (const key of CAPABILITY_KEYS) {
    const t = capabilityDisabledTitle(key)
    assert.ok(typeof t === 'string' && t.length > 0,
      `capability ${key} must have a canonical disabled tooltip`)
    assert.equal(t, DISABLED_TOOLTIPS[key])
  }
})

test('capabilityDisabledTitle: unknown key returns empty string (do-no-harm fallback)', () => {
  assert.equal(capabilityDisabledTitle('nonsense'), '')
  assert.equal(capabilityDisabledTitle(''), '')
  assert.equal(capabilityDisabledTitle(undefined), '')
})

test('CAPABILITIES_ALL_SUPPORTED matches every CAPABILITY_KEY and is all-true', () => {
  const keys = Object.keys(CAPABILITIES_ALL_SUPPORTED).sort()
  assert.deepEqual(keys, [...CAPABILITY_KEYS].sort(),
    'CAPABILITIES_ALL_SUPPORTED must cover exactly the CAPABILITY_KEYS set')
  for (const key of CAPABILITY_KEYS) {
    assert.equal(CAPABILITIES_ALL_SUPPORTED[key], true)
  }
})

test('normalize output has no aliasing between two calls (safe to mutate reads)', () => {
  const a = normalizeCapabilities({ cancel: false })
  const b = normalizeCapabilities({ fork: false })
  a.compact = false
  // b must not see a's mutation.
  assert.equal(b.compact, true, 'each normalize call must yield an independent object')
})
