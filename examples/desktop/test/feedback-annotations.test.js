// feedback-annotations.test.js — lane-wf-feedback item 2 (main-process store).
//
// Points DSH_DESKTOP_HOME at a per-test tmp dir so real ~/.dsh-desktop never
// gets touched. Exercises the per-event annotation store's upsert / clear /
// remove semantics + the persisted record shape (the RL seed).

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function withTmpHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-feedback-'))
  const prev = process.env.DSH_DESKTOP_HOME
  process.env.DSH_DESKTOP_HOME = home
  try { fn(home) }
  finally {
    if (prev == null) delete process.env.DSH_DESKTOP_HOME
    else process.env.DSH_DESKTOP_HOME = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function freshRequire() {
  delete require.cache[require.resolve('../src/main/feedback-annotations.js')]
  return require('../src/main/feedback-annotations.js')
}

test('list: empty before any write', () => {
  withTmpHome(() => {
    const F = freshRequire()
    assert.deepEqual(F.list(), { ok: true, entries: [] })
  })
})

test('upsert: writes a record and list reads it back with the RL-seed shape', () => {
  withTmpHome(() => {
    const F = freshRequire()
    const r = F.upsert({ sessionId: 's1', seq: 7, verdict: 'up', note: 'good turn', rubricDim: 'convergence' })
    assert.equal(r.ok, true)
    assert.equal(r.entry.sessionId, 's1')
    assert.equal(r.entry.seq, 7)
    assert.equal(r.entry.verdict, 'up')
    assert.equal(r.entry.note, 'good turn')
    assert.equal(r.entry.rubricDim, 'convergence')
    assert.equal(typeof r.entry.at, 'number')
    const { entries } = F.list()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].sessionId, 's1')
  })
})

test('upsert: re-annotating the same (sessionId, seq) overwrites in place', () => {
  withTmpHome(() => {
    const F = freshRequire()
    F.upsert({ sessionId: 's1', seq: 7, verdict: 'up', note: 'first' })
    F.upsert({ sessionId: 's1', seq: 7, verdict: 'down', note: 'revised' })
    const { entries } = F.list()
    assert.equal(entries.length, 1, 'still one record for the same key')
    assert.equal(entries[0].verdict, 'down')
    assert.equal(entries[0].note, 'revised')
  })
})

test('upsert: distinct (sessionId, seq) pairs accumulate', () => {
  withTmpHome(() => {
    const F = freshRequire()
    F.upsert({ sessionId: 's1', seq: 1, verdict: 'up', note: 'a' })
    F.upsert({ sessionId: 's1', seq: 2, verdict: 'down', note: 'b' })
    F.upsert({ sessionId: 's2', seq: 1, verdict: 'up', note: 'c' })
    assert.equal(F.list().entries.length, 3)
  })
})

test('upsert: an empty annotation clears an existing record', () => {
  withTmpHome(() => {
    const F = freshRequire()
    F.upsert({ sessionId: 's1', seq: 7, verdict: 'up', note: 'x' })
    const r = F.upsert({ sessionId: 's1', seq: 7, verdict: null, note: '   ' })
    assert.equal(r.ok, true)
    assert.equal(r.cleared, true)
    assert.equal(F.list().entries.length, 0)
  })
})

test('upsert: missing sessionId/seq is rejected, no file written', () => {
  withTmpHome(() => {
    const F = freshRequire()
    assert.equal(F.upsert({ seq: 7, verdict: 'up' }).ok, false)
    assert.equal(F.upsert({ sessionId: 's1', verdict: 'up' }).ok, false)
    assert.equal(F.list().entries.length, 0)
  })
})

test('remove: drops a record; removing a missing one is a no-op ok', () => {
  withTmpHome(() => {
    const F = freshRequire()
    F.upsert({ sessionId: 's1', seq: 7, verdict: 'up', note: 'x' })
    assert.deepEqual(F.remove({ sessionId: 's1', seq: 7 }), { ok: true, removed: true })
    assert.deepEqual(F.remove({ sessionId: 's1', seq: 7 }), { ok: true, removed: false })
    assert.equal(F.list().entries.length, 0)
  })
})

test('annotationsPath lands under DSH_DESKTOP_HOME', () => {
  withTmpHome((home) => {
    const F = freshRequire()
    assert.equal(F.annotationsPath(), path.join(home, 'feedback-annotations.json'))
    F.upsert({ sessionId: 's1', seq: 7, verdict: 'up', note: 'x' })
    assert.equal(fs.existsSync(path.join(home, 'feedback-annotations.json')), true)
  })
})
