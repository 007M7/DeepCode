'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/compact-config-model.js')

let _seq = 0
function nextSeq() { _seq += 1; return _seq }
function reset() { _seq = 0 }

function userMsg(text = 'hi') {
  return { type: 'user/message', seq: nextSeq(), data: { content: [{ type: 'text', text }] } }
}
function assistantMsg(text = 'ok', usage = null) {
  const ev = { type: 'assistant/message', seq: nextSeq(), data: { content: [{ type: 'text', text }] } }
  if (usage) ev.data.usage = usage
  return ev
}
function compact(model = 'deepseek-chat', maxTokens = 512) {
  return {
    type: 'compact/summary',
    seq: nextSeq(),
    data: { summary: [{ type: 'text', text: 's' }], model, maxTokens, shadowedTokenCount: 8000 },
  }
}

test('resolveThreshold: explicit override → server source', () => {
  const r = M.resolveThreshold({ thresholdTokens: 50000 })
  assert.equal(r.tokens, 50000)
  assert.equal(r.source, 'server')
})

test('resolveThreshold: budget → 0.75 × budget, assumed source', () => {
  const r = M.resolveThreshold({ budgetTokens: 128000 })
  assert.equal(r.tokens, 96000)
  assert.equal(r.source, 'assumed')
})

test('resolveThreshold: no info → default 96000', () => {
  const r = M.resolveThreshold({})
  assert.equal(r.tokens, M.DEFAULT_THRESHOLD_TOKENS)
  assert.equal(r.source, 'assumed')
})

test('buildCompactConfigView: counts triggersFired from compact events', () => {
  reset()
  const events = [userMsg(), assistantMsg(), compact(), userMsg(), assistantMsg(), compact()]
  const view = M.buildCompactConfigView(events)
  assert.equal(view.triggersFired, 2)
})

test('buildCompactConfigView: lastCompactSeq points at final compact event', () => {
  reset()
  const events = [userMsg(), compact(), userMsg(), assistantMsg()]
  const cLast = compact()
  events.push(cLast)
  const view = M.buildCompactConfigView(events)
  assert.equal(view.lastCompactSeq, cLast.seq)
})

test('buildCompactConfigView: tokensSinceLastCompact resets on compact', () => {
  reset()
  const events = [userMsg('x'.repeat(4000)), compact(), userMsg('y'.repeat(400))]
  const view = M.buildCompactConfigView(events)
  assert.ok(view.tokensSinceLastCompact < 500, 'reset means we count only tokens after the compact')
  assert.ok(view.tokensSinceLastCompact > 0, 'post-compact user msg still counted')
})

test('buildCompactConfigView: progressPct + level scale with threshold', () => {
  reset()
  const bigMsg = { type: 'user/message', seq: nextSeq(), data: { content: [{ type: 'text', text: 'x'.repeat(400000) }] } }
  const view = M.buildCompactConfigView([bigMsg], { thresholdTokens: 96000 })
  assert.ok(view.progressPct >= 95, `expected critical level, got ${view.progressPct}%`)
  assert.equal(view.progressLevel, 'critical')
})

test('buildCompactConfigView: tokensUntilNext floors at 0', () => {
  reset()
  const bigMsg = { type: 'user/message', seq: nextSeq(), data: { content: [{ type: 'text', text: 'x'.repeat(500000) }] } }
  const view = M.buildCompactConfigView([bigMsg], { thresholdTokens: 96000 })
  assert.equal(view.tokensUntilNext, 0)
})

test('buildCompactConfigView: empty events → zeroed view', () => {
  const view = M.buildCompactConfigView([])
  assert.equal(view.triggersFired, 0)
  assert.equal(view.currentTokens, 0)
  assert.equal(view.lastCompactSeq, null)
  assert.equal(view.progressLevel, 'nominal')
})

test('buildCompactConfigView: strategy override wins over inferred default', () => {
  const view = M.buildCompactConfigView([], { strategyName: 'sliding-window' })
  assert.equal(view.strategyName, 'sliding-window')
})

test('buildCompactConfigView: last policy carries model + maxSummaryTokens', () => {
  reset()
  const events = [compact('deepseek-chat-v3', 1024)]
  const view = M.buildCompactConfigView(events)
  assert.equal(view.model, 'deepseek-chat-v3')
  assert.equal(view.maxSummaryTokens, 1024)
})

test('levelForPct thresholds', () => {
  assert.equal(M.levelForPct(0), 'nominal')
  assert.equal(M.levelForPct(49), 'nominal')
  assert.equal(M.levelForPct(50), 'warn')
  assert.equal(M.levelForPct(80), 'high')
  assert.equal(M.levelForPct(95), 'critical')
})
