// Rubric fusion — cross-view smoke tests.
//
// We can't run the actual DOM controllers under `node --test` (no jsdom),
// but we can:
//   1. Verify the fusion seed JSON parses and drives all three view APIs.
//   2. Verify each of the 3 view scripts loads cleanly with a minimal
//      document stub (catching syntax errors early).
//   3. Verify the fusion-model events → view derivations pipeline
//      returns the expected shape for each view.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

// Wire the rubrics-model global before anything requires fusion-model.
global.window = global.window || {}
global.window.__dshRubricsModel = require('../src/renderer/rubrics-model.js')

// Fresh singleton per test.
function freshFusion() {
  delete require.cache[require.resolve('../src/renderer/rubric-fusion-model.js')]
  const api = require('../src/renderer/rubric-fusion-model.js')
  return api.create()
}

const FIXTURE_PATH = path.join(__dirname, '..', 'docs', 'rubric-fusion-fixture.json')
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))

test('fixture loads with catalog-aligned rubrics and > 30 events', () => {
  const s = freshFusion()
  const res = s.loadFixture(FIXTURE)
  // Fixture now covers all 7 catalog rubrics (svg-generation, bug-fix,
  // multi-turn-feedback, code-review, correctness-score, intent-triage,
  // passes-bench) so every Rubrics tile has stats. Before the fix only
  // 3 rubrics were seeded and 4 tiles read as "No scores yet."
  assert.equal(res.rubrics, 7)
  assert.ok(res.events > 30, 'expected > 30 events, got ' + res.events)
})

test('Rubrics view: recentScoresFor returns per-dim breakdown for each rubric', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  for (const rubric of s.listRubrics()) {
    const stats = s.recentScoresFor(rubric.id)
    assert.ok(stats.total > 0, `${rubric.id}: expected events > 0`)
    assert.ok(stats.passRate >= 0 && stats.passRate <= 1, `${rubric.id}: passRate out of range`)
    for (const dim of rubric.dims) {
      const byDim = stats.byDim[dim.id]
      assert.ok(byDim, `${rubric.id}/${dim.id}: missing per-dim bucket`)
      assert.ok(byDim.n > 0, `${rubric.id}/${dim.id}: expected n > 0`)
    }
  }
})

test('Growth view: timeSeriesFor by=day produces sorted xAxis and per-dim series', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const ts = s.timeSeriesFor({ by: 'day', groupBy: 'dim' })
  assert.ok(ts.xAxis.length >= 3, 'expected >= 3 days')
  // sorted asc
  const sorted = ts.xAxis.slice().sort()
  assert.deepEqual(ts.xAxis, sorted)
  assert.ok(ts.series.length >= 3, 'expected >= 3 dim series')
  for (const s2 of ts.series) {
    assert.ok(s2.points.length >= 1, 'each series has points: ' + s2.label)
    for (const p of s2.points) {
      assert.ok(p.mean01 >= 0 && p.mean01 <= 1, 'mean01 in range for ' + s2.label)
      assert.ok(p.passRate >= 0 && p.passRate <= 1, 'passRate in range for ' + s2.label)
    }
  }
})

test('Growth view: timeSeriesFor by=version buckets by harness version', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const ts = s.timeSeriesFor({ by: 'version', groupBy: 'dim' })
  const versions = new Set(ts.xAxis)
  assert.ok(versions.has('v0.9'), 'v0.9 present')
  assert.ok(versions.has('v0.11'), 'v0.11 present')
})

test('Growth view: filter chip harnessVersion narrows the series', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const all = s.timeSeriesFor({ by: 'day', groupBy: 'dim' })
  const v11 = s.timeSeriesFor({ by: 'day', groupBy: 'dim', filter: { harnessVersion: 'v0.11' } })
  const totalAll = all.series.reduce((sum, sr) => sum + sr.points.reduce((a, p) => a + p.n, 0), 0)
  const totalV11 = v11.series.reduce((sum, sr) => sum + sr.points.reduce((a, p) => a + p.n, 0), 0)
  assert.ok(totalV11 < totalAll, 'filtered total should be strictly smaller')
  assert.ok(totalV11 > 0, 'v0.11 filtered total > 0')
})

test('Runtime view: rolloutGridFor produces a matrix with cell pass/fail', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const grid = s.rolloutGridFor('svg-generation', 's-svg-live')
  assert.equal(grid.rubric.id, 'svg-generation')
  assert.ok(grid.rollouts.length >= 3, 'expected >= 3 rollouts for the live session')
  assert.ok(grid.dims.length === 3, 'svg-gen has 3 dims')
  // Assert we have at least one pass AND at least one fail — the fixture
  // deliberately spans both.
  const passed = grid.cells.filter(c => c.passed === true).length
  const failed = grid.cells.filter(c => c.passed === false).length
  assert.ok(passed > 0, 'at least one pass cell')
  assert.ok(failed > 0, 'at least one fail cell')
})

test('Runtime view: rolloutGridFor sessionId=null aggregates all rollouts', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const grid = s.rolloutGridFor('svg-generation', null)
  // The fixture has rollouts 1..8 for svg-gen (5 seed sessions + 3 on
  // the live session).
  assert.deepEqual(grid.rollouts, [1, 2, 3, 4, 5, 6, 7, 8])
})

test('Rubrics view: similar-sessions hint fires with count >= 3', () => {
  const s = freshFusion()
  s.loadFixture(FIXTURE)
  const classes = s.detectSimilarSessions()
  assert.equal(classes.length, 1)
  assert.equal(classes[0].id, 'similar-svg-gen')
  assert.ok(classes[0].count >= 3)
})

// --- Script-load smoke tests: the 3 view scripts must load without
// throwing under a minimal document stub. Catches syntax errors before
// they hit the browser. ---

function stubDocument() {
  return {
    addEventListener() {},
    readyState: 'complete',
    querySelector() { return null },
    querySelectorAll() { return [] },
    createElement() {
      const node = {
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
        dataset: {},
        setAttribute() {},
        getAttribute() { return null },
        appendChild(c) { return c },
        replaceChildren() {},
        removeChild() {},
        addEventListener() {},
        set textContent(v) {},
        set innerHTML(v) {},
        set hidden(v) {},
      }
      return node
    },
    createElementNS() { return this.createElement() },
    getElementById() { return null },
  }
}

test('rubrics-page.js loads under minimal document stub', () => {
  global.window = { __dshRubricsModel: require('../src/renderer/rubrics-model.js') }
  global.document = stubDocument()
  global.requestAnimationFrame = () => {}
  delete require.cache[require.resolve('../src/renderer/rubrics-page.js')]
  const page = require('../src/renderer/rubrics-page.js')
  assert.ok(page._internal, 'exposes _internal')
})

test('growth-v2.js loads under minimal document stub', () => {
  global.window = {
    __dshRubricsModel: require('../src/renderer/rubrics-model.js'),
    __dshRubricFusion: require('../src/renderer/rubric-fusion-model.js'),
  }
  global.document = stubDocument()
  delete require.cache[require.resolve('../src/renderer/growth-v2.js')]
  require('../src/renderer/growth-v2.js')
  assert.ok(global.window.__dshGrowthV2, 'exposes __dshGrowthV2')
  assert.equal(typeof global.window.__dshGrowthV2.show, 'function')
  assert.equal(typeof global.window.__dshGrowthV2.render, 'function')
})

test('runtimes-page.js loads under minimal document stub', () => {
  global.window = {
    __dshRubricsModel: require('../src/renderer/rubrics-model.js'),
    __dshRubricFusion: require('../src/renderer/rubric-fusion-model.js'),
  }
  global.document = stubDocument()
  delete require.cache[require.resolve('../src/renderer/runtimes-page.js')]
  require('../src/renderer/runtimes-page.js')
  assert.ok(global.window.__dshRuntimes, 'exposes __dshRuntimes')
  assert.equal(typeof global.window.__dshRuntimes.show, 'function')
})
