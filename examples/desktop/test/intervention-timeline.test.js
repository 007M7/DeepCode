'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/renderer/intervention-timeline.js')

let _seq = 0
function nextSeq() { _seq += 1; return _seq }
function reset() { _seq = 0 }

function userMsg(extra = {}) {
  return {
    type: 'user/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { content: [{ type: 'text', text: 'hi' }], ...extra },
  }
}
function steer(text = 'no wait') {
  return {
    type: 'steering/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { content: [{ type: 'text', text }] },
  }
}
function fork(parentSeq = 5) {
  return {
    type: 'session/forked',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { parentSeq },
  }
}
function editRerun(origSeq = 3) {
  return {
    type: 'user/message',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: {
      content: [{ type: 'text', text: 'redone' }],
      editRerun: { origSeq, reason: 'typo fix' },
    },
  }
}
function turnEnd(turn) {
  return {
    type: 'turn/end',
    seq: nextSeq(),
    time: 1_700_000_000_000 + _seq * 1000,
    data: { turn, reason: { kind: 'completed' } },
  }
}

test('collectInterventions: detects all three kinds', () => {
  reset()
  const events = [userMsg(), turnEnd(1), editRerun(1), steer(), fork(2), turnEnd(2)]
  const markers = M.collectInterventions(events)
  const kinds = markers.map((m) => m.kind).sort()
  assert.deepEqual(kinds, ['edit-rerun', 'fork', 'steer'])
})

test('collectInterventions: sorts by seq', () => {
  reset()
  const events = [fork(1), steer(), editRerun(2)]
  const markers = M.collectInterventions(events)
  for (let i = 1; i < markers.length; i++) {
    assert.ok(markers[i].seq >= markers[i - 1].seq, 'markers seq-ordered')
  }
})

test('collectInterventions: turn tracking increments on turn/end', () => {
  reset()
  const events = [steer(), turnEnd(1), fork(1)]
  const markers = M.collectInterventions(events)
  assert.equal(markers[0].kind, 'steer')
  assert.equal(markers[0].turn, 0, 'steer before first turn/end lands in turn 0')
  assert.equal(markers[1].kind, 'fork')
  assert.equal(markers[1].turn, 2, 'fork after turn/end 1 anchors turn 2 (next-turn window)')
})

test('collectInterventions: fork marker via context/message with fork source', () => {
  reset()
  const events = [{
    type: 'context/message',
    seq: nextSeq(),
    data: { content: [{ type: 'text', text: 'forked' }], source: { kind: 'fork', parentSeq: 7 } },
  }]
  const markers = M.collectInterventions(events)
  assert.equal(markers.length, 1)
  assert.equal(markers[0].kind, 'fork')
  assert.match(markers[0].preview, /seq 7/)
})

test('collectInterventions: edit-rerun via plugin source too', () => {
  reset()
  const events = [{
    type: 'user/message',
    seq: nextSeq(),
    data: { content: [{ type: 'text', text: 're' }], source: { kind: 'plugin', plugin: 'edit-rerun' } },
  }]
  const markers = M.collectInterventions(events)
  assert.equal(markers.length, 1)
  assert.equal(markers[0].kind, 'edit-rerun')
})

test('collectInterventions: empty stream → []', () => {
  assert.deepEqual(M.collectInterventions([]), [])
  assert.deepEqual(M.collectInterventions(null), [])
})

test('summariseInterventions: rolls up per-kind counts, omits zero', () => {
  reset()
  const events = [steer(), steer(), fork(1)]
  const markers = M.collectInterventions(events)
  const roll = M.summariseInterventions(markers)
  const map = new Map(roll.map((r) => [r.kind, r.count]))
  assert.equal(map.get('steer'), 2)
  assert.equal(map.get('fork'), 1)
  assert.equal(map.has('edit-rerun'), false)
})
