// End-to-end coverage for the auto/manual compact badge (task #103 P0-3).
//
// The classifier itself is unit-tested in test/compact-badge.test.js; this
// file exercises the whole pipe from `turn/start` → session-meta cache →
// `compact/summary` → DOM class name, using the renderer harness. Two
// walkthroughs mirror the intent doc's verification steps in §2.2:
//
//   1. Manual: `turn/start { trigger: { kind:'injection', source: { plugin:'compact' }}}`
//      → compact card renders with a `.compact-badge-manual` pill.
//   2. Auto: `turn/start { trigger: { kind:'user' }}` → `.compact-badge-auto`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

async function drive(triggerShape) {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('sid-badge', { title: 't', header: {} })
  await renderer.selectSession('sid-badge')
  renderer.onSessionEvent('sid-badge', {
    type: 'turn/start', seq: 10, time: 1,
    data: { trigger: triggerShape },
  })
  renderer.onSessionEvent('sid-badge', {
    type: 'compact/summary', seq: 12, time: 2,
    data: {
      summary: [{ type: 'text', text: 'This is the summary text.' }],
      shadowedTokenCount: 640,
      shadowedSeqs: [1, 2, 3],
      model: 'test-model',
    },
  })
  return { renderer, document }
}

test('manual compact — badge classes render on the compact card', async () => {
  const { document } = await drive({
    kind: 'injection',
    source: { kind: 'plugin', plugin: 'compact' },
  })
  const card = document.querySelector('.compact-card')
  assert.ok(card, 'compact card must render')
  const badge = card.querySelector('.compact-badge')
  assert.ok(badge, 'a compact-badge element must be present')
  assert.ok(badge.classList.contains('compact-badge-manual'),
    'manual badge should carry compact-badge-manual')
  assert.equal(badge.textContent, 'manual')
})

test('auto compact — user turn produces the auto badge', async () => {
  const { document } = await drive({ kind: 'user' })
  const badge = document.querySelector('.compact-badge')
  assert.ok(badge)
  assert.ok(badge.classList.contains('compact-badge-auto'))
  assert.equal(badge.textContent, 'auto')
})

test('no badge on persisted-only replay (no preceding turn/start)', async () => {
  // A compact/summary that arrives without a matching turn/start (e.g. a
  // persisted-only history replay that skipped the boundary) must render
  // the card unbadged instead of falling back to auto — the classifier's
  // null return is respected.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('sid-noturn', { title: 't', header: {} })
  await renderer.selectSession('sid-noturn')
  renderer.onSessionEvent('sid-noturn', {
    type: 'compact/summary', seq: 5, time: 1,
    data: { summary: [], shadowedTokenCount: 100, shadowedSeqs: [1] },
  })
  const card = document.querySelector('.compact-card')
  assert.ok(card, 'card still renders')
  assert.equal(card.querySelector('.compact-badge'), null,
    'no badge when we could not identify the trigger')
})
