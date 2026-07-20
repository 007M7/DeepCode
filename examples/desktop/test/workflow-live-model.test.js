// workflow-live-model.test.js — lane-wf-feedback item 1.
//
// Verifies the pure accumulator that folds the on-wire `workflow.event` train
// (runtime commit dd29d8631) into the aggregate {name, kind:'seq', steps[]}
// model workflow-view.buildWorkflowCard consumes.
//
// Covered:
//   1. A full six-event run projects a linear seq card (agents → steps).
//   2. agent-start → running; agent-end outcome=completed → done; failed → failed.
//   3. Steps are ordered by engine `seq`, not arrival order.
//   4. phase/log frames fold onto run state without inventing steps.
//   5. Unknown kind + malformed frames are dropped (apply → null), no run made.
//   6. The wire shape from the runtime's own server.spec fixture round-trips.
//   7. toCard on an unknown run returns null; forget/clear drop runs.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { createWorkflowLiveModel, statusForOutcome } = require('../src/renderer/workflow-live-model.js')

// The exact emit shapes from packages/ui/jsonrpc/tests/server.spec.ts in the
// runtime repo (the bridge's own test). runId 'run-42', one agent.
const META = { name: 'test-flow', description: 'demo' }
function frame(kind, payload) {
  const f = { kind, runId: 'run-42', meta: META }
  if (payload !== undefined) f.payload = payload
  return f
}

test('folds the six-event run into a linear seq card', () => {
  const m = createWorkflowLiveModel()
  assert.strictEqual(m.apply(frame('workflow/start')), 'run-42')
  m.apply(frame('workflow/phase', 'Scan'))
  m.apply(frame('workflow/log', 'starting with 2 files'))
  m.apply(frame('workflow/agent-start', { seq: 1, label: 'read a.ts', phase: 'Scan', childId: 'child-1' }))
  m.apply(frame('workflow/agent-end', { seq: 1, label: 'read a.ts', phase: 'Scan', childId: 'child-1', outcome: 'completed' }))
  m.apply(frame('workflow/end', { stopReason: 'completed', agentsStarted: 1 }))

  const card = m.toCard('run-42')
  assert.strictEqual(card.name, 'test-flow')
  assert.strictEqual(card.kind, 'seq')
  assert.strictEqual(card.steps.length, 1)
  assert.strictEqual(card.steps[0].id, 'child-1')
  assert.strictEqual(card.steps[0].name, 'read a.ts')
  assert.strictEqual(card.steps[0].status, 'done')
  assert.strictEqual(card._live, true)
  assert.strictEqual(card._done, true)
  assert.strictEqual(card._stopReason, 'completed')
  assert.strictEqual(card._phase, 'Scan')
  assert.deepStrictEqual(card._logs, ['starting with 2 files'])
})

test('agent-start marks running until agent-end settles the status', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/agent-start', { seq: 1, label: 'step one', childId: 'c1' }))
  let card = m.toCard('run-42')
  assert.strictEqual(card.steps[0].status, 'running')

  m.apply(frame('workflow/agent-end', { seq: 1, childId: 'c1', outcome: 'completed' }))
  card = m.toCard('run-42')
  assert.strictEqual(card.steps[0].status, 'done')
  assert.strictEqual(card.steps[0].output, 'completed')
})

test('a failed outcome maps to a failed step', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/agent-start', { seq: 2, label: 'boom', childId: 'c2' }))
  m.apply(frame('workflow/agent-end', { seq: 2, childId: 'c2', outcome: 'failed' }))
  const card = m.toCard('run-42')
  assert.strictEqual(card.steps[0].status, 'failed')
  assert.strictEqual(statusForOutcome('failed'), 'failed')
  assert.strictEqual(statusForOutcome('aborted'), 'failed')
  assert.strictEqual(statusForOutcome('completed'), 'done')
  assert.strictEqual(statusForOutcome(undefined), 'done')
})

test('steps are ordered by engine seq regardless of arrival order', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/agent-start', { seq: 3, label: 'third', childId: 'c3' }))
  m.apply(frame('workflow/agent-start', { seq: 1, label: 'first', childId: 'c1' }))
  m.apply(frame('workflow/agent-start', { seq: 2, label: 'second', childId: 'c2' }))
  const card = m.toCard('run-42')
  assert.deepStrictEqual(card.steps.map((s) => s.name), ['first', 'second', 'third'])
})

test('phase and log frames fold onto run state without inventing steps', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/start'))
  m.apply(frame('workflow/phase', 'Plan'))
  m.apply(frame('workflow/log', 'line 1'))
  m.apply(frame('workflow/log', 'line 2'))
  const card = m.toCard('run-42')
  assert.strictEqual(card.steps.length, 0)
  assert.strictEqual(card._phase, 'Plan')
  assert.deepStrictEqual(card._logs, ['line 1', 'line 2'])
})

test('phase accepts either a bare string or a { title } object', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/start'))
  m.apply(frame('workflow/phase', { title: 'Verify' }))
  assert.strictEqual(m.toCard('run-42')._phase, 'Verify')
})

test('unknown kind and malformed frames are dropped', () => {
  const m = createWorkflowLiveModel()
  assert.strictEqual(m.apply({ kind: 'workflow/bogus', runId: 'x', meta: META }), null)
  assert.strictEqual(m.apply(null), null)
  assert.strictEqual(m.apply(undefined), null)
  assert.strictEqual(m.apply({ kind: 'workflow/start' }), null) // no runId
  assert.strictEqual(m.apply({ kind: 'workflow/start', runId: null }), null)
  assert.strictEqual(m.apply('not-an-object'), null)
  assert.strictEqual(m.runs.size, 0)
})

test('agent frames with a non-finite seq are dropped', () => {
  const m = createWorkflowLiveModel()
  m.apply(frame('workflow/start'))
  m.apply(frame('workflow/agent-start', { label: 'no-seq', childId: 'c' }))
  m.apply(frame('workflow/agent-start', { seq: 'abc', label: 'bad-seq', childId: 'c2' }))
  assert.strictEqual(m.toCard('run-42').steps.length, 0)
})

test('toCard on an unknown run is null; forget/clear drop runs', () => {
  const m = createWorkflowLiveModel()
  assert.strictEqual(m.toCard('missing'), null)
  m.apply(frame('workflow/start'))
  assert.strictEqual(m.hasRun('run-42'), true)
  m.forget('run-42')
  assert.strictEqual(m.hasRun('run-42'), false)
  m.apply(frame('workflow/start'))
  m.clear()
  assert.strictEqual(m.runs.size, 0)
})

test('a run named only by runId falls back to runId as the card name', () => {
  const m = createWorkflowLiveModel()
  m.apply({ kind: 'workflow/start', runId: 'run-9' }) // no meta
  assert.strictEqual(m.toCard('run-9').name, 'run-9')
})

test('a later frame backfills a name the start frame lacked', () => {
  const m = createWorkflowLiveModel()
  m.apply({ kind: 'workflow/start', runId: 'run-7' })
  m.apply({ kind: 'workflow/phase', runId: 'run-7', meta: { name: 'late-name', description: 'd' }, payload: 'P' })
  assert.strictEqual(m.toCard('run-7').name, 'late-name')
})
