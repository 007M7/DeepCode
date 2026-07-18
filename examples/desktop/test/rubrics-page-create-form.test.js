// Tests for the Rubrics-page Create-from-scratch form (typed rubric
// primitive). The form is a script-tag IIFE that installs
// `window.__dshRubrics` at runtime; under `node --test` we `require()`
// it, which runs the IIFE with `typeof window === 'undefined'` — so the
// state + internals live on the CommonJS module.exports handle.
//
// We stub just enough of `document` so the module loads cleanly.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

global.document = {
  addEventListener() {},
  readyState: 'complete',
  querySelector() { return null },
  createElement() {
    // Minimal element used only if openCreateForm's scroll-into-view path
    // fires. We short-circuit by returning `null` from querySelector
    // above; this stub is a defensive fallback.
    return { style: {}, appendChild() {}, addEventListener() {} }
  },
  getElementById() { return null },
}
global.requestAnimationFrame = () => {}

const page = require('../src/renderer/rubrics-page.js')
const model = require('../src/renderer/rubrics-model.js')
const { state, draftAsMarkdown, buildDraftDimensionLine, slug, openCreateForm, closeCreateForm, saveCreateForm } = page._internal

function reset() {
  state.rubrics = []
  state.catalog = []
  state.active = null
  state.editMode = false
  state.createForm = null
}

test('openCreateForm seeds a draft; closeCreateForm clears it', () => {
  reset()
  openCreateForm('llm-judge')
  assert.ok(state.createForm, 'form draft present after open')
  assert.equal(state.createForm.executor, 'llm-judge')
  assert.equal(state.createForm.dimType, 'continuous', 'continuous is the default type')
  closeCreateForm()
  assert.equal(state.createForm, null)
})

test('slug produces filename-safe ids', () => {
  assert.equal(slug('Feedback Tag'), 'feedback-tag')
  assert.equal(slug('bad!!/name'), 'bad-name')
  assert.equal(slug(''), 'unnamed')
  assert.equal(slug('   '), 'unnamed')
})

test('buildDraftDimensionLine emits parseable syntax for each primitive', () => {
  const cont = buildDraftDimensionLine({ dimName: 'quality', dimType: 'continuous', min: 0, max: 10 })
  assert.match(cont, /^quality :: continuous :: 0-10 :: quality$/)
  const cat = buildDraftDimensionLine({ dimName: 'verdict', dimType: 'categorical', values: ['red', 'green'] })
  assert.match(cat, /categorical :: red,green/)
  const bool = buildDraftDimensionLine({ dimName: 'passes bench', dimType: 'boolean', labels: { true: 'pass', false: 'fail' } })
  assert.match(bool, /^passes-bench :: boolean :: pass\/fail/)
})

test('draftAsMarkdown round-trips through parseRubricFile for each primitive', () => {
  const drafts = [
    { dimName: 'quality', dimType: 'continuous', min: 0, max: 10, group: 'code-gen', executor: 'llm-judge' },
    { dimName: 'verdict', dimType: 'categorical', values: ['red', 'green', 'blue'], group: 'code-gen', executor: 'llm-judge' },
    { dimName: 'passes', dimType: 'boolean', labels: { true: 'pass', false: 'fail' }, group: 'code-gen', executor: 'llm-judge' },
  ]
  const wantTypes = ['continuous', 'categorical', 'boolean']
  for (let i = 0; i < drafts.length; i++) {
    const md = draftAsMarkdown(drafts[i])
    const parsed = model.parseRubricFile(md)
    assert.ok(parsed, drafts[i].dimType + ' parses')
    assert.equal(parsed.dimensions.length, 1, drafts[i].dimType + ' emits one dim')
    assert.equal(parsed.dimensions[0].type, wantTypes[i])
  }
})

test('saveCreateForm inserts a parsed rubric into state; upsert on same name', () => {
  reset()
  openCreateForm('llm-judge')
  state.createForm = {
    ...state.createForm,
    dimName: 'quality',
    dimType: 'continuous',
    min: 0,
    max: 10,
  }
  saveCreateForm()
  assert.equal(state.rubrics.length, 1)
  assert.equal(state.rubrics[0].name, 'quality')
  assert.equal(state.rubrics[0].dimensions[0].type, 'continuous')
  // Second save with same slug replaces, not duplicates.
  openCreateForm('llm-judge')
  state.createForm = { ...state.createForm, dimName: 'quality', dimType: 'boolean', labels: { true: 'y', false: 'n' } }
  saveCreateForm()
  assert.equal(state.rubrics.length, 1, 'upsert by slug, no duplicate')
  assert.equal(state.rubrics[0].dimensions[0].type, 'boolean')
})

test('saveCreateForm fires dsh:rubric-created for lane consumers', () => {
  reset()
  const events = []
  const prevWin = global.window
  global.window = {
    __dshAnnotation: null,
    dispatchEvent(ev) { events.push(ev); return true },
  }
  global.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail } }
  try {
    openCreateForm('llm-judge')
    state.createForm = { ...state.createForm, dimName: 'signal', dimType: 'continuous', min: 0, max: 1 }
    saveCreateForm()
    const ev = events.find(e => e.type === 'dsh:rubric-created')
    assert.ok(ev, 'dsh:rubric-created fires')
    assert.equal(ev.detail.rubricId, 'signal')
  } finally {
    global.window = prevWin
  }
})
