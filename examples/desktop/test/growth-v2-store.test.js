// Storage-side tests for growth-v2. We point DSH_GROWTH_HOME at a per-test
// tmp dir so real ~/.dsh/ never gets touched by the test suite.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-growth-v2-'))
  const prev = process.env.DSH_GROWTH_HOME
  process.env.DSH_GROWTH_HOME = home
  try { fn(home) }
  finally {
    if (prev == null) delete process.env.DSH_GROWTH_HOME
    else process.env.DSH_GROWTH_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// Load fresh each test since growthHome() reads env every call — but the
// module caches require. We invalidate the cache so DSH_GROWTH_HOME is
// re-evaluated by callers that hardcoded a path at require time.
function freshRequire() {
  delete require.cache[require.resolve('../src/main/growth-v2.js')]
  return require('../src/main/growth-v2.js')
}

test('readAll: returns the three-stage seed compactWindows unmodified', () => {
  withTmpHome(() => {
    const G = freshRequire()
    const payload = G.readAll()
    assert.equal(payload.compactWindows.length, 3)
    assert.equal(payload.compactWindows[2].eval.improvedTo, '94%')
    assert.equal(payload.userWrites.rubrics.hasOwnProperty('cw-2026-07-01'), false)
  })
})

test('addRubric: rejects blank assertion, no file created', () => {
  withTmpHome((home) => {
    const G = freshRequire()
    const r = G.addRubric('cw-2026-07-01', { assertion: '   ' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'assertion-required')
    assert.equal(fs.existsSync(path.join(home, 'rubrics')), false)
  })
})

test('addRubric: persists to ~/.dsh/growth/rubrics/<cwId>.json and surfaces via readAll', () => {
  withTmpHome((home) => {
    const G = freshRequire()
    const r = G.addRubric('cw-2026-07-05', {
      assertion: 'agent must run pnpm run test:coverage when user says 跑测试',
      expected: 'test:coverage',
      tag: 'gate-order',
    })
    assert.equal(r.ok, true)
    assert.ok(fs.existsSync(path.join(home, 'rubrics', 'cw-2026-07-05.json')))
    const p2 = G.readAll()
    assert.equal(p2.userWrites.rubrics['cw-2026-07-05'].length, 1)
    assert.equal(p2.userWrites.rubrics['cw-2026-07-05'][0].expected, 'test:coverage')
  })
})

test('addError: rejects blank text, persists otherwise', () => {
  withTmpHome((home) => {
    const G = freshRequire()
    assert.equal(G.addError('cw-2026-07-15', { text: '' }).ok, false)
    const r = G.addError('cw-2026-07-15', {
      text: 'agent skipped doc-sync gate',
      cause: 'gate not marked required',
      todo: 'add required=true to doc-sync line',
    })
    assert.equal(r.ok, true)
    assert.ok(fs.existsSync(path.join(home, 'errors', 'cw-2026-07-15.json')))
    const p2 = G.readAll()
    assert.equal(p2.userWrites.errors['cw-2026-07-15'][0].cause, 'gate not marked required')
  })
})

test('sanitizeId: path traversal in cwId is neutralized on the disk path', () => {
  withTmpHome((home) => {
    const G = freshRequire()
    const r = G.addRubric('../../evil', { assertion: 'x' })
    assert.equal(r.ok, true)
    // The rubric MUST land under our home; no `evil` file appears at parent.
    const rubricsDir = path.join(home, 'rubrics')
    const files = fs.readdirSync(rubricsDir)
    assert.equal(files.length, 1)
    assert.ok(!files[0].includes('/'))
    // Sanitizer collapses `../../evil` to a single dotted slug — the point
    // is that traversal chars are stripped, not that `.` never appears.
    assert.match(files[0], /^[A-Za-z0-9._-]+\.json$/)
  })
})

test('addRubric: append semantics — two calls yield two entries in file', () => {
  withTmpHome(() => {
    const G = freshRequire()
    G.addRubric('cw-x', { assertion: 'first' })
    G.addRubric('cw-x', { assertion: 'second' })
    const raw = fs.readFileSync(G.rubricsPath('cw-x'), 'utf8')
    const arr = JSON.parse(raw)
    assert.equal(arr.length, 2)
    assert.equal(arr[0].assertion, 'first')
    assert.equal(arr[1].assertion, 'second')
  })
})
