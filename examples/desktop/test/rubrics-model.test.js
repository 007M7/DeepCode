// Pure-model tests for rubrics-model. Covers catalog projection, SKILL.md
// parse, 28-subtask flat picker, checklist preview. Runs under `node --test`.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const R = require('../src/renderer/rubrics-model.js')

test('TASK_CATEGORIES has 7 groups with 28 total subtasks', () => {
  assert.equal(R.TASK_CATEGORIES.length, 7)
  const total = R.TASK_CATEGORIES.reduce((s, c) => s + c.subtasks.length, 0)
  assert.equal(total, 28, 'RL plan locks 28 subtasks — do not drop or add without a plan update')
})

test('MULTI_TURN_DIMENSIONS is exactly the 5 fixed dims in order', () => {
  const ids = R.MULTI_TURN_DIMENSIONS.map(d => d.id)
  assert.deepEqual(ids, [
    'feedback-understanding',
    'fix-effectiveness',
    'no-regression',
    'over-correction',
    'convergence',
  ])
})

test('parseRubricFile: SKILL.md with frontmatter + checklist round-trips', () => {
  const txt = [
    '---',
    'name: bug-fix',
    'group: fix-optimize',
    'template: fixed',
    'executor: llm-judge',
    'description: Rubric for evaluating bug-fix trajectories',
    '---',
    '',
    '## Checklist',
    '- reproduces the reported failure',
    '- patch is minimal (no unrelated changes)',
    '- tests updated or added',
    '- no obvious regressions',
    '- explanation is clear',
    '',
    '## Notes',
    '- Prefer patches that add a regression test.',
    '',
  ].join('\n')
  const r = R.parseRubricFile(txt)
  assert.equal(r.name, 'bug-fix')
  assert.equal(r.group, 'fix-optimize')
  assert.equal(r.template, 'fixed')
  assert.equal(r.executor, 'llm-judge')
  assert.equal(r.checklist.length, 5)
  assert.equal(r.checklist[0], 'reproduces the reported failure')
  assert.equal(r.description, 'Rubric for evaluating bug-fix trajectories')
})

test('parseRubricFile: garbage returns null; body-only returns unnamed record', () => {
  assert.equal(R.parseRubricFile(null), null)
  assert.equal(R.parseRubricFile(''), null)
  const bodyOnly = R.parseRubricFile('## Checklist\n- a\n- b\n')
  assert.equal(bodyOnly.name, 'unnamed')
  assert.equal(bodyOnly.checklist.length, 2)
})

test('buildCatalog: groups preserve TASK_CATEGORIES ordering; orphans bucket appears when needed', () => {
  const rubrics = [
    { id: 'bug', name: 'bug', group: 'fix-optimize', template: 'fixed', checklist: [] },
    { id: 'svg', name: 'svg', group: 'interaction-reasoning', template: 'per-prompt', checklist: [] },
    { id: 'weird', name: 'weird', group: 'no-such-group', template: 'fixed', checklist: [] },
  ]
  const cat = R.buildCatalog(rubrics)
  // 7 known groups + 1 orphan bucket
  assert.equal(cat.length, 8)
  assert.equal(cat[0].category.id, 'code-gen')
  assert.equal(cat[2].category.id, 'fix-optimize')
  assert.equal(cat[2].rubrics.length, 1)
  assert.equal(cat[5].category.id, 'interaction-reasoning')
  assert.equal(cat[7].category.id, 'uncategorized')
  assert.equal(cat[7].rubrics.length, 1)
})

test('buildCatalog: no orphans → last entry is the 7th real group, not uncategorized', () => {
  const cat = R.buildCatalog([
    { id: 'a', name: 'a', group: 'code-gen', template: 'fixed', checklist: [] },
  ])
  assert.equal(cat.length, 7)
  assert.equal(cat[cat.length - 1].category.id, 'repo-level')
})

test('checklistPreview: joins first 3 items with "·"; short lists keep everything', () => {
  const r = { checklist: ['a', 'b', 'c', 'd', 'e'] }
  assert.equal(R.checklistPreview(r), 'a · b · c')
  const shortR = { checklist: ['x'] }
  assert.equal(R.checklistPreview(shortR), 'x')
  assert.equal(R.checklistPreview({ checklist: [] }), '')
})

test('flatSubtaskList: 28 entries, each carries groupId/groupName/subtaskId', () => {
  const list = R.flatSubtaskList()
  assert.equal(list.length, 28)
  const first = list[0]
  assert.equal(first.groupId, 'code-gen')
  assert.equal(first.groupName, 'Code generation')
  assert.ok(first.subtaskId)
})

test('totalSubtaskCount matches flatSubtaskList length and locked total', () => {
  assert.equal(R.totalSubtaskCount(), 28)
})

test('getCategory: returns null for unknown group', () => {
  assert.equal(R.getCategory('nope'), null)
  assert.equal(R.getCategory('code-gen').id, 'code-gen')
})

// ─── Dimension type primitives (reference tracing UI FeedbackSchema parity) ───────

test('DIMENSION_TYPES exposes the three canonical primitives with defaults', () => {
  const ids = R.DIMENSION_TYPES.map(t => t.id)
  assert.deepEqual(ids, ['continuous', 'categorical', 'boolean'])
  // Each primitive carries the render defaults the Create form pre-fills.
  const cont = R.DIMENSION_TYPES.find(t => t.id === 'continuous')
  assert.equal(cont.defaultMin, 0)
  assert.equal(cont.defaultMax, 1)
  const cat = R.DIMENSION_TYPES.find(t => t.id === 'categorical')
  assert.deepEqual(cat.defaultValues, ['bad', 'ok', 'good'])
  const bool = R.DIMENSION_TYPES.find(t => t.id === 'boolean')
  assert.deepEqual(bool.defaultLabels, { true: 'true', false: 'false' })
})

test('MULTI_TURN_DIMENSIONS legacy 1-5 dims all carry type=continuous min=1 max=5', () => {
  // Shape-lock: existing stored records were 1-5 ints; the type spec must
  // preserve that so old data reads back the same. If someone changes the
  // spec, they must migrate existing localStorage records too.
  for (const d of R.MULTI_TURN_DIMENSIONS) {
    assert.equal(d.type, 'continuous', d.id + ' stays continuous')
    assert.equal(d.min, 1, d.id + ' min=1')
    assert.equal(d.max, 5, d.id + ' max=5')
  }
})

test('normalizeDimSpec fills defaults for each primitive; rejects garbage', () => {
  assert.equal(R.normalizeDimSpec(null), null)
  assert.equal(R.normalizeDimSpec('nope'), null)
  const cont = R.normalizeDimSpec({ id: 'quality', type: 'continuous', min: 0, max: 10 })
  assert.equal(cont.min, 0)
  assert.equal(cont.max, 10)
  const contFlipped = R.normalizeDimSpec({ id: 'q', type: 'continuous', min: 10, max: 0 })
  assert.equal(contFlipped.min, 0, 'inverted range is auto-swapped')
  assert.equal(contFlipped.max, 10)
  const contDegen = R.normalizeDimSpec({ id: 'q', type: 'continuous', min: 5, max: 5 })
  assert.equal(contDegen.max, 6, 'zero-span coerces to min+1')
  const cat = R.normalizeDimSpec({ id: 'verdict', type: 'categorical', values: ['red', 'yellow', 'green'] })
  assert.deepEqual(cat.values, ['red', 'yellow', 'green'])
  const catDefault = R.normalizeDimSpec({ id: 'verdict', type: 'categorical' })
  assert.deepEqual(catDefault.values, ['bad', 'ok', 'good'], 'no values falls back to default enum')
  const bool = R.normalizeDimSpec({ id: 'passes', type: 'boolean', labels: { true: 'pass', false: 'fail' } })
  assert.deepEqual(bool.labels, { true: 'pass', false: 'fail' })
})

test('clampDimValue coerces per primitive; returns undefined for unrepresentable input', () => {
  const cont = { id: 'q', type: 'continuous', min: 1, max: 5 }
  assert.equal(R.clampDimValue(cont, 3), 3)
  assert.equal(R.clampDimValue(cont, 9), 5, 'clamps up to max')
  assert.equal(R.clampDimValue(cont, -1), 1, 'clamps down to min')
  assert.equal(R.clampDimValue(cont, 3.7), 4, 'integer-valued small range rounds')
  assert.equal(R.clampDimValue(cont, null), undefined)
  assert.equal(R.clampDimValue(cont, 'nope'), undefined)
  const cont01 = { id: 'p', type: 'continuous', min: 0, max: 1 }
  assert.equal(R.clampDimValue(cont01, 0.42), 0.42, 'small float range preserves float')
  const cat = { id: 'v', type: 'categorical', values: ['bad', 'ok', 'good'] }
  assert.equal(R.clampDimValue(cat, 'ok'), 'ok')
  assert.equal(R.clampDimValue(cat, 'excellent'), undefined, 'non-enum returns undefined')
  const bool = { id: 'x', type: 'boolean' }
  assert.equal(R.clampDimValue(bool, true), true)
  assert.equal(R.clampDimValue(bool, 'true'), true)
  assert.equal(R.clampDimValue(bool, 0), false)
  assert.equal(R.clampDimValue(bool, 'maybe'), undefined)
})

test('normalizeReward folds all three primitives into 0-1', () => {
  const cont = { id: 'q', type: 'continuous', min: 1, max: 5 }
  assert.equal(R.normalizeReward(cont, 1), 0)
  assert.equal(R.normalizeReward(cont, 5), 1)
  assert.equal(R.normalizeReward(cont, 3), 0.5)
  const cat = { id: 'v', type: 'categorical', values: ['bad', 'ok', 'good'] }
  assert.equal(R.normalizeReward(cat, 'bad'), 0)
  assert.equal(R.normalizeReward(cat, 'good'), 1)
  assert.equal(R.normalizeReward(cat, 'ok'), 0.5)
  const bool = { id: 'x', type: 'boolean' }
  assert.equal(R.normalizeReward(bool, true), 1)
  assert.equal(R.normalizeReward(bool, false), 0)
  assert.equal(R.normalizeReward(bool, 'nope'), null)
})

test('parseDimensionsBlock reads all three primitives from a ## Dimensions block', () => {
  const body = [
    '## Dimensions',
    '- quality :: continuous :: 0-10',
    '- verdict :: categorical :: red,yellow,green :: Verdict',
    '- passes  :: boolean :: pass/fail :: Passes bench',
    '',
    '## Notes',
    '- ignored line',
  ].join('\n')
  const dims = R.parseDimensionsBlock(body)
  assert.equal(dims.length, 3)
  assert.equal(dims[0].id, 'quality')
  assert.equal(dims[0].type, 'continuous')
  assert.equal(dims[0].min, 0)
  assert.equal(dims[0].max, 10)
  assert.equal(dims[1].type, 'categorical')
  assert.deepEqual(dims[1].values, ['red', 'yellow', 'green'])
  assert.equal(dims[2].type, 'boolean')
  assert.deepEqual(dims[2].labels, { true: 'pass', false: 'fail' })
})

test('parseDimensionsBlock is lenient: unknown types drop, malformed lines drop', () => {
  const body = [
    '## Dimensions',
    '- ok :: continuous :: 0-1',
    '- badtype :: rainbow :: whatever',
    '- toofew',
    '',
  ].join('\n')
  const dims = R.parseDimensionsBlock(body)
  assert.equal(dims.length, 1)
  assert.equal(dims[0].id, 'ok')
})

test('parseRubricFile picks up a Dimensions block when present', () => {
  const txt = [
    '---',
    'name: quality',
    'group: code-gen',
    'template: fixed',
    '---',
    '',
    '## Dimensions',
    '- verdict :: categorical :: bad,ok,good',
    '- passes  :: boolean :: pass/fail',
    '',
    '## Checklist',
    '- item',
    '',
  ].join('\n')
  const r = R.parseRubricFile(txt)
  assert.equal(r.dimensions.length, 2)
  assert.equal(r.dimensions[0].type, 'categorical')
  assert.equal(r.dimensions[1].type, 'boolean')
  // Existing checklist parse still works.
  assert.equal(r.checklist[0], 'item')
})

test('parseRubricFile: rubric without Dimensions block has dimensions=[] (backward compat)', () => {
  const txt = [
    '---',
    'name: legacy',
    'group: code-gen',
    'template: fixed',
    '---',
    '## Checklist',
    '- a',
  ].join('\n')
  const r = R.parseRubricFile(txt)
  assert.deepEqual(r.dimensions, [], 'no block → empty list, not undefined')
})

test('dimensionsForRubric: explicit dimensions win, multi-turn falls back to 5 fixed', () => {
  const custom = { dimensions: [{ id: 'q', type: 'continuous', min: 0, max: 10 }] }
  assert.equal(R.dimensionsForRubric(custom).length, 1)
  const mtu = { template: 'multi-turn' }
  const dims = R.dimensionsForRubric(mtu)
  assert.equal(dims.length, 5)
  assert.equal(dims[0].type, 'continuous')
  // Fixed non-multi-turn rubrics with no dims = empty (checklist only).
  assert.deepEqual(R.dimensionsForRubric({ template: 'fixed' }), [])
})
