// Pure-fn tests for the PR page filter + chip-count helpers.
//
// The renderer file registers a `window.__dshPRs` handle when window is
// present, so we run it under a minimal stub — enough to let the IIFE
// evaluate — and then read the helpers off the module.exports seam.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

function loadModule() {
  const p = require.resolve('../src/renderer/pr-page.js')
  delete require.cache[p]
  // The IIFE checks `typeof window !== 'undefined'` before touching the DOM
  // handle. Leaving window undefined here means the module goes straight to
  // the module.exports seam without ever calling document.getElementById.
  return require('../src/renderer/pr-page.js')
}

const { _internal } = loadModule()
const { matchesFilter, matchesQuery, computeChipCounts } = _internal

// Row factory — mirrors the shape gh-prs.js emits.
function row(overrides) {
  return {
    number: 1, title: 'sample', state: 'OPEN', stateDot: 'open',
    headRefName: 'feature/x', baseRefName: 'master',
    authorLogin: 'zi', additions: 10, deletions: 2,
    url: 'https://example', updatedAt: new Date().toISOString(),
    dropped: false,
    ...overrides,
  }
}

// ---- matchesFilter ---------------------------------------------------------

test('matchesFilter: all keeps every non-dropped row regardless of state', () => {
  assert.equal(matchesFilter(row({ state: 'OPEN' }),   'all', 'zi'), true)
  assert.equal(matchesFilter(row({ state: 'MERGED' }), 'all', 'zi'), true)
  assert.equal(matchesFilter(row({ state: 'CLOSED' }), 'all', 'zi'), true)
})

test('matchesFilter: dropped rows are always excluded', () => {
  assert.equal(matchesFilter(row({ dropped: true }), 'all',  ''),   false)
  assert.equal(matchesFilter(row({ dropped: true }), 'open', ''),   false)
  assert.equal(matchesFilter(row({ dropped: true }), 'mine', 'zi'), false)
})

test('matchesFilter: open keeps only OPEN rows', () => {
  assert.equal(matchesFilter(row({ state: 'OPEN' }),   'open', ''), true)
  assert.equal(matchesFilter(row({ state: 'MERGED' }), 'open', ''), false)
  assert.equal(matchesFilter(row({ state: 'CLOSED' }), 'open', ''), false)
  assert.equal(matchesFilter(row({ state: 'DRAFT' }),  'open', ''), false)
})

test('matchesFilter: mine requires a viewer and exact case-insensitive match', () => {
  assert.equal(matchesFilter(row({ authorLogin: 'zi' }), 'mine', ''),        false, 'no viewer ⇒ nothing is "mine"')
  assert.equal(matchesFilter(row({ authorLogin: 'zi' }), 'mine', 'zi'),      true)
  assert.equal(matchesFilter(row({ authorLogin: 'ZI' }), 'mine', 'zi'),      true, 'case-insensitive')
  assert.equal(matchesFilter(row({ authorLogin: 'other' }), 'mine', 'zi'),   false)
})

// ---- matchesQuery ----------------------------------------------------------

test('matchesQuery: empty query matches everything', () => {
  assert.equal(matchesQuery(row({}), ''), true)
})

test('matchesQuery: hits on title / branch / author / #number', () => {
  const r = row({
    number: 42, title: 'RFC: gui host integration',
    headRefName: 'rfc/gui-host', authorLogin: 'tianyi',
  })
  assert.equal(matchesQuery(r, 'gui'),      true, 'title')
  assert.equal(matchesQuery(r, 'rfc/'),     true, 'branch')
  assert.equal(matchesQuery(r, 'tianyi'),   true, 'author')
  assert.equal(matchesQuery(r, '42'),       true, 'number substring')
  assert.equal(matchesQuery(r, 'nowhere'),  false)
})

// ---- computeChipCounts -----------------------------------------------------

test('computeChipCounts: pill counts reflect current query', () => {
  const rows = [
    row({ state: 'OPEN',   authorLogin: 'zi',    title: 'runtime seam'  }),
    row({ state: 'OPEN',   authorLogin: 'other', title: 'seam docs'     }),
    row({ state: 'MERGED', authorLogin: 'zi',    title: 'runtime tests' }),
    row({ state: 'CLOSED', authorLogin: 'zi',    title: 'other'         }),
    row({ dropped: true,   authorLogin: 'zi',    title: 'runtime x'     }),
  ]
  assert.deepEqual(computeChipCounts(rows, 'zi', ''),        { all: 4, open: 2, mine: 3 })
  assert.deepEqual(computeChipCounts(rows, 'zi', 'runtime'), { all: 2, open: 1, mine: 2 })
  assert.deepEqual(computeChipCounts(rows, '',   ''),        { all: 4, open: 2, mine: 0 },
    'no viewer ⇒ mine=0 even for rows whose author matches nothing')
})

test('computeChipCounts: chip-count math matches filterRows post-hoc', () => {
  // The count next to a chip must equal what pressing that chip would show.
  // This test rebuilds that expectation manually and pins the invariant.
  const rows = [
    row({ state: 'OPEN', authorLogin: 'zi' }),
    row({ state: 'OPEN', authorLogin: 'other' }),
    row({ state: 'MERGED', authorLogin: 'zi' }),
  ]
  const q = ''
  const counts = computeChipCounts(rows, 'zi', q)
  const bucket = (filter) =>
    rows.filter((r) => matchesFilter(r, filter, 'zi') && matchesQuery(r, q)).length
  assert.equal(counts.all,  bucket('all'))
  assert.equal(counts.open, bucket('open'))
  assert.equal(counts.mine, bucket('mine'))
})
