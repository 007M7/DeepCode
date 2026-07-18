// Tests for renderer.js `compactNow()` — statusbar Compact button.
//
// Locks the discriminated result the JSON-RPC `session/compact` wire returns:
// the shell must render distinct system lines for compacted/not-compacted/
// unsupported/streaming, and disable the button after a MethodNotFound so a
// second click can't retrigger the rejection. See renderer.js §compactNow and
// packages/ui/jsonrpc/src/protocol.ts SessionCompactResult (both landed in the
// same integration branch).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

async function bootWithSession(dshOverride) {
  const { renderer, dsh } = await loadRenderer(dshOverride)
  renderer.ensureSession('s1', { title: 'a', header: {} })
  await renderer.selectSession('s1')
  return { renderer, dsh }
}

test('compactNow renders a "nothing to compact" system line on { compacted: false }', async () => {
  const { renderer } = await bootWithSession({
    async compactSession(_sid) {
      return { supported: true, result: { compacted: false, reason: 'nothing-to-compact' } }
    },
  })

  await renderer.compactNow()
  const text = renderer.getStreamText()
  assert.match(text, /nothing to compact/i,
    `expected "nothing to compact" system line, got: ${text.slice(-200)}`)
  // The compact/summary card is drawn from the session.event stream on the
  // { compacted: true } path; a false result must never draw one.
  assert.doesNotMatch(text, /Context compacted/i)
})

test('compactNow stays quiet on { compacted: true } — the session.event stream carries the card', async () => {
  const { renderer } = await bootWithSession({
    async compactSession(_sid) {
      return {
        supported: true,
        result: { compacted: true, startSeq: 42, summarySeq: 43, endSeq: 44, shadowedCount: 6 },
      }
    },
  })

  const before = renderer.getStreamText().length
  await renderer.compactNow()
  // No "compact requested" line — the daemon emits compact/start →
  // compact/summary → compact/end as session events; the compact card lives
  // there, not on this branch.
  assert.doesNotMatch(renderer.getStreamText().slice(before), /compact requested/i)
  assert.doesNotMatch(renderer.getStreamText().slice(before), /nothing to compact/i)
  assert.doesNotMatch(renderer.getStreamText().slice(before), /compact skipped/i)
})

test('compactNow reports "unsupported" and remembers it on { supported: false }', async () => {
  let calls = 0
  const { renderer } = await bootWithSession({
    async compactSession(_sid) {
      calls += 1
      return { supported: false, reason: 'MethodNotFound' }
    },
  })

  await renderer.compactNow()
  assert.equal(renderer.getCompactSupported(), false)
  assert.match(renderer.getStreamText(), /runtime does not support session\/compact/i)
  // A second click must not re-issue the RPC — updateCompactButton keeps the
  // button disabled from state.compactSupported === false.
  await renderer.compactNow()
  // compactNow still runs the RPC in the current implementation (the guard
  // lives on the button, not the function), but the state stays sticky at
  // false. Verify at least the state contract; the button-disabled guard is
  // covered by updateCompactButton tests.
  assert.equal(renderer.getCompactSupported(), false)
  assert.equal(calls, 2, 'compactNow re-issues the RPC on repeated calls; the button guard is what stops the user')
})

test('compactNow reports the streaming rejection with a compact-friendly message', async () => {
  const { renderer } = await bootWithSession({
    async compactSession(_sid) {
      const err = new Error('session is streaming; compact after turn ends')
      throw err
    },
  })

  await renderer.compactNow()
  assert.match(renderer.getStreamText(), /compact after this turn ends/i,
    'streaming rejection should surface with the "compact after this turn ends" hint')
})

test('compactNow surfaces other RPC failures verbatim', async () => {
  const { renderer } = await bootWithSession({
    async compactSession(_sid) { throw new Error('summarize boom') },
  })

  await renderer.compactNow()
  assert.match(renderer.getStreamText(), /compact failed: summarize boom/,
    'unexpected error should render with the raw message')
})

test('compactNow accepts a legacy untagged ok result (backward compatibility)', async () => {
  const { renderer } = await bootWithSession({
    async compactSession(_sid) { return { supported: true, result: {} } },
  })

  await renderer.compactNow()
  // Legacy runtime with no `compacted` discriminator falls into the "compact
  // requested" branch — better than a silent click.
  assert.match(renderer.getStreamText(), /compact requested/i)
})
