// Test locks for the fix/usability-p0-batch cycle. Each locks one of the
// P0 findings from review-usability: fixture id/catalog match, fusion
// loadFixture idempotency, rubric-cell-jump listener presence, artifact
// blob banner on missing-blob chains, artifact seed API surface.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RENDERER = path.resolve(__dirname, '..', 'src', 'renderer')

// -- P0-3 fusion loadFixture is idempotent ---------------------------------
test('rubric-fusion loadFixture is idempotent by fixture identity', () => {
  const fusion = require(path.join(RENDERER, 'rubric-fusion-model.js'))
  const store = fusion.create()
  const fixture = {
    rubrics: [{ id: 'r1', name: 'R1', dims: [{ id: 'd1', label: 'D1', type: 'continuous', min: 0, max: 1 }] }],
    events: [{ ts: 1, rubricId: 'r1', dimId: 'd1', sessionId: 's', turnId: 't', score: 0.5 }],
  }
  const first = store.loadFixture(fixture)
  const second = store.loadFixture(fixture)
  const third = store.loadFixture(fixture)
  assert.strictEqual(first.events, 1, 'first load registers events')
  assert.strictEqual(second.events, 0, 'second load is a no-op')
  assert.ok(second.deduped, 'second load reports deduped flag')
  assert.strictEqual(third.events, 0, 'third load is a no-op')
  assert.strictEqual(store.listEvents({}).length, 1, 'event count stays at 1 after 3 loads')
})

// -- P0-1 fixture rubric ids match catalog ids -----------------------------
test('rubric-fusion fixture covers every catalog rubric id', () => {
  const seedSrc = fs.readFileSync(path.join(RENDERER, 'rubrics-seed.js'), 'utf8')
  // Parse rubric names out of the inlined SKILL.md blobs.
  const catalogIds = []
  for (const m of seedSrc.matchAll(/---\\nname: ([\w-]+)/g)) catalogIds.push(m[1])
  assert.ok(catalogIds.length >= 4, 'catalog seed has at least 4 rubrics')
  const fixtureJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'rubric-fusion-fixture.json'), 'utf8'))
  const fixtureIds = new Set((fixtureJson.rubrics || []).map(r => r.id))
  const missing = catalogIds.filter(id => !fixtureIds.has(id))
  assert.deepStrictEqual(missing, [],
    'every catalog rubric id has a matching fixture rubric def: missing=' + missing.join(','))
})

// -- P0-2 tracing-page registers rubric-cell-jump listener -----------------
test('tracing-page wires dsh:rubric-cell-jump → openDrill', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'tracing-page.js'), 'utf8')
  assert.match(src, /addEventListener\(['"]dsh:rubric-cell-jump['"]/,
    'tracing-page must register dsh:rubric-cell-jump listener')
  assert.match(src, /openDrill\(detail\.sessionId\)/,
    'listener must call openDrill(detail.sessionId) so the jump lands')
})

// -- P0-5 artifact-evolution shows blob-missing banner ---------------------
// Static source-string lock (matches artifact-evolution-board.test.js
// style for the artifacts.js IIFE — the module lives inside a closure
// and we already prove the runtime path there. Here we just prove the
// blob-missing banner path exists and gates on the right predicate).
test('renderEvolution emits blob-missing banner when any hop lacks blob', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'artifacts-board.js'), 'utf8')
  assert.match(src, /artifact-evolution-banner/, 'source must reference the banner class')
  assert.match(src, /missingBlobs\s*=\s*chain\.some/,
    'banner must gate on chain.some(missing-blob)')
  const css = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8')
  assert.match(css, /\.artifact-evolution-banner\s*\{/,
    'style.css must style the new .artifact-evolution-banner selector')
})

// -- P0-4 artifact seed fixture is inline-reachable ------------------------
test('artifact-board-seed.js inlines fixture on window.__dshArtifactBoardSeed', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'artifact-board-seed.js'), 'utf8')
  assert.match(src, /window\.__dshArtifactBoardSeed\s*=/, 'seed must attach to window')
  // Sanity — has multiple kinds and multiple versions.
  assert.match(src, /"kind":\s*"svg"/, 'seed must include an svg artifact')
  assert.match(src, /"kind":\s*"html"/, 'seed must include an html artifact')
  assert.match(src, /"version":\s*3/, 'seed must include multi-version chain (v3+)')
  // Wired into index.html so the browser actually loads it.
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8')
  assert.match(html, /artifact-board-seed\.js/, 'index.html must include artifact-board-seed.js')
})

// -- P1 Lane A: graph binds click on fork nodes + user nodes ---------------
test('chat-session-graph binds click on actionable non-turn nodes', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'chat-session-graph.js'), 'utf8')
  assert.match(src, /kind === ['"]fork['"] && node\.childSessionId/,
    'graph must bind click on fork nodes when childSessionId is present')
  assert.match(src, /kind === ['"]user['"] && node\.seq/,
    'graph must bind click on user nodes when seq is present')
})

// -- P1 Lane A: renderer stores chatSelectedTurnId + wires user rows -------
test('renderer propagates chatSelectedTurnId and wires user rows', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'renderer.js'), 'utf8')
  assert.match(src, /state\.chatSelectedTurnId/, 'renderer must store chatSelectedTurnId in state')
  assert.match(src, /row\.kind === ['"]user['"] && row\.seq/,
    'renderer drawer onSelect must handle user rows (kind==="user" && seq)')
})
