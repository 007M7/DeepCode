// Ticket #15 B (2026-07-17) — raw-inject classifier tests.
//
// Locks the envelope classification: tagged (envelope='context' or absent)
// returns null so the caller falls through to the existing inject-family
// classifier; envelope='raw' returns a typed shape record with:
//   * kind === meta.kind || null
//   * shape.shape === 'workspace-instructions' for known kinds, 'generic' else
// workspaceInstructionsSummary defends against missing / malformed meta.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isRawContextEvent,
  classifyRawInject,
  workspaceInstructionsSummary,
  RAW_KINDS,
  DEFAULT_RAW_KIND,
} = require('../src/renderer/raw-inject.js')

test('isRawContextEvent rejects non-context/message events', () => {
  assert.equal(isRawContextEvent({ type: 'user/message', data: { envelope: 'raw' } }), false)
  assert.equal(isRawContextEvent({ type: 'assistant/message', data: { envelope: 'raw' } }), false)
  assert.equal(isRawContextEvent(null), false)
  assert.equal(isRawContextEvent(undefined), false)
})

test('isRawContextEvent rejects tagged context/message', () => {
  assert.equal(isRawContextEvent({ type: 'context/message', data: {} }), false)
  assert.equal(isRawContextEvent({ type: 'context/message', data: { envelope: 'context' } }), false)
})

test('isRawContextEvent accepts envelope==="raw"', () => {
  assert.equal(isRawContextEvent({ type: 'context/message', data: { envelope: 'raw' } }), true)
})

test('classifyRawInject returns null for tagged / non-context events', () => {
  assert.equal(classifyRawInject({ type: 'user/message', data: { envelope: 'raw' } }), null)
  assert.equal(classifyRawInject({ type: 'context/message', data: {} }), null)
})

test('classifyRawInject resolves the workspace-instructions typed shape', () => {
  const ev = {
    type: 'context/message',
    data: {
      envelope: 'raw',
      source: { kind: 'plugin', plugin: 'workspace-context' },
      meta: { kind: 'workspace-instructions', version: '2026.07.17', changes: [] },
    },
  }
  const info = classifyRawInject(ev)
  assert.equal(info.envelope, 'raw')
  assert.equal(info.kind, 'workspace-instructions')
  assert.equal(info.shape.shape, 'workspace-instructions')
  assert.equal(info.shape.tone, 'raw')
})

test('classifyRawInject buckets unknown kinds into the generic fallback', () => {
  const ev = {
    type: 'context/message',
    data: {
      envelope: 'raw',
      meta: { kind: 'not-a-known-kind', foo: 42 },
    },
  }
  const info = classifyRawInject(ev)
  assert.equal(info.kind, 'not-a-known-kind')
  assert.equal(info.shape, DEFAULT_RAW_KIND)
  assert.equal(info.shape.shape, 'generic')
})

test('classifyRawInject accepts absent meta', () => {
  const ev = { type: 'context/message', data: { envelope: 'raw' } }
  const info = classifyRawInject(ev)
  assert.equal(info.kind, null)
  assert.equal(info.meta, null)
  assert.equal(info.shape, DEFAULT_RAW_KIND)
})

test('workspaceInstructionsSummary tolerates missing changes / version', () => {
  const empty = workspaceInstructionsSummary(null)
  assert.equal(empty.version, null)
  assert.deepEqual(empty.changes, [])
  const partial = workspaceInstructionsSummary({ version: 3, changes: 'not-an-array' })
  assert.equal(partial.version, '3')
  assert.deepEqual(partial.changes, [])
})

test('workspaceInstructionsSummary maps changes to {path, action}', () => {
  const meta = {
    version: '1.0',
    changes: [
      { path: 'src/a.ts', action: 'add' },
      { path: 'src/b.ts' },
      { path: 'src/c.ts', action: 'remove' },
      null,
      { not_a_change: true },
    ],
  }
  const summary = workspaceInstructionsSummary(meta)
  assert.equal(summary.version, '1.0')
  // null is filtered; the malformed entry passes through with defaults.
  assert.equal(summary.changes.length, 4)
  assert.deepEqual(summary.changes[0], { path: 'src/a.ts', action: 'add' })
  assert.deepEqual(summary.changes[1], { path: 'src/b.ts', action: null })
  assert.deepEqual(summary.changes[2], { path: 'src/c.ts', action: 'remove' })
  assert.deepEqual(summary.changes[3], { path: '', action: null })
})

test('RAW_KINDS + DEFAULT_RAW_KIND expose the tone/icon contract used by CSS', () => {
  assert.equal(RAW_KINDS['workspace-instructions'].tone, 'raw')
  assert.equal(RAW_KINDS['workspace-instructions'].icon, '¶')
  assert.equal(DEFAULT_RAW_KIND.tone, 'raw')
  assert.equal(DEFAULT_RAW_KIND.icon, '¶')
})
