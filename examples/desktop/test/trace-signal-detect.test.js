// trace-signal-detect.test.js — heuristic detector unit tests.
//
// Detector is pure and used by both the tri-view SVG overlays and the main
// flow marker chips (see renderer.js `applyTurnSignalChips`). Every branch
// has a fixture-driven assertion so a future refactor breaks visibly.

'use strict'

const test = require('node:test')
const assert = require('node:assert')

const SD = require('../src/renderer/trace-signal-detect.js')

test('loop-detected fires after N consecutive same-tool same-args calls', () => {
  const events = []
  for (let i = 0; i < 3; i++) {
    events.push({
      type: 'tool/call', seq: 10 + i,
      data: { name: 'fs.read', arguments: '{"path":"a.ts"}', callId: `c${i}` },
    })
  }
  const { bySeq, all } = SD.detectSignals(events, { loopN: 3 })
  const loops = all.filter(s => s.signal === 'loop-detected')
  assert.strictEqual(loops.length, 1, 'exactly one loop-detected on the 3rd call')
  assert.strictEqual(loops[0].seq, 12)
  assert.strictEqual(loops[0].meta.run, 3)
  assert.strictEqual(loops[0].meta.name, 'fs.read')
  assert.ok(bySeq.get(12).find(s => s.signal === 'loop-detected'))
})

test('loop-detected does not fire when args differ', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'fs.read', arguments: '{"path":"a"}', callId: '1' } },
    { type: 'tool/call', seq: 2, data: { name: 'fs.read', arguments: '{"path":"b"}', callId: '2' } },
    { type: 'tool/call', seq: 3, data: { name: 'fs.read', arguments: '{"path":"c"}', callId: '3' } },
  ]
  const { all } = SD.detectSignals(events, { loopN: 3 })
  const loops = all.filter(s => s.signal === 'loop-detected')
  assert.strictEqual(loops.length, 0, 'name matches but args differ — not a loop')
})

test('redundant-call fires when a call repeats with an interleaved other call between', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'fs.read', arguments: '{"path":"a"}', callId: '1' } },
    { type: 'tool/call', seq: 2, data: { name: 'bash', arguments: '{"cmd":"ls"}', callId: '2' } },
    { type: 'tool/call', seq: 3, data: { name: 'fs.read', arguments: '{"path":"a"}', callId: '3' } },
  ]
  const { all } = SD.detectSignals(events)
  const red = all.filter(s => s.signal === 'redundant-call')
  assert.strictEqual(red.length, 1)
  assert.strictEqual(red[0].seq, 3)
  assert.strictEqual(red[0].meta.priorSeq, 1)
})

test('redundant-call does NOT fire when the repeat is consecutive (that\'s a loop, not redundancy)', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: '1' } },
    { type: 'tool/call', seq: 2, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: '2' } },
  ]
  const { all } = SD.detectSignals(events, { loopN: 3 })
  const red = all.filter(s => s.signal === 'redundant-call')
  assert.strictEqual(red.length, 0, '2 same-in-a-row is not yet a loop and not yet redundant')
})

test('plan-update fires on assistant text with "new plan" keyword', () => {
  const events = [
    {
      type: 'assistant/message', seq: 20,
      data: { content: [{ type: 'text', text: 'Okay, here is the new plan: first read the file, then edit it.' }] },
    },
  ]
  const { all } = SD.detectSignals(events)
  const plan = all.filter(s => s.signal === 'plan-update')
  assert.strictEqual(plan.length, 1)
  assert.strictEqual(plan[0].seq, 20)
  assert.match(plan[0].meta.snippet, /new plan/i)
  assert.strictEqual(plan[0].meta.source, 'heuristic')
})

test('plan-update fires on a numbered-plan intro (two adjacent numbered lines)', () => {
  const events = [
    {
      type: 'assistant/message', seq: 30,
      data: { content: [{ type: 'text', text: '1. Read main.ts\n2. Edit imports\n3. Verify.' }] },
    },
  ]
  const { all } = SD.detectSignals(events)
  const plan = all.filter(s => s.signal === 'plan-update')
  assert.strictEqual(plan.length, 1)
  assert.strictEqual(plan[0].seq, 30)
})

test('plan-update does NOT fire on plain prose without plan keywords', () => {
  const events = [
    {
      type: 'assistant/message', seq: 40,
      data: { content: [{ type: 'text', text: 'The file looks fine. No changes needed.' }] },
    },
  ]
  const { all } = SD.detectSignals(events)
  assert.strictEqual(all.filter(s => s.signal === 'plan-update').length, 0)
})

test('tool-error signal fires on tool/result with ok:false — on BOTH the result seq and the matching call seq', () => {
  const events = [
    { type: 'tool/call', seq: 5, data: { name: 'bash', arguments: 'ls /nope', callId: 'c1' } },
    { type: 'tool/result', seq: 6, data: { callId: 'c1', ok: false, error: 'ENOENT: /nope' } },
  ]
  const { all, bySeq } = SD.detectSignals(events)
  const err = all.filter(s => s.signal === 'tool-error')
  assert.strictEqual(err.length, 2, 'one badge on the call seq, one on the result seq')
  const seqs = err.map(e => e.seq).sort()
  assert.deepStrictEqual(seqs, [5, 6])
  assert.ok(bySeq.get(5).find(s => s.signal === 'tool-error'), 'call seq carries the tool-error signal')
  assert.ok(bySeq.get(6).find(s => s.signal === 'tool-error'), 'result seq carries the tool-error signal')
  for (const e of err) assert.strictEqual(e.meta.name, 'bash')
})

test('plan-restart fires when the same tool is re-invoked after an error', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'bash', arguments: 'ls /nope', callId: 'c1' } },
    { type: 'tool/result', seq: 2, data: { callId: 'c1', ok: false, error: 'ENOENT' } },
    { type: 'tool/call', seq: 3, data: { name: 'bash', arguments: 'ls /tmp', callId: 'c2' } },
  ]
  const { all } = SD.detectSignals(events)
  const restart = all.filter(s => s.signal === 'plan-restart')
  assert.strictEqual(restart.length, 1)
  assert.strictEqual(restart[0].seq, 3)
  assert.strictEqual(restart[0].meta.priorErrorSeq, 2)
})

test('wire-side signals (trace/signal events) are consumed verbatim and marked source:wire', () => {
  const events = [
    {
      type: 'trace/signal', seq: 100,
      data: { signal: 'loop-detected', name: 'fs.read', run: 5 },
    },
  ]
  const { all } = SD.detectSignals(events)
  assert.strictEqual(all.length, 1)
  assert.strictEqual(all[0].signal, 'loop-detected')
  assert.strictEqual(all[0].seq, 100)
  assert.strictEqual(all[0].meta.source, 'wire')
})

test('detectSignalsFromRecords flattens step records back to a seq-ordered event list', () => {
  const rec = {
    turn: 1, step: 0, startSeq: 10, endSeq: 15,
    inputs: [],
    outputs: [
      { type: 'tool/call', seq: 12, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c1' } },
    ],
    events: [
      { type: 'tool/call', seq: 12, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c1' } },
      { type: 'tool/call', seq: 13, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c2' } },
      { type: 'tool/call', seq: 14, data: { name: 'fs.read', arguments: '{"p":"a"}', callId: 'c3' } },
    ],
  }
  const { all } = SD.detectSignalsFromRecords(rec, { loopN: 3 })
  const loops = all.filter(s => s.signal === 'loop-detected')
  assert.strictEqual(loops.length, 1, 'dedup on seq means only one entry per event')
  assert.strictEqual(loops[0].seq, 14)
})

test('labelFor and classFor return the expected mappings', () => {
  assert.strictEqual(SD.labelFor('loop-detected'), 'Loop detected')
  assert.strictEqual(SD.labelFor('redundant-call'), 'Redundant call')
  assert.strictEqual(SD.labelFor('plan-update'), 'Plan update')
  assert.strictEqual(SD.labelFor('plan-restart'), 'Plan restart')
  assert.strictEqual(SD.labelFor('tool-error'), 'Tool error')

  assert.strictEqual(SD.classFor('loop-detected'), 'sig-loop')
  assert.strictEqual(SD.classFor('redundant-call'), 'sig-redundant')
  assert.strictEqual(SD.classFor('plan-update'), 'sig-plan')
  assert.strictEqual(SD.classFor('plan-restart'), 'sig-plan-restart')
  assert.strictEqual(SD.classFor('tool-error'), 'sig-error')
})

test('tooltipFor produces a readable tooltip for each signal kind', () => {
  const tip1 = SD.tooltipFor({
    signal: 'loop-detected', seq: 12,
    meta: { source: 'heuristic', name: 'fs.read', run: 3, priorSeqs: [10, 11] },
  })
  assert.match(tip1, /Loop detected/)
  assert.match(tip1, /fs\.read/)
  assert.match(tip1, /heuristic/)

  const tip2 = SD.tooltipFor({
    signal: 'plan-update', seq: 20,
    meta: { source: 'heuristic', snippet: 'here is the new plan…' },
  })
  assert.match(tip2, /Plan update/)
  assert.match(tip2, /new plan/i)
})
