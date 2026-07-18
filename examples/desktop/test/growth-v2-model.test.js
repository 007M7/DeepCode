// Pure-model tests for growth-v2. Everything here works on the same
// fixture shape the IPC returns, so a regression in either the fixture or
// the projector shows up here first (multi-agent shared-repo rule #4).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const M = require('../src/renderer/growth-v2-model.js')

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'trace-samples', 'growth-three-stage.json')
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))

function fx() {
  // Fresh deep copy per test so mergeAll's user-writes don't leak across cases.
  return JSON.parse(JSON.stringify(FIXTURE))
}

test('mergeAll: bare payload → three compact windows in fixture order', () => {
  const out = M.mergeAll(fx(), {})
  assert.equal(out.compactWindows.length, 3)
  assert.equal(out.compactWindows[0].id, 'cw-2026-07-01')
  assert.equal(out.compactWindows[2].id, 'cw-2026-07-15')
})

test('mergeAll: user-written rubrics/errors append (fixture entries stay first)', () => {
  const uw = {
    rubrics: {
      'cw-2026-07-01': [
        { id: 'user1', assertion: 'test user rubric', createdAt: 1719900000000 },
      ],
    },
    errors: {
      'cw-2026-07-05': [
        { id: 'ue1', text: 'user-flagged error', createdAt: 1720200000000 },
      ],
    },
  }
  const out = M.mergeAll(fx(), uw)
  const w1 = out.compactWindows[0]
  assert.equal(w1.rubrics.length, 1)
  assert.equal(w1.rubrics[0].id, 'user1')
  const w2 = out.compactWindows[1]
  // Fixture had 1 error already; user-written appends → 2.
  assert.equal(w2.errors.length, 2)
  assert.equal(w2.errors[1].id, 'ue1')
})

test('mergeAll: garbage input yields an empty-but-valid payload', () => {
  const out = M.mergeAll(null, null)
  assert.deepEqual(out.compactWindows, [])
  assert.equal(out.installedAt, null)
  assert.equal(out.logPath, null)
})

test('compressionRatio: honest ratio from shadowedTokenCount + summary chars', () => {
  const cw = fx().compactWindows[0]
  const r = M.compressionRatio(cw)
  assert.ok(r.summaryTokens > 0)
  assert.ok(r.ratio > 0 && r.ratio < 1, `ratio in (0,1), got ${r.ratio}`)
})

test('compressionRatio: no shadowedTokenCount → null (never fabricate)', () => {
  assert.equal(M.compressionRatio({ id: 'x' }), null)
  assert.equal(M.compressionRatio(null), null)
})

test('formatCompression: renders "28.5k → …" style string', () => {
  const s = M.formatCompression(fx().compactWindows[0])
  assert.match(s, /28\.5k\s+→/)
  assert.match(s, /% survived/)
})

test('formatShadowedRange: "seq A–B · N events"', () => {
  const s = M.formatShadowedRange(fx().compactWindows[0])
  assert.equal(s, 'seq 1–240 · 240 events')
})

test('formatShadowedRange: missing range → empty (never "seq undefined")', () => {
  assert.equal(M.formatShadowedRange({ id: 'x' }), '')
  assert.equal(M.formatShadowedRange({ id: 'y', shadowedRange: {} }), '')
})

test('badgeCounts: R × N / E × M reflects merged arrays', () => {
  const out = M.mergeAll(fx(), {
    rubrics: { 'cw-2026-07-15': [{ id: 'u1' }, { id: 'u2' }] },
    errors: {},
  })
  const w3 = out.compactWindows[2]
  // Fixture had 2 rubrics on cw-2026-07-15; +2 user rubrics → 4.
  assert.equal(M.badgeCounts(w3).rubrics, 4)
  assert.equal(M.badgeCounts(w3).errors, 0)
})

test('evalStrip: surfaces fixture 42% → 94% arc verbatim', () => {
  const strip = M.evalStrip(fx().compactWindows[2])
  assert.equal(strip.improvedFrom, '42%')
  assert.equal(strip.improvedTo, '94%')
  assert.equal(strip.pass, 17)
  assert.equal(strip.total, 18)
})

test('evalStrip: no eval → null so DOM drops the row', () => {
  // Synthetic window with no `eval` block — decoupled from fixture shape so
  // fixture changes don't ripple into model unit tests.
  assert.equal(M.evalStrip({ id: 'cw-x', shadowedTokenCount: 100, summary: 's' }), null)
  assert.equal(M.evalStrip({ id: 'cw-y', eval: { name: 'x', pass: 'nope', total: 'nope' } }), null)
  assert.equal(M.evalStrip(null), null)
})

test('fmtTime: renders a stable "YYYY-MM-DD HH:MM" for a known epoch', () => {
  // 1719811200000 = 2024-07-01 08:00 UTC. We don't pin the tz — just check
  // the shape so the test doesn't break on non-UTC CI machines.
  const s = M.fmtTime(1719811200000)
  assert.match(s, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(M.fmtTime(NaN), '')
})

test('shortTokens: 1k+ compresses, sub-1k passes through', () => {
  assert.equal(M.shortTokens(28500), '28.5k')
  assert.equal(M.shortTokens(499), '499')
  assert.equal(M.shortTokens(NaN), '?')
})

test('triggerLabel: accepts obj or string, falls back to raw string', () => {
  assert.equal(M.triggerLabel({ kind: 'auto' }), 'auto compact')
  assert.equal(M.triggerLabel('manual'), 'user requested')
  assert.equal(M.triggerLabel('mystery-kind'), 'mystery-kind')
  assert.equal(M.triggerLabel(null), 'compact')
})
