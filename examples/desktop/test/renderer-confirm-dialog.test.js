// A-P1-3 regression: the shared `confirmDialog` helper resolves to boolean
// and falls back to `window.confirm` when the <dialog> element or showModal
// is missing. The renderer's DOM shim (test/renderer-harness.js) doesn't
// implement showModal, so this test naturally exercises the fallback path.
// The dialog-element path is covered by manual QA (native <dialog>, hard to
// simulate faithfully) — but the fallback is exactly the code path everyone
// hits in the test harness and any degraded environment, so it's worth
// pinning.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

test('confirmDialog resolves to true when window.confirm accepts', async () => {
  const { renderer, window } = await loadRenderer()
  window.confirm = () => true
  const ok = await renderer.confirmDialog({ title: 't', body: 'b' })
  assert.equal(ok, true)
})

test('confirmDialog resolves to false when window.confirm cancels', async () => {
  const { renderer, window } = await loadRenderer()
  window.confirm = () => false
  const ok = await renderer.confirmDialog({ title: 't', body: 'b' })
  assert.equal(ok, false)
})

test('confirmDialog defaults body to title when body is empty', async () => {
  const { renderer, window } = await loadRenderer()
  let seenPrompt = null
  window.confirm = (text) => { seenPrompt = text; return true }
  await renderer.confirmDialog({ title: 'reset?' })
  assert.equal(seenPrompt, 'reset?')
})
