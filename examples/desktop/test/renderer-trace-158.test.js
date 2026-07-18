// Task #158 renderer-side wiring: cost/TTFT/provider/metadata surfaces
// in the L1 layer. Companion of trace-aggregator-158.test.js (which
// covers the pure derivations).
//
// Density-spec §3 rules being enforced:
//   - cost:      L1 chip that always renders (`$?` when no price table)
//   - TTFT:      L1 chip near the usage strip, `Nms` or `absent`
//   - provider:  L1 config chip; when absent, chip reads `inferred`
//   - metadata:  L1 sub-fold on tool/result rows, listing non-card keys

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { loadRenderer } = require('./renderer-harness.js')

function playStream(renderer, sid, events) {
  for (const ev of events) renderer.onSessionEvent(sid, ev)
}

// One step, one chunk (for TTFT), one assistant/message (for usage), close.
// step start=1000, first chunk=1080 (TTFT=80ms), message@1100 usage {842,126},
// end@1500. That gives us the right shape for all four #158 surfaces.
function makeCostStream() {
  return [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'request/header', data: {
      header: {
        model: 'deepseek-chat',
        config: { temperature: 0.7, provider: 'deepseek' },
        system: 'hi', tools: [], messagePrefix: [],
      },
      reason: 'step-start',
    } },
    { seq: 3, time: 1080, type: 'assistant/chunk', data: {
      chunk: { type: 'text-delta', text: 'ok' },
    } },
    { seq: 4, time: 1100, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 842, outputTokens: 126, cacheReadTokens: 3120, cacheWriteTokens: null, reasoningTokens: null },
    } },
    { seq: 5, time: 1500, type: 'step/end', data: {} },
  ]
}

// ────────────────────────────────────────────────────────────────────
// TTFT chip
// ────────────────────────────────────────────────────────────────────

test('trace-step meta strip renders a TTFT chip when the step has chunks', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-ttft', { title: 't', header: {} })
  await renderer.selectSession('s-ttft')
  playStream(renderer, 's-ttft', makeCostStream())

  const chips = document.querySelectorAll('.trace-meta-chip')
  const ttftChip = Array.from(chips).find((c) => {
    const k = c.querySelector('.trace-meta-key')
    return k && k.textContent === 'ttft'
  })
  assert.ok(ttftChip, 'ttft chip renders in the step meta strip')
  const v = ttftChip.querySelector('.trace-meta-value')
  // First chunk @ 1080 - step start @ 1000 = 80ms
  assert.match(v.textContent, /80\s*ms/, `expected "80ms", got "${v.textContent}"`)
})

test('trace-step meta strip renders TTFT chip as `absent` when the step has no chunks', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-no-ttft', { title: 't', header: {} })
  await renderer.selectSession('s-no-ttft')
  // Same shape but no assistant/chunk event
  playStream(renderer, 's-no-ttft', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1500, type: 'step/end', data: {} },
  ])

  const chips = document.querySelectorAll('.trace-meta-chip')
  const ttftChip = Array.from(chips).find((c) => {
    const k = c.querySelector('.trace-meta-key')
    return k && k.textContent === 'ttft'
  })
  assert.ok(ttftChip, 'ttft chip renders even when absent (zero-discard)')
  const v = ttftChip.querySelector('.trace-meta-value')
  assert.equal(v.textContent, 'absent',
    `absent value should read "absent", got "${v.textContent}"`)
  // Absent class present so it's dimmed.
  assert.ok(ttftChip.classList.contains('absent'), 'ttft chip has .absent class')
})

// ────────────────────────────────────────────────────────────────────
// cost chip
// ────────────────────────────────────────────────────────────────────

test('trace-step meta strip renders a cost chip — `$?` when no price table', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-cost', { title: 't', header: {} })
  await renderer.selectSession('s-cost')
  playStream(renderer, 's-cost', makeCostStream())

  const chips = document.querySelectorAll('.trace-meta-chip')
  const costChip = Array.from(chips).find((c) => {
    const k = c.querySelector('.trace-meta-key')
    return k && k.textContent === 'cost'
  })
  assert.ok(costChip, 'cost chip renders in the step meta strip')
  const v = costChip.querySelector('.trace-meta-value')
  // Renderer has no price table wired yet — always `$?`.
  assert.equal(v.textContent, '$?', `expected "$?" fallback, got "${v.textContent}"`)
})

// ────────────────────────────────────────────────────────────────────
// provider chip
// ────────────────────────────────────────────────────────────────────

test('request/header L1 exposes a provider chip when config.provider is present', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-prov', { title: 't', header: {} })
  await renderer.selectSession('s-prov')
  playStream(renderer, 's-prov', makeCostStream())

  // The provider chip lives inside the header L1 config row.
  // Find any chip with key==='provider' inside the trace card.
  const chips = document.querySelectorAll('.trace-meta-chip')
  const provChip = Array.from(chips).find((c) => {
    const k = c.querySelector('.trace-meta-key')
    return k && k.textContent === 'provider'
  })
  assert.ok(provChip, 'provider chip renders in header config row')
  const v = provChip.querySelector('.trace-meta-value')
  assert.equal(v.textContent, 'deepseek', `expected "deepseek", got "${v.textContent}"`)
})

test('request/header L1 provider chip reads `inferred` when wire omits it', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-inf', { title: 't', header: {} })
  await renderer.selectSession('s-inf')
  // A header event with no provider field anywhere.
  playStream(renderer, 's-inf', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'request/header', data: {
      header: { model: 'deepseek-chat', config: { temperature: 0.7 }, system: '', tools: [], messagePrefix: [] },
      reason: 'step-start',
    } },
    { seq: 3, time: 1500, type: 'step/end', data: {} },
  ])

  const chips = document.querySelectorAll('.trace-meta-chip')
  const provChip = Array.from(chips).find((c) => {
    const k = c.querySelector('.trace-meta-key')
    return k && k.textContent === 'provider'
  })
  assert.ok(provChip, 'provider chip always renders (zero-discard)')
  const v = provChip.querySelector('.trace-meta-value')
  assert.equal(v.textContent, 'inferred',
    `absent-provider chip should read "inferred", got "${v.textContent}"`)
})

// ────────────────────────────────────────────────────────────────────
// metadata fold on tool/result rows
// ────────────────────────────────────────────────────────────────────

test('trace event with data.meta non-card keys surfaces a meta fold', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-meta', { title: 't', header: {} })
  await renderer.selectSession('s-meta')

  // Use hook/* event (any event with data.meta triggers the fold).
  // tool/result would exercise the same code path but also fires
  // tool-cards.applyToolDuration which touches a global `document` the
  // test harness doesn't inject into tool-cards (it's require()d as CJS).
  playStream(renderer, 's-meta', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1050, type: 'hook/before-tool-call', data: {
      callId: 'c1',
      meta: {
        card: 'x-test',         // must NOT appear (hidden key)
        durationMs: 42,         // must NOT appear
        isError: false,         // must NOT appear
        model: 'deepseek-chat', // must appear
        provider: 'deepseek',   // must appear
        tags: ['plan', 'read-only'], // must appear (array)
      },
    } },
    { seq: 3, time: 1500, type: 'step/end', data: {} },
  ])

  const foldedMeta = document.querySelectorAll('.trace-event-meta')
  assert.ok(foldedMeta.length >= 1, 'row exposes a .trace-event-meta block')
  const block = foldedMeta[0]
  const rows = block.querySelectorAll('.trace-event-meta-row')
  const keys = Array.from(rows).map((r) => {
    const k = r.querySelector('.trace-event-meta-key')
    return k ? k.textContent : ''
  }).sort()
  assert.deepEqual(keys, ['model', 'provider', 'tags'],
    `only non-hidden keys should appear, got ${keys.join(', ')}`)

  // Tags array should be rendered as a joined preview or JSON — check for
  // presence of both tag literals so we know arrays actually render.
  const tagsRow = Array.from(rows).find((r) => {
    const k = r.querySelector('.trace-event-meta-key')
    return k && k.textContent === 'tags'
  })
  assert.ok(tagsRow, 'tags row present')
  const tagsVal = tagsRow.querySelector('.trace-event-meta-value')
  assert.match(tagsVal.textContent, /plan/, 'tag "plan" visible')
  assert.match(tagsVal.textContent, /read-only/, 'tag "read-only" visible')
})

test('trace event row without meta.non-card keys does NOT emit a meta fold (only render when there is signal)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-no-meta', { title: 't', header: {} })
  await renderer.selectSession('s-no-meta')

  playStream(renderer, 's-no-meta', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1050, type: 'hook/before-tool-call', data: {
      callId: 'c1',
      meta: { card: 'x-test', durationMs: 42 }, // only the hidden keys
    } },
    { seq: 3, time: 1500, type: 'step/end', data: {} },
  ])

  const foldedMeta = document.querySelectorAll('.trace-event-meta')
  assert.equal(foldedMeta.length, 0,
    'meta fold should NOT render when all wire meta keys are hidden (consumed by the tool card)')
})
