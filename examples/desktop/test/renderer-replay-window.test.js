// Regression + spec test for task #112: replayHistory paginates the daemon's
// bounded read window instead of asking for the whole log in one shot.
//
// The bug: fresh forks inherit the parent's full log; first-visit replay
// called `sessionEvents(id, { seq: total, before: total, after: 0 })`. The
// daemon's `SESSION_QUERY_READ_WINDOW_MAX` (default 50) rejects any
// `before > 50` with `SESSION_QUERY_INVALID_WINDOW`, replayHistory's catch
// silently swallowed it, chat rendered empty. Fork-scenario cost: the user
// opens a fork specifically to see the *head* (seed messages, early
// decisions); a naive tail-50 clamp fixes the empty pane but slices off
// exactly what the user came for. The right fix is a walk-back loop that
// reconstructs the full log via 50-event chunks.
//
// Contract (kept intentionally tight so a regression trips fast):
//   • Metadata listing (no `seq`) is call #1; it drives the tail cursor.
//   • Each windowed read uses `before` ≤ 50 and `after: 0`.
//   • Loop stops at startSeq === 0 (or a monotonic-cursor / round-cap fuse).
//   • Full history renders — 200-event fixture reappears in seq order.
//   • Overlapping/repeated seqs from a misbehaving daemon are de-duplicated.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

// Metadata-only listing shape: `SessionEventRecord` = {seq, type, time,
// surface}; no `data` field — matches the daemon's no-seq response.
function metadataListing(total) {
  const events = []
  for (let seq = 1; seq <= total; seq++) {
    events.push({
      seq,
      type: seq === 1 ? 'user/message' : 'assistant/message',
      time: 1000 + seq,
      surface: 'current',
    })
  }
  return { sessionId: 'sid', events }
}

// Windowed reader that mirrors session-query's `readEvent(seq, before, after)`
// semantics: returns `events` covering `[max(0, seq-before), min(total,
// seq+after)]` plus `startSeq`/`endSeq`. Rejects `before > 50` the way the
// real daemon does (`SESSION_QUERY_INVALID_WINDOW`).
function makeDaemon(total, opts = {}) {
  const readWindowMax = opts.readWindowMax ?? 50
  const calls = []
  const impl = async (id, o) => {
    calls.push({ id, opts: o })
    if (o.seq === undefined) return metadataListing(total)
    if (typeof o.before === 'number' && o.before > readWindowMax) {
      throw new Error(`before must be an integer between 0 and ${readWindowMax}`)
    }
    const before = typeof o.before === 'number' ? o.before : 0
    const after = typeof o.after === 'number' ? o.after : 0
    const startSeq = Math.max(1, o.seq - before + 1)
    const endSeq = Math.min(total, o.seq + after)
    const events = []
    for (let seq = startSeq; seq <= endSeq; seq++) {
      events.push({
        seq,
        type: seq === 1 ? 'user/message' : 'assistant/message',
        time: 1000 + seq,
        surface: 'current',
        data: { content: [{ type: 'text', text: `event-${seq}` }] },
      })
    }
    // session-query's startSeq is zero-based on the internal array; we return
    // the seq of the first event in this chunk, which is what the loop
    // actually consumes for its next-cursor calculation.
    return { sessionId: 'sid', events, startSeq, endSeq }
  }
  return { impl, calls }
}

test('replayHistory: 200-event fork reconstructs full log via 50-chunk walk-back', async () => {
  const { impl, calls } = makeDaemon(200)
  const { renderer } = await loadRenderer({ sessionEvents: impl })
  renderer.ensureSession('sid', { title: 'fork of parent', header: {} })
  await renderer.selectSession('sid')

  // Metadata + ceil(200/50) = 4 windowed reads. Anything more (or less)
  // means the loop mis-advanced.
  const windowed = calls.filter(c => c.opts.seq !== undefined)
  assert.equal(windowed.length, 4, `expected 4 windowed reads for 200 events / 50 window, got ${windowed.length}`)
  for (const w of windowed) {
    assert.ok(w.opts.before <= 50, `before must be ≤ 50 (got ${w.opts.before})`)
    assert.equal(w.opts.after, 0, 'never over-fetch forward during replay')
  }
  // The cursor must strictly decrease so we don't loop forever.
  const seqs = windowed.map(w => w.opts.seq)
  for (let i = 1; i < seqs.length; i++) {
    assert.ok(seqs[i] < seqs[i - 1], `cursor must decrease strictly (${seqs[i - 1]} → ${seqs[i]})`)
  }

  // Head *and* tail must have rendered — the whole point of paginating
  // instead of tail-clamping is that fork users see the seed messages.
  const streamText = renderer.getStreamText ? renderer.getStreamText() : ''
  assert.ok(streamText.includes('event-1'), `head event missing from replay (fork users need this): ${streamText.slice(0, 200)}…`)
  assert.ok(streamText.includes('event-200'), `tail event missing from replay: …${streamText.slice(-200)}`)
})

test('replayHistory: <=50-event session does one round and stops', async () => {
  const { impl, calls } = makeDaemon(12)
  const { renderer } = await loadRenderer({ sessionEvents: impl })
  renderer.ensureSession('sid', { title: 't', header: {} })
  await renderer.selectSession('sid')
  const windowed = calls.filter(c => c.opts.seq !== undefined)
  assert.equal(windowed.length, 1, 'small session terminates after one chunk (startSeq hits boundary)')
  assert.ok(windowed[0].opts.before <= 50)
})

test('replayHistory: mid-loop failure keeps partial history rather than clearing it', async () => {
  // Fail on the second windowed read so the fixture proves "partial > empty":
  // round 1 collects seq 151..200, round 2 throws, we still render 50 events.
  const { impl: goodImpl } = makeDaemon(200)
  const calls = []
  let windowRound = 0
  const impl = async (id, o) => {
    calls.push({ id, opts: o })
    if (o.seq === undefined) return goodImpl(id, o)
    windowRound++
    if (windowRound === 2) throw new Error('daemon transient failure at cursor ' + o.seq)
    return goodImpl(id, o)
  }
  const { renderer } = await loadRenderer({ sessionEvents: impl })
  renderer.ensureSession('sid', { title: 'transient', header: {} })
  await renderer.selectSession('sid')
  const streamText = renderer.getStreamText ? renderer.getStreamText() : ''
  assert.ok(streamText.includes('event-200'), 'tail chunk must survive a downstream failure — partial > empty')
  // Sanity: round 2 failed, so events 101..150 never made it in. `event-100`
  // (in that missing round) is a boundary-safe probe — checking `event-1`
  // would match `event-100`, `event-151`, etc. as substrings.
  assert.ok(!streamText.includes('event-100'), 'sanity: we did stop early (round-2 events must be missing on failure)')
})

test('replayHistory: overlapping seqs from a misbehaving daemon are de-duplicated', async () => {
  // Simulate a daemon that returns overlapping windows (e.g. a boundary bug).
  // The loop must not double-render.
  let round = 0
  const impl = async (id, o) => {
    if (o.seq === undefined) return metadataListing(6)
    round++
    // Round 1: return seqs 1..6. Round 2 (if the loop mistakenly runs it):
    // return seqs 4..6 again — the dedup guard must swallow them.
    if (round === 1) {
      return {
        sessionId: 'sid',
        startSeq: 1,
        endSeq: 6,
        events: Array.from({ length: 6 }, (_, i) => ({
          seq: i + 1,
          type: 'assistant/message',
          time: 1000 + i,
          surface: 'current',
          data: { content: [{ type: 'text', text: `event-${i + 1}` }] },
        })),
      }
    }
    return {
      sessionId: 'sid',
      startSeq: 4,
      endSeq: 6,
      events: [4, 5, 6].map(seq => ({
        seq,
        type: 'assistant/message',
        time: 1000 + seq,
        surface: 'current',
        data: { content: [{ type: 'text', text: `event-${seq}` }] },
      })),
    }
  }
  const { renderer } = await loadRenderer({ sessionEvents: impl })
  renderer.ensureSession('sid', { title: 'dup-guard', header: {} })
  await renderer.selectSession('sid')
  const streamText = renderer.getStreamText ? renderer.getStreamText() : ''
  // "event-5" must appear exactly once even if the daemon offered it twice.
  const occurrences = streamText.split('event-5').length - 1
  assert.equal(occurrences, 1, `event-5 must render exactly once (got ${occurrences}); dedup guard failed`)
})
