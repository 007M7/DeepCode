// interact-cards.test.js — pure-module tests for §2 interaction card helpers.
//
// Covers status strip state machine, exit_plan_mode detection, plan preview
// derivation, and steer chip labelling. Runs under `node --test`, no DOM.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const IC = require('../src/renderer/interact-cards.js')

// -- STATUS ------------------------------------------------------------------

test('STATUS: exposes exactly waiting/confirmed/skipped in that order', () => {
  assert.deepEqual(IC.STATUS_KEYS, ['waiting', 'confirmed', 'skipped'])
  assert.equal(IC.STATUS.waiting.color, 'warn')
  assert.equal(IC.STATUS.confirmed.color, 'ok')
  assert.equal(IC.STATUS.skipped.color, 'muted')
})

// -- statusFromOutcome -------------------------------------------------------

test('statusFromOutcome: accepted / confirmed → confirmed', () => {
  assert.equal(IC.statusFromOutcome('accepted').key, 'confirmed')
  assert.equal(IC.statusFromOutcome('confirmed').key, 'confirmed')
})

test('statusFromOutcome: rejected / cancelled / skipped / dismissed → skipped', () => {
  for (const o of ['rejected', 'cancelled', 'skipped', 'dismissed']) {
    assert.equal(IC.statusFromOutcome(o).key, 'skipped', `outcome=${o}`)
  }
})

test('statusFromOutcome: unknown outcome stays on waiting (safe default)', () => {
  assert.equal(IC.statusFromOutcome(undefined).key, 'waiting')
  assert.equal(IC.statusFromOutcome('mystery').key, 'waiting')
})

// -- isExitPlanModeSpec ------------------------------------------------------

test('isExitPlanModeSpec: explicit kind wins', () => {
  assert.equal(IC.isExitPlanModeSpec({ kind: 'exit_plan_mode' }), true)
})

test('isExitPlanModeSpec: non-empty plan string counts', () => {
  assert.equal(IC.isExitPlanModeSpec({ plan: '1. do a thing\n2. do another' }), true)
})

test('isExitPlanModeSpec: empty plan or unrelated spec is false', () => {
  assert.equal(IC.isExitPlanModeSpec({ plan: '   ' }), false)
  assert.equal(IC.isExitPlanModeSpec({ title: 'What?' }), false)
  assert.equal(IC.isExitPlanModeSpec(null), false)
})

// -- previewLinesFromPlan ----------------------------------------------------

test('previewLinesFromPlan: numbered lines become + sigils', () => {
  const lines = IC.previewLinesFromPlan([
    '1. Extract the deploy script',
    '2. Add a CI check',
    'note: keep the docs in sync',
    '- also: refresh screenshots',
  ].join('\n'))
  assert.deepEqual(lines, [
    { sigil: '+', text: 'Extract the deploy script' },
    { sigil: '+', text: 'Add a CI check' },
    { sigil: ' ', text: 'note: keep the docs in sync' },
    { sigil: '+', text: 'also: refresh screenshots' },
  ])
})

test('previewLinesFromPlan: empty in, empty out', () => {
  assert.deepEqual(IC.previewLinesFromPlan(''), [])
  assert.deepEqual(IC.previewLinesFromPlan(null), [])
})

// -- chipLabelFromSteerSpec --------------------------------------------------

test('chipLabelFromSteerSpec: prefers chipLabel → title → label → message', () => {
  assert.equal(IC.chipLabelFromSteerSpec({ chipLabel: 'A', title: 'B' }), 'A')
  assert.equal(IC.chipLabelFromSteerSpec({ title: 'B', label: 'C' }), 'B')
  assert.equal(IC.chipLabelFromSteerSpec({ label: 'C', message: 'D' }), 'C')
  assert.equal(IC.chipLabelFromSteerSpec({ message: 'D' }), 'D')
})

test('chipLabelFromSteerSpec: falls back to "steer" for empty spec', () => {
  assert.equal(IC.chipLabelFromSteerSpec({}), 'steer')
  assert.equal(IC.chipLabelFromSteerSpec(null), 'steer')
})

test('chipLabelFromSteerSpec: truncates to 60 chars with ellipsis', () => {
  const long = 'x'.repeat(120)
  const out = IC.chipLabelFromSteerSpec({ title: long })
  assert.equal(out.length, 60)
  assert.ok(out.endsWith('…'))
})
