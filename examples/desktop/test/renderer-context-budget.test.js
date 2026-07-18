// P0-2 pure-fn tests for the meter label formatter. The renderer's
// updateContextMeter delegates all label + title formatting to
// context-meter.js's `meterLabelFor(snap)` so the P0-2 red-line — never
// present an assumed 128k as authoritative — is unit-testable without
// booting the renderer harness.
//
// Intent doc §2.7 + team-lead red-line, verbatim:
//   "budget 拿不到时显式标 'unknown budget / ~128k (assumed)'，禁止静默
//    fallback 128000 常量装精确；wire 侧字段是新增元信息，不许从模型名反查。"
//
// Also exercises the shell wiring at a high level via the renderer
// harness: refreshSessionList → contextWindowFromEntry → setBudget →
// snapshot.budgetSource stays honest.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadRenderer } = require('./renderer-harness.js')

function load() {
  const p = require.resolve(path.resolve(__dirname, '..', 'src', 'renderer', 'context-meter.js'))
  delete require.cache[p]
  return require(p)
}

test('meterLabelFor: assumed budget carries the "(assumed)" suffix on the budget side', () => {
  const { meterLabelFor } = load()
  const view = meterLabelFor({
    tokens: 5200, budget: 128000, mode: 'precise', budgetSource: 'assumed',
  })
  assert.match(view.label, /assumed/i,
    `label must call out "assumed" when we're guessing; got: ${view.label}`)
  assert.match(view.label, /~128k/,
    'assumed budget renders with the ~ prefix on the budget number too')
  assert.equal(view.budgetClass, 'assumed')
})

test('meterLabelFor: server budget drops the "(assumed)" suffix', () => {
  const { meterLabelFor } = load()
  const view = meterLabelFor({
    tokens: 5200, budget: 32000, mode: 'precise', budgetSource: 'server',
  })
  assert.doesNotMatch(view.label, /assumed/i)
  assert.match(view.label, /\/ 32k$/,
    'server budget ends in the plain number, no ~ or (assumed)')
  assert.equal(view.budgetClass, 'server')
})

test('meterLabelFor: approx mode still prefixes tokens with ~ regardless of budget source', () => {
  const { meterLabelFor } = load()
  const server = meterLabelFor({ tokens: 5200, budget: 32000, mode: 'approx', budgetSource: 'server' })
  assert.match(server.label, /^~/, 'approx mode → tokens carry ~')
  assert.match(server.label, /\/ 32k$/)
  const assumed = meterLabelFor({ tokens: 5200, budget: 128000, mode: 'approx', budgetSource: 'assumed' })
  assert.match(assumed.label, /^~/)
  assert.match(assumed.label, /~128k \(assumed\)/)
})

test('meterLabelFor: title distinguishes the two sources in prose', () => {
  const { meterLabelFor } = load()
  const server = meterLabelFor({ tokens: 100, budget: 32000, mode: 'precise', budgetSource: 'server' })
  assert.match(server.title, /from the runtime/i)
  assert.doesNotMatch(server.title, /assumed/i)
  const assumed = meterLabelFor({ tokens: 100, budget: 128000, mode: 'precise', budgetSource: 'assumed' })
  assert.match(assumed.title, /assumed|default fallback|hasn't reported/i)
})

test('meterLabelFor: null / undefined snap returns the em-dash placeholder', () => {
  const { meterLabelFor } = load()
  assert.equal(meterLabelFor(null).label, '—')
  assert.equal(meterLabelFor(undefined).label, '—')
})

test('formatTokensCompact: three-tier compact scale', () => {
  const { formatTokensCompact } = load()
  assert.equal(formatTokensCompact(0), '0')
  assert.equal(formatTokensCompact(999), '999')
  assert.equal(formatTokensCompact(5200), '5.2k')
  assert.equal(formatTokensCompact(9999), '10.0k')
  assert.equal(formatTokensCompact(32000), '32k')
  assert.equal(formatTokensCompact(128000), '128k')
  assert.equal(formatTokensCompact(NaN), '—')
})

// -- End-to-end (renderer harness) ----------------------------------------
// The harness's on-demand DOM stub doesn't populate the meter's fill child,
// so we can't assert on the DOM label from here — the shell path is tested
// by the pure meterLabelFor above. Instead we verify that the tracker
// picks up the wire's contextWindow through the whole
// refreshSessionList → contextWindowFromEntry → setBudget pipeline, since
// that's the piece that lives in renderer.js.

test('shell wiring: refreshSessionList promotes budgetSource to server when wire ships contextWindow', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-server',
        header: { model: { contextWindow: 32000 } },
        live: true, lastEventTime: Date.now(),
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-server')
  assert.ok(meta && meta.contextTracker, 'tracker exists')
  const snap = meta.contextTracker.snapshot()
  assert.equal(snap.budget, 32000, 'budget bound from entry.header.model.contextWindow')
  assert.equal(snap.budgetSource, 'server', 'promoted to server-source')
})

test('shell wiring: entry with just model.name stays assumed (P0-2 red-line)', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      // Name that a naive shell might reverse-map to 32k. The shell must
      // not: only an explicit `contextWindow` number promotes.
      return [{
        sessionId: 's-nameonly',
        header: { model: { name: 'deepseek-v4-32k' } },
        live: true, lastEventTime: Date.now(),
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-nameonly')
  const snap = meta.contextTracker.snapshot()
  assert.equal(snap.budget, 128000, 'still on the assumed default')
  assert.equal(snap.budgetSource, 'assumed',
    'model.name is not enough — only wire-side contextWindow promotes')
})

test('shell wiring: flat entry.contextWindow (alt wire shape) also promotes', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-flat', header: {}, contextWindow: 65536,
        live: true, lastEventTime: Date.now(),
      }]
    },
  })
  await renderer.refreshSessionList()
  const snap = renderer.getSessionMeta('s-flat').contextTracker.snapshot()
  assert.equal(snap.budget, 65536)
  assert.equal(snap.budgetSource, 'server')
})
