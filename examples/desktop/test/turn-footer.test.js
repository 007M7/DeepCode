// Unit tests for turn-footer — per-turn terminator row for #162 rec 23.
// Covers formatter edge cases and the DOM builder.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  formatFooterFields, buildTurnFooter, specHasAnySignal,
  fmtTokens, fmtCost, fmtDurationMs, fmtTtft, fmtStopReason, fmtProviderModel,
  ABSENT,
} = require('../src/renderer/turn-footer.js')

// -- formatters ---------------------------------------------------------

test('fmtTokens: absent for non-number → em-dash', () => {
  assert.equal(fmtTokens(null), ABSENT)
  assert.equal(fmtTokens(undefined), ABSENT)
  assert.equal(fmtTokens('42'), ABSENT)
})

test('fmtTokens: sub-1000 rendered as integer', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(42), '42')
  assert.equal(fmtTokens(999), '999')
})

test('fmtTokens: >=1000 rendered with k suffix, 1 decimal, trim .0', () => {
  assert.equal(fmtTokens(1000), '1k')
  assert.equal(fmtTokens(1250), '1.3k')
  assert.equal(fmtTokens(12345), '12.3k')
})

test('fmtCost: non-number → $?', () => {
  assert.equal(fmtCost(null), '$?')
  assert.equal(fmtCost(undefined), '$?')
})

test('fmtCost: pi-style — always 4 decimals for column alignment', () => {
  assert.equal(fmtCost(0), '$0.0000')
  assert.equal(fmtCost(0.0043), '$0.0043')
  assert.equal(fmtCost(0.15), '$0.1500')
  assert.equal(fmtCost(1.234), '$1.2340')
})

test('fmtDurationMs: absent for zero/negative/non-number', () => {
  assert.equal(fmtDurationMs(0), ABSENT)
  assert.equal(fmtDurationMs(-1), ABSENT)
  assert.equal(fmtDurationMs(null), ABSENT)
})

test('fmtDurationMs: <1s → ms integer, >=1s → seconds with 1 decimal', () => {
  assert.equal(fmtDurationMs(500), '500ms')
  assert.equal(fmtDurationMs(1000), '1.0s')
  assert.equal(fmtDurationMs(2450), '2.5s')
})

test('fmtTtft: absent for zero/negative/non-number, rounded ms otherwise', () => {
  assert.equal(fmtTtft(0), ABSENT)
  assert.equal(fmtTtft(null), ABSENT)
  assert.equal(fmtTtft(345), '345ms')
  assert.equal(fmtTtft(345.7), '346ms')
})

test('fmtStopReason: string, object with .kind, or absent', () => {
  assert.equal(fmtStopReason('stop'), 'stop')
  assert.equal(fmtStopReason({ kind: 'error' }), 'error')
  assert.equal(fmtStopReason(null), ABSENT)
  assert.equal(fmtStopReason({}), ABSENT)
})

test('fmtProviderModel: provider · model, or one, or em-dash', () => {
  assert.equal(fmtProviderModel('deepseek', 'chat'), 'deepseek · chat')
  assert.equal(fmtProviderModel(null, 'chat'), 'chat')
  assert.equal(fmtProviderModel('deepseek', null), 'deepseek')
  assert.equal(fmtProviderModel(null, null), ABSENT)
})

// -- formatFooterFields --------------------------------------------------

test('formatFooterFields: full spec produces 4 labeled fields in order (usage fuses tokens+cost)', () => {
  const fields = formatFooterFields({
    model: 'deepseek-chat',
    provider: 'deepseek',
    usage: { inputTokens: 1200, outputTokens: 186, cacheReadTokens: 900 },
    cost: { total: 0.0143 },
    ttftMs: 345,
    durationMs: 12400,
    stopReason: 'stop',
  })
  // §9 correction (reference tracing UI root row `55 / <$0.0001`): tokens+cost merge
  // into a single `usage` pill, not two separate chips.
  assert.deepEqual(fields.map(f => f.label), ['model', 'usage', 'time', 'stop'])
  assert.equal(fields[0].value, 'deepseek · deepseek-chat')
  assert.equal(fields[1].value, '↑1.2k (900 cached) ↓186 / $0.0143')
  assert.equal(fields[2].value, '345ms / 12.4s')
  assert.equal(fields[3].value, 'stop')
})

test('formatFooterFields: missing usage but cost present → `— / $cost` pill (cost alone still legible)', () => {
  const fields = formatFooterFields({ model: 'deepseek-chat', cost: { total: 0.001 } })
  const usage = fields.find(f => f.label === 'usage')
  assert.equal(usage.value, '— / $0.0010')
})

test('formatFooterFields: cache-read absent → dropped from token bits', () => {
  const fields = formatFooterFields({
    usage: { inputTokens: 1200, outputTokens: 186 },
    cost: { total: 0.001 },
  })
  const usage = fields.find(f => f.label === 'usage')
  assert.equal(usage.value, '↑1.2k ↓186 / $0.0010')
})

test('formatFooterFields: TTFT missing but duration present → duration only', () => {
  const fields = formatFooterFields({ durationMs: 2450 })
  const time = fields.find(f => f.label === 'time')
  assert.equal(time.value, '2.5s')
})

test('formatFooterFields: tokens present + cost absent → clean `↑… ↓…` (no `$?` tail in footer)', () => {
  // 2026-07-18 echo-profile fix: `$?` is L1-detail-pane vocabulary; on the
  // L0 footer row it's just noise (user 2026-07-18 実機 screenshot showed
  // `↑20 ↓58 / $?` next to `— · ` from other missing fields — the whole
  // row read as junk). Drop the cost segment entirely when unknown.
  const fields = formatFooterFields({ model: 'x', usage: { inputTokens: 100, outputTokens: 20 } })
  const usage = fields.find(f => f.label === 'usage')
  assert.equal(usage.value, '↑100 ↓20')
})

test('formatFooterFields: object stopReason with .kind', () => {
  const fields = formatFooterFields({ stopReason: { kind: 'error' } })
  assert.equal(fields.find(f => f.label === 'stop').value, 'error')
})

test('formatFooterFields: empty spec → 0 fields (no `— · ` placeholder row)', () => {
  // 2026-07-18 echo-profile fix: an all-absent spec used to render four
  // em-dash chips + three separators (`— · — / $? · — · —`). We now emit
  // nothing so the caller can suppress the row entirely; zero-drop still
  // holds via L1/L2.
  const fields = formatFooterFields()
  assert.equal(fields.length, 0)
})

test('formatFooterFields: echo-profile shape (only tokens, no model/cost/time/stop) → single usage chip, no junk placeholders', () => {
  // Real trigger — user echo-profile实机 screenshot 2026-07-18. Wire
  // supplies usage but no model / cost / duration / stopReason.
  const fields = formatFooterFields({
    usage: { inputTokens: 20, outputTokens: 58 },
  })
  assert.deepEqual(fields.map(f => f.label), ['usage'])
  assert.equal(fields[0].value, '↑20 ↓58')
})

test('formatFooterFields: partial-signal shape drops absent chips + their separators (no `— · ` fragments)', () => {
  // Model+usage+stop present, cost/time absent: three chips, two seps
  // (buildTurnFooter interleaves seps between chips of the emitted array).
  const fields = formatFooterFields({
    model: 'deepseek-chat',
    usage: { inputTokens: 20, outputTokens: 58 },
    stopReason: 'completed',
  })
  assert.deepEqual(fields.map(f => f.label), ['model', 'usage', 'stop'])
})

// -- DOM builder --------------------------------------------------------

function makeDoc() {
  function makeEl(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      _children: [],
      appendChild(c) { this._children.push(c); return c },
      append(...kids) { for (const k of kids) this._children.push(k); return this },
    }
  }
  return { createElement: makeEl }
}

test('buildTurnFooter: renders 4 field chips interleaved with separators', () => {
  const doc = makeDoc()
  const el = buildTurnFooter(doc, {
    model: 'deepseek-chat',
    usage: { inputTokens: 100, outputTokens: 20 },
    cost: { total: 0.001 },
    durationMs: 500,
    stopReason: 'stop',
  })
  assert.equal(el.className, 'turn-footer')
  // 4 field chips + 3 separators = 7 children
  assert.equal(el._children.length, 7)
  const chips = el._children.filter(c => c.className.startsWith('turn-footer-field'))
  const seps  = el._children.filter(c => c.className === 'turn-footer-sep')
  assert.equal(chips.length, 4)
  assert.equal(seps.length, 3)
  assert.equal(chips[0].className, 'turn-footer-field field-model')
  assert.equal(chips[0].textContent, 'deepseek-chat')
  assert.equal(chips[1].className, 'turn-footer-field field-usage')
  assert.equal(chips[1].textContent, '↑100 ↓20 / $0.0010')
})

test('buildTurnFooter: emoji-free (density-spec §2 rule)', () => {
  const doc = makeDoc()
  const el = buildTurnFooter(doc, {
    model: 'deepseek-chat',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
    cost: { total: 0.0001 },
  })
  const collected = []
  function walk(node) {
    if (node.textContent && (!node._children || !node._children.length)) collected.push(node.textContent)
    for (const c of node._children || []) walk(c)
  }
  walk(el)
  const joined = collected.join(' ')
  const emoji = joined.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)
  assert.equal(emoji, null, `unexpected emoji: ${JSON.stringify(emoji)}`)
})

// -- specHasAnySignal (zero-data footer suppression) ---------------------

test('specHasAnySignal: false for null / empty / no-signal specs', () => {
  assert.equal(specHasAnySignal(null), false)
  assert.equal(specHasAnySignal(undefined), false)
  assert.equal(specHasAnySignal({}), false)
  // The screenshotted bug shape: an empty usage bag, absent cost, zero
  // duration, no stop reason — nothing worth painting as a metric row.
  assert.equal(specHasAnySignal({
    model: '', provider: null,
    usage: {}, cost: {},
    ttftMs: 0, durationMs: 0,
    stopReason: null,
  }), false)
})

test('specHasAnySignal: true when any single field carries information', () => {
  assert.equal(specHasAnySignal({ model: 'deepseek-chat' }), true)
  assert.equal(specHasAnySignal({ usage: { inputTokens: 12 } }), true)
  assert.equal(specHasAnySignal({ cost: { total: 0 } }), true)  // 0 is real
  assert.equal(specHasAnySignal({ durationMs: 250 }), true)
  assert.equal(specHasAnySignal({ ttftMs: 100 }), true)
  assert.equal(specHasAnySignal({ stopReason: 'stop' }), true)
  assert.equal(specHasAnySignal({ stopReason: { kind: 'error' } }), true)
})

test('specHasAnySignal: formatted-shape false when every field is an ABSENT sentinel', () => {
  // The renderer hands finishTurnContainer a formatted map, not the raw
  // shape.  If every field is `—` (or the `— / $?` compound), the footer
  // still has no signal.  Regression fence: the pre-existing formatted
  // path used to return `true` because `model === '—'` is a non-empty
  // string; specHasAnySignal must recognize the sentinels.
  const formatted = { model: ABSENT, usage: `${ABSENT} / $?`, time: ABSENT, stop: ABSENT }
  assert.equal(specHasAnySignal(formatted), false)
})

test('specHasAnySignal: formatted-shape true when at least one field has data', () => {
  const formatted = { model: 'deepseek-chat', usage: `${ABSENT} / $?`, time: ABSENT, stop: ABSENT }
  assert.equal(specHasAnySignal(formatted), true)
  const withCost = { model: ABSENT, usage: `${ABSENT} / $0.0042`, time: ABSENT, stop: ABSENT }
  assert.equal(specHasAnySignal(withCost), true)
  const withTokens = { model: ABSENT, usage: `↑12 ↓4 / $?`, time: ABSENT, stop: ABSENT }
  assert.equal(specHasAnySignal(withTokens), true)
})
