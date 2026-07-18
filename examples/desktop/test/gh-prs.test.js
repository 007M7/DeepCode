// Tests for the pure helpers in src/main/gh-prs.js. `listPRs`/`detectGh` are
// I/O-injected — we drive them with a fake execFile so the suite never spawns
// the real gh binary. The row transform and time formatter are the two most
// load-bearing pieces because they're the contract between renderer and gh
// JSON.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  detectGh,
  detectRepo,
  listPRs,
  normalizePRRow,
  formatRelativeTime,
  filterAndGroup,
  demoRows,
} = require('../src/main/gh-prs.js')

// --- normalizePRRow ---------------------------------------------------------

test('normalizePRRow: open PR → stateDot=open', () => {
  const out = normalizePRRow({
    number: 12, title: 'feat: thing', state: 'OPEN', isDraft: false,
    mergeable: 'MERGEABLE', headRefName: 'feat/a', baseRefName: 'master',
    updatedAt: '2026-07-15T00:00:00Z', additions: 10, deletions: 2,
    author: { login: 'ZiyaZhang' }, url: 'https://github.com/x/y/pull/12',
  })
  assert.equal(out.stateDot, 'open')
  assert.equal(out.number, 12)
  assert.equal(out.authorLogin, 'ZiyaZhang')
  assert.equal(out.additions, 10)
  assert.equal(out.headRefName, 'feat/a')
})

test('normalizePRRow: draft PR → stateDot=draft', () => {
  const out = normalizePRRow({ number: 1, title: 't', state: 'OPEN', isDraft: true })
  assert.equal(out.stateDot, 'draft')
})

test('normalizePRRow: merged trumps draft', () => {
  const out = normalizePRRow({ number: 1, title: 't', state: 'MERGED', isDraft: true })
  assert.equal(out.stateDot, 'merged')
})

test('normalizePRRow: conflicting open PR → stateDot=conflict', () => {
  const out = normalizePRRow({
    number: 1, title: 't', state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING',
  })
  assert.equal(out.stateDot, 'conflict')
})

test('normalizePRRow: closed unmerged → stateDot=closed', () => {
  const out = normalizePRRow({ number: 1, title: 't', state: 'CLOSED' })
  assert.equal(out.stateDot, 'closed')
})

test('normalizePRRow: missing title falls back', () => {
  const out = normalizePRRow({ number: 5 })
  assert.equal(out.title, '(untitled)')
})

test('normalizePRRow: malformed input flagged as dropped', () => {
  const out = normalizePRRow(null)
  assert.equal(out.dropped, true)
  const out2 = normalizePRRow('not-an-object')
  assert.equal(out2.dropped, true)
})

test('normalizePRRow: author as string is tolerated', () => {
  const out = normalizePRRow({ number: 1, title: 't', state: 'OPEN', author: 'plainstring' })
  assert.equal(out.authorLogin, 'plainstring')
})

// --- formatRelativeTime -----------------------------------------------------

test('formatRelativeTime: recent → just now', () => {
  const now = new Date('2026-07-15T12:00:00Z')
  assert.equal(formatRelativeTime('2026-07-15T11:59:30Z', now), 'just now')
})

test('formatRelativeTime: minutes / hours / days / weeks', () => {
  const now = new Date('2026-07-15T12:00:00Z')
  assert.equal(formatRelativeTime('2026-07-15T11:55:00Z', now), '5m')
  assert.equal(formatRelativeTime('2026-07-15T09:00:00Z', now), '3h')
  assert.equal(formatRelativeTime('2026-07-13T12:00:00Z', now), '2d')
  assert.equal(formatRelativeTime('2026-06-30T12:00:00Z', now), '2w')
  assert.equal(formatRelativeTime('2026-05-05T12:00:00Z', now), '2mo')
})

test('formatRelativeTime: empty / bad input → empty string', () => {
  assert.equal(formatRelativeTime(''), '')
  assert.equal(formatRelativeTime('not-a-date'), '')
  assert.equal(formatRelativeTime(null), '')
})

// --- filterAndGroup ---------------------------------------------------------

test('filterAndGroup: all → open + closed buckets', () => {
  const rows = [
    normalizePRRow({ number: 1, title: 'a', state: 'OPEN' }),
    normalizePRRow({ number: 2, title: 'b', state: 'MERGED' }),
    normalizePRRow({ number: 3, title: 'c', state: 'CLOSED' }),
  ]
  const g = filterAndGroup(rows, { filter: 'all' })
  assert.equal(g.open.length, 1)
  assert.equal(g.closed.length, 2)
  assert.equal(g.total, 3)
})

test('filterAndGroup: open filter drops closed rows', () => {
  const rows = [
    normalizePRRow({ number: 1, title: 'a', state: 'OPEN' }),
    normalizePRRow({ number: 2, title: 'b', state: 'MERGED' }),
  ]
  const g = filterAndGroup(rows, { filter: 'open' })
  assert.equal(g.open.length, 1)
  assert.equal(g.closed.length, 0)
})

test('filterAndGroup: mine requires viewer + login match (case-insensitive)', () => {
  const rows = [
    normalizePRRow({ number: 1, title: 'a', state: 'OPEN', author: { login: 'ZiyaZhang' } }),
    normalizePRRow({ number: 2, title: 'b', state: 'OPEN', author: { login: 'other' } }),
  ]
  const g = filterAndGroup(rows, { filter: 'mine', viewer: 'ziyazhang' })
  assert.equal(g.total, 1)
  assert.equal(g.open[0].number, 1)
})

test('filterAndGroup: mine with no viewer returns empty', () => {
  const rows = [normalizePRRow({ number: 1, title: 'a', state: 'OPEN' })]
  const g = filterAndGroup(rows, { filter: 'mine' })
  assert.equal(g.total, 0)
})

test('filterAndGroup: dropped rows never appear', () => {
  const rows = [normalizePRRow(null), normalizePRRow({ number: 1, title: 'a', state: 'OPEN' })]
  const g = filterAndGroup(rows, { filter: 'all' })
  assert.equal(g.total, 1)
})

// --- listPRs (injected execFile) -------------------------------------------

test('listPRs: parses gh json into normalized rows', async () => {
  const fakeGh = (bin, args, opts, cb) => {
    assert.equal(bin, 'gh')
    assert.deepEqual(args.slice(0, 2), ['pr', 'list'])
    assert.equal(opts.cwd, '/tmp/repo')
    const stdout = JSON.stringify([
      { number: 1, title: 't', state: 'OPEN', headRefName: 'x', baseRefName: 'main',
        updatedAt: '2026-07-15T00:00:00Z', additions: 3, deletions: 1,
        author: { login: 'me' }, url: 'https://github.com/o/r/pull/1' },
    ])
    process.nextTick(() => cb(null, stdout, ''))
  }
  const { rows } = await listPRs({ cwd: '/tmp/repo', execFile: fakeGh })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].number, 1)
  assert.equal(rows[0].stateDot, 'open')
})

test('listPRs: propagates gh errors with stderr', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => {
    process.nextTick(() => cb(Object.assign(new Error('exit 4'), { code: 4 }),
      '', 'not a git repository'))
  }
  await assert.rejects(
    () => listPRs({ cwd: '/tmp/nope', execFile: fakeGh }),
    (err) => /not a git repository/.test(err.message),
  )
})

test('listPRs: bad JSON rejects with a helpful message', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(() => cb(null, 'not json', ''))
  await assert.rejects(
    () => listPRs({ cwd: '/tmp/x', execFile: fakeGh }),
    (err) => /JSON parse/.test(err.message),
  )
})

test('listPRs: non-array JSON rejects', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(() => cb(null, '{"x":1}', ''))
  await assert.rejects(() => listPRs({ cwd: '/tmp/x', execFile: fakeGh }),
    (err) => /expected JSON array/.test(err.message))
})

test('listPRs: rejects when cwd is missing', async () => {
  await assert.rejects(() => listPRs({}), (err) => /needs .* cwd/.test(err.message))
})

// --- detectGh --------------------------------------------------------------

test('detectGh: ENOENT → available:false with a specific reason', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(
    () => cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })))
  const r = await detectGh({ execFile: fakeGh })
  assert.equal(r.available, false)
  assert.match(r.reason, /not found/)
})

test('detectGh: success → available:true', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(() => cb(null, 'logged in', ''))
  const r = await detectGh({ execFile: fakeGh })
  assert.equal(r.available, true)
})

test('detectGh: auth failure → available:false', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(
    () => cb(new Error('unauth'), '', 'You are not logged into any GitHub hosts.'))
  const r = await detectGh({ execFile: fakeGh })
  assert.equal(r.available, false)
  assert.match(r.reason, /not logged/)
})

// --- detectRepo ------------------------------------------------------------

test('detectRepo: parses nameWithOwner', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(
    () => cb(null, JSON.stringify({ nameWithOwner: 'deepseek-harness/deepseek-harness' }), ''))
  const r = await detectRepo({ cwd: '/tmp/repo', execFile: fakeGh })
  assert.equal(r, 'deepseek-harness/deepseek-harness')
})

test('detectRepo: error → null', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(() => cb(new Error('nope')))
  const r = await detectRepo({ cwd: '/tmp/repo', execFile: fakeGh })
  assert.equal(r, null)
})

test('detectRepo: bad json → null (not a crash)', async () => {
  const fakeGh = (_bin, _args, _opts, cb) => process.nextTick(() => cb(null, 'nope', ''))
  const r = await detectRepo({ cwd: '/tmp/repo', execFile: fakeGh })
  assert.equal(r, null)
})

// --- demoRows --------------------------------------------------------------

test('demoRows: returns normalized, stateDot-tagged rows', () => {
  const rows = demoRows(new Date('2026-07-15T12:00:00Z'))
  assert.ok(rows.length >= 3)
  for (const r of rows) {
    assert.ok(['open', 'draft', 'conflict', 'merged', 'closed'].includes(r.stateDot))
    assert.ok(r.number > 0)
    assert.ok(r.url.startsWith('https://github.com/'))
  }
})
