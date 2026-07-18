// Compact card meta rendering — now on the "Policy & accounting" tab (task #137).
//
// Post demo 批 2 §1.7, the meta line moved out of `.compact-card .meta`
// and into a definition-list rendered inside the third tab of the new
// three-tab shell. Ticket F fields (model / maxTokens / reason) still
// land here, alongside §1.7's trigger kind / shadowedRange /
// shadowedTokenCount / shadowedSeqs.length rows.
//
// Missing/whitespace fields drop rows — never render "unknown" placeholders.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

async function driveCompact(dataOverride) {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('sid-meta', { title: 't', header: {} })
  await renderer.selectSession('sid-meta')
  renderer.onSessionEvent('sid-meta', {
    type: 'compact/summary',
    seq: 12,
    time: 2,
    data: {
      summary: [{ type: 'text', text: 'summary body.' }],
      shadowedTokenCount: 640,
      shadowedSeqs: [1, 2, 3],
      ...dataOverride,
    },
  })
  return { renderer, document }
}

function metaRows(document) {
  const card = document.querySelector('.compact-card')
  if (!card) return null
  const dl = card.querySelector('.compact-card-tab-meta')
  if (!dl) return null
  const rows = []
  const kids = Array.from(dl.children || [])
  for (let i = 0; i + 1 < kids.length; i += 2) {
    const dt = kids[i]
    const dd = kids[i + 1]
    if (dt && dd) rows.push({ label: dt.textContent, value: dd.textContent })
  }
  return rows
}
function findRow(rows, label) {
  if (!rows) return null
  return rows.find((r) => r.label === label) || null
}

test('meta tab renders model as its own row', async () => {
  const { document } = await driveCompact({ model: 'test-model-42' })
  const row = findRow(metaRows(document), 'Summary model')
  assert.ok(row, 'meta tab must include Summary model row when data.model is present')
  assert.equal(row.value, 'test-model-42')
})

test('meta tab renders maxTokens as ≤N tok', async () => {
  const { document } = await driveCompact({ model: 'x', maxTokens: 8192 })
  const row = findRow(metaRows(document), 'Summary cap')
  assert.ok(row)
  assert.equal(row.value, '≤8192 tok')
})

test('meta tab renders trimmed user reason', async () => {
  const { document } = await driveCompact({
    model: 'x', reason: 'freeing headroom before a long browse',
  })
  const row = findRow(metaRows(document), 'User reason')
  assert.ok(row)
  assert.equal(row.value, 'freeing headroom before a long browse')
})

test('meta tab drops empty/whitespace reason', async () => {
  const { document } = await driveCompact({ model: 'x', reason: '   ' })
  assert.equal(findRow(metaRows(document), 'User reason'), null)
})

test('meta tab drops non-number maxTokens (legacy null)', async () => {
  const { document } = await driveCompact({ model: 'x', maxTokens: null })
  assert.equal(findRow(metaRows(document), 'Summary cap'), null)
})

test('meta tab always renders trigger row (Trigger) even for bare compact', async () => {
  const { document } = await driveCompact({})
  const row = findRow(metaRows(document), 'Trigger')
  assert.ok(row, 'trigger row is mandatory — always tells the reader why compaction fired')
  assert.match(row.value, /idle/)
})

test('meta tab renders shadowedRange as seq X – Y', async () => {
  const { document } = await driveCompact({
    shadowedRange: { start: 10, end: 90 },
  })
  const row = findRow(metaRows(document), 'Compacted range')
  assert.ok(row)
  assert.equal(row.value, 'seq 10 – 90')
})
