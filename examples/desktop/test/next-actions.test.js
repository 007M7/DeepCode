// next-actions.test.js — pure-module tests for the suggestion engine and
// verb catalog. Runs under `node --test`, no DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const NA = require('../src/renderer/next-actions.js')

test('verb catalog exposes the four REAL verbs plus note (record-only)', () => {
  const kinds = Object.keys(NA.VERBS).sort()
  assert.deepEqual(kinds, ['note', 'open_artifact', 'open_link', 'prompt', 'switch_session'])
  assert.equal(NA.VERBS.prompt.real, true)
  assert.equal(NA.VERBS.open_link.real, true)
  assert.equal(NA.VERBS.open_artifact.real, true)
  assert.equal(NA.VERBS.switch_session.real, true)
  assert.equal(NA.VERBS.note.real, false)
})

test('classifyAction: legacy action (no verb) defaults to prompt when payload valid', () => {
  const cls = NA.classifyAction({ id: 'a', label: 'Go', prompt: 'hello' })
  assert.equal(cls.broken, false)
  assert.equal(cls.verb.kind, 'prompt')
})

test('classifyAction: unknown verb is broken with reason', () => {
  const cls = NA.classifyAction({ id: 'x', verb: 'teleport', label: '?' })
  assert.equal(cls.broken, true)
  assert.match(cls.reason, /unknown verb: teleport/)
})

test('classifyAction: verb missing its required field is broken', () => {
  const cls = NA.classifyAction({ id: 'x', verb: 'open_link', url: '' })
  assert.equal(cls.broken, true)
  assert.match(cls.reason, /missing "url"/)
})

test('classifyAction: note has no required fields — always valid', () => {
  const cls = NA.classifyAction({ id: 'n', verb: 'note' })
  assert.equal(cls.broken, false)
  assert.equal(cls.verb.real, false)
})

test('validateWidgetSpec: catches missing kind + broken action inline', () => {
  const v = NA.validateWidgetSpec({
    id: 't',
    data: {},
    actions: [
      { id: 'ok', prompt: 'hi' },
      { id: 'bad', verb: 'teleport' },
      { id: 'noUrl', verb: 'open_link', url: '' },
    ],
  })
  assert.equal(v.valid, false)
  const fields = v.issues.map((i) => i.field)
  assert.ok(fields.includes('kind'))
  assert.ok(fields.some((f) => f.startsWith('actions[1]')))
  assert.ok(fields.some((f) => f.startsWith('actions[2]')))
})

test('validateWidgetSpec: fully valid spec is marked valid', () => {
  const v = NA.validateWidgetSpec({
    kind: 'kv', id: 'ok',
    data: { entries: [] },
    actions: [{ id: 'go', verb: 'prompt', label: 'Go', prompt: 'hi' }],
  })
  assert.equal(v.valid, true)
  assert.equal(v.issues.length, 0)
})

test('contextFromEvents: aggregates diff/bash/error/options/artifact counters', () => {
  const events = [
    { type: 'tool/call', data: { name: 'edit_file' } },
    { type: 'tool/call', data: { name: 'bash' } },
    { type: 'tool/result', data: { isError: true, content: [] } },
    { type: 'tool/result', data: { meta: { card: 'widget', widget: { kind: 'options', id: 'x' } }, content: [] } },
    { type: 'tool/result', data: { meta: { card: 'artifact', artifactId: 'page.html' }, content: [] } },
    { type: 'turn/end', data: {} },
  ]
  const ctx = NA.contextFromEvents(events)
  assert.equal(ctx.diffTools, 1)
  assert.equal(ctx.bashTools, 1)
  assert.equal(ctx.errorSignal, true)
  assert.equal(ctx.optionsWidget, true)
  assert.equal(ctx.lastArtifactId, 'page.html')
  assert.equal(ctx.turnEnded, true)
})

test('contextFromEvents: detects errors via stderr keyword in text', () => {
  const ctx = NA.contextFromEvents([
    { type: 'tool/result', data: { content: [{ type: 'text', text: 'stderr: file not found' }] } },
  ])
  assert.equal(ctx.errorSignal, true)
})

test('suggestFromContext: diff tools → run-tests chip appears', () => {
  const ctx = NA.emptyContext(); ctx.diffTools = 1
  const chips = NA.suggestFromContext(ctx)
  const ids = chips.map((c) => c.id)
  assert.ok(ids.includes('run-tests'))
})

test('suggestFromContext: error + diff → both explain and pivot chips', () => {
  const ctx = NA.emptyContext()
  ctx.diffTools = 1; ctx.errorSignal = true
  const chips = NA.suggestFromContext(ctx)
  const ids = chips.map((c) => c.id)
  assert.ok(ids.includes('explain-error'))
  // Bounded to MAX_CHIPS.
  assert.ok(chips.length <= NA.MAX_CHIPS)
})

test('suggestFromContext: artifact → open_artifact verb chip carries the id', () => {
  const ctx = NA.emptyContext(); ctx.lastArtifactId = 'foo.html'
  const chips = NA.suggestFromContext(ctx)
  const open = chips.find((c) => c.id === 'open-artifact')
  assert.ok(open, 'open-artifact chip should be present')
  assert.equal(open.verb, 'open_artifact')
  assert.equal(open.artifactId, 'foo.html')
})

test('suggestFromContext: MAX_CHIPS bound respected', () => {
  const ctx = NA.emptyContext()
  ctx.diffTools = 5; ctx.errorSignal = true; ctx.lastArtifactId = 'x.html'
  ctx.optionsWidget = true
  const chips = NA.suggestFromContext(ctx)
  assert.ok(chips.length <= NA.MAX_CHIPS)
})

test('suggestFromContext: dismissed chip ids are filtered out', () => {
  const ctx = NA.emptyContext(); ctx.diffTools = 1
  const chips = NA.suggestFromContext(ctx, new Set(['run-tests']))
  assert.ok(!chips.find((c) => c.id === 'run-tests'))
})

test('NextActionTracker: push feeds context, dismiss persists, reset clears', () => {
  const t = new NA.NextActionTracker()
  const events = [
    { type: 'tool/call', data: { name: 'edit_file' } },
    { type: 'turn/end', data: {} },
  ]
  let chips = t.push(events[0])
  assert.ok(chips.find((c) => c.id === 'run-tests'))
  t.dismiss('run-tests')
  chips = t.push(events[1])
  assert.ok(!chips.find((c) => c.id === 'run-tests'))
  t.reset()
  chips = t.push({ type: 'tool/call', data: { name: 'edit_file' } })
  assert.ok(chips.find((c) => c.id === 'run-tests'))
})
