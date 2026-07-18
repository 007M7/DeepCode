// trigger-templates.test.js — pure-module tests for §2.3 template triggers.
//
// Covers T2 (error recovery), T4 (artifact preview), T5 (context health
// warning). Runs under `node --test`, no DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const TT = require('../src/renderer/trigger-templates.js')
const NA = require('../src/renderer/next-actions.js')

// -- T2 : error recovery -----------------------------------------------------

test('T2 error: ENOENT hits file-not-found recipe with retry action', () => {
  const hit = TT.templateFromEvent({
    type: 'tool/result',
    data: { callId: 'c1', isError: true, error: { code: 'ENOENT', message: 'ENOENT: no such file or directory, open /foo' } },
  })
  assert.ok(hit, 'should produce a template')
  assert.equal(hit.kind, 't2-error-recovery')
  assert.equal(hit.ruleId, 'file-not-found')
  assert.equal(hit.widget.kind, 'kv')
  const labels = hit.widget.actions.map((a) => a.label)
  assert.ok(labels.some((l) => /Retry/i.test(l)), 'expected a Retry action')
  // Every emitted action must classify cleanly against the shared verb catalog.
  for (const a of hit.widget.actions) {
    assert.equal(NA.classifyAction(a).broken, false, `action ${a.id} should be valid`)
  }
})

test('T2 error: permission denied text-block hits EACCES recipe', () => {
  const hit = TT.templateFromEvent({
    type: 'tool/result',
    data: { callId: 'c2', isError: true, content: [{ type: 'text', text: 'permission denied: /etc/shadow' }] },
  })
  assert.equal(hit.ruleId, 'permission-denied')
})

test('T2 error: unknown error text falls back to generic recovery', () => {
  const hit = TT.templateFromEvent({
    type: 'tool/result',
    data: { callId: 'c3', isError: true, error: { message: 'something exotic went wrong' } },
  })
  assert.equal(hit.ruleId, 'generic')
  assert.equal(hit.widget.kind, 'kv')
  assert.ok(hit.widget.actions.length >= 3)
})

test('T2 error: non-error tool/result yields null', () => {
  const hit = TT.templateFromEvent({
    type: 'tool/result',
    data: { callId: 'ok', isError: false, content: [{ type: 'text', text: 'ok' }] },
  })
  assert.equal(hit, null)
})

// -- T4 : artifact preview ---------------------------------------------------

test('T4 artifact: tool/result.meta.card=artifact produces preview with open_artifact verb', () => {
  const hit = TT.templateFromEvent({
    type: 'tool/result',
    data: {
      callId: 'a1',
      isError: false,
      content: [],
      meta: { card: 'artifact', artifactId: 'preview.html', title: 'Landing preview', mime: 'text/html' },
    },
  })
  assert.equal(hit.kind, 't4-artifact-preview')
  const open = hit.widget.actions.find((a) => a.id === 'open')
  assert.equal(open.verb, 'open_artifact')
  assert.equal(open.artifactId, 'preview.html')
  const cls = NA.classifyAction(open)
  assert.equal(cls.broken, false)
})

test('T4 artifact: artifact/update broadcast also fires', () => {
  const hit = TT.templateFromEvent({
    type: 'artifact/update',
    data: { artifactId: 'chart.svg', title: 'Growth chart', mime: 'image/svg+xml' },
  })
  assert.equal(hit.kind, 't4-artifact-preview')
  assert.equal(hit.widget.id, 't4-artifact-chart.svg')
})

test('T4 artifact: missing id skips the trigger', () => {
  const hit = TT.templateFromEvent({
    type: 'artifact/update',
    data: { title: 'no id here' },
  })
  assert.equal(hit, null)
})

// -- T5 : context health -----------------------------------------------------

test('T5 context: >85% fires; each action classifies clean', () => {
  const hit = TT.templateFromEvent({
    type: 'context-budget/update',
    data: { pct: 0.91, usedTokens: 182_000, budgetTokens: 200_000 },
  })
  assert.equal(hit.kind, 't5-context-warning')
  const ids = hit.widget.actions.map((a) => a.id).sort()
  assert.deepEqual(ids, ['compact', 'fork', 'note'])
  for (const a of hit.widget.actions) {
    assert.equal(NA.classifyAction(a).broken, false, `action ${a.id} should be valid`)
  }
})

test('T5 context: 80% (below threshold) does not fire', () => {
  const hit = TT.templateFromEvent({
    type: 'context-budget/update',
    data: { pct: 0.80, usedTokens: 160_000, budgetTokens: 200_000 },
  })
  assert.equal(hit, null)
})

test('T5 context: threshold constant is 0.85 (boss ruled)', () => {
  assert.equal(TT.CONTEXT_WARN_PCT, 0.85)
})

// -- dispatcher isolation ----------------------------------------------------

test('templateFromEvent: unrelated event types return null', () => {
  const types = ['user/message', 'turn/start', 'turn/end', 'step/start', 'step/end', 'assistant/chunk', 'unknown/thing']
  for (const t of types) {
    assert.equal(TT.templateFromEvent({ type: t, data: {} }), null, `expected null for ${t}`)
  }
})

test('templateFromEvent: guards null / non-object input', () => {
  assert.equal(TT.templateFromEvent(null), null)
  assert.equal(TT.templateFromEvent(undefined), null)
  assert.equal(TT.templateFromEvent({}), null)
})

// -- widget spec sanity through the shared validator -------------------------

test('every template hit validates against the shared widget-spec validator', () => {
  const sources = [
    { type: 'tool/result', data: { callId: 'e', isError: true, error: { message: 'ENOENT: no such file or directory' } } },
    { type: 'tool/result', data: { callId: 'a', isError: false, meta: { card: 'artifact', artifactId: 'x.html', title: 'X' } } },
    { type: 'context-budget/update', data: { pct: 0.9, usedTokens: 90_000, budgetTokens: 100_000 } },
  ]
  for (const ev of sources) {
    const hit = TT.templateFromEvent(ev)
    assert.ok(hit, `expected a hit for ${ev.type}`)
    const v = NA.validateWidgetSpec(hit.widget)
    assert.equal(v.valid, true, `widget invalid for ${hit.kind}: ${JSON.stringify(v.issues)}`)
  }
})
