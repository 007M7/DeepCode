// Third-strike regression pin (2026-07-16 round-4 pre-verify): the empty-
// session filter had been broken twice at different layers, so this test
// covers the full pipeline end-to-end — the shape the DAEMON actually
// ships on `session/list` (persisted:true, no hasUserMessage flag, no
// eventCount field yet) must flow through `refreshSessionList` →
// `enrichEntry` / `getSessions()` → `panels-c.filterEmptySessions`
// without any layer synthesising a bit that hides an empty row.
//
// Round-3 (79e5fd3) added an escape hatch to the predicate. Round-4 found
// that `enrichEntry` was setting `hasUserMessage = persisted || localBit`
// which meant every daemon-listed row got `true` and the escape hatch never
// fired. The fix here: layers that don't know must return `undefined`, not
// fabricate `true`. The escape hatch (`undefined && eventCount === 0`)
// then handles the persisted-only smoke rows once the wire side ships
// `eventCount` on `session/list` (impl-plugin-wire lane).
//
// Three fixtures cover the state matrix:
//   1. Daemon shape TODAY — persisted:true, no flag, no eventCount.
//      Filter keeps the row (conservative unknown-keep) because it truly
//      doesn't know yet. Visual: unchanged from pre-fix until the wire
//      side lands. Correct behaviour under uncertainty.
//   2. Daemon shape WITH eventCount:0 — the wire-side fix has landed and
//      ships `eventCount` for persisted rows. Filter drops the row because
//      the flag is undefined AND eventCount === 0. This is the row that
//      unblocks Mission Tree / Growth / Recent.
//   3. Locally-observed session — user sent a message this life of the
//      process. Meta bit was flipped in send(). enrichEntry surfaces it
//      as `hasUserMessage:true`. Filter keeps it regardless of eventCount.
//
// Every case runs the pipeline twice — once through the Recent path
// (`getEnrichedEntries()`) and once through the Mission path
// (`getSessions()`) — because these are the two projections in
// renderer.js that used to fabricate the flag.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')
const { filterEmptySessions } = require('../src/renderer/panels-c.js')

async function bootWithEntries(entries) {
  const { window, renderer } = await loadRenderer({
    async listSessions() { return entries },
  })
  // refreshSessionList drives state.entries + state.sessions.meta from the
  // stubbed listSessions response. This is exactly the boot-time path the
  // real Electron shell walks, minus the network.
  await renderer.refreshSessionList()
  const chat = window.__dshChat
  return { chat, renderer }
}

// Case 1 — the daemon shape observed on the round-4 pre-verify build.
// Every row is persisted:true with no hasUserMessage or eventCount. This
// is the smoke-fixture pattern in the 122-row local corpus.
test('pipeline: raw daemon shape (persisted:true, no flag, no count) yields undefined hasUserMessage', async () => {
  const now = Date.now()
  const raw = [
    { sessionId: 'smoke-a', title: 'smoke-a', persisted: true, live: false, running: false, lastEventTime: now - 3_600_000 },
    { sessionId: 'smoke-b', title: 'smoke-b', persisted: true, live: false, running: false, lastEventTime: now - 3_500_000 },
  ]
  const { chat } = await bootWithEntries(raw)

  // Enriched view — used by Recent + Growth.
  const enriched = chat.getEnrichedEntries()
  for (const e of enriched) {
    assert.equal(e.hasUserMessage, undefined,
      `enrichEntry must not fabricate hasUserMessage from persisted alone (got ${e.hasUserMessage} for ${e.sessionId})`)
    assert.equal(e.eventCount, undefined,
      `eventCount stays undefined when daemon omits it (got ${e.eventCount} for ${e.sessionId})`)
  }
  // getSessions projection — used by Mission Tree.
  const projected = chat.getSessions()
  for (const p of projected) {
    assert.equal(p.hasUserMessage, undefined,
      `getSessions() must not fabricate hasUserMessage from meta.persisted (got ${p.hasUserMessage} for ${p.sessionId})`)
  }

  // Filter behaviour: unknown flag AND unknown eventCount → conservative
  // keep (both rows survive). This documents that the shell-side fix
  // alone does not visually change the empty-row problem — it makes the
  // predicate reachable. The wire-side eventCount is what actually flips
  // the drop.
  const keptRecent = filterEmptySessions(enriched).map((r) => r.sessionId).sort()
  const keptMission = filterEmptySessions(projected).map((r) => r.sessionId).sort()
  assert.deepEqual(keptRecent, ['smoke-a', 'smoke-b'])
  assert.deepEqual(keptMission, ['smoke-a', 'smoke-b'])
})

// Case 2 — wire side has caught up and ships `eventCount:0` for persisted
// smoke rows. Pipeline must drop them from every surface simultaneously.
test('pipeline: daemon-with-eventCount:0 drops smoke rows on Recent AND Mission', async () => {
  const now = Date.now()
  const raw = [
    { sessionId: 'smoke-a', title: 'smoke-a', persisted: true, live: false, running: false, lastEventTime: now - 3_600_000, eventCount: 0 },
    { sessionId: 'smoke-b', title: 'smoke-b', persisted: true, live: false, running: false, lastEventTime: now - 3_500_000, eventCount: 0 },
    { sessionId: 'real',    title: 'devtools drawer test', persisted: true, live: false, running: false, lastEventTime: now - 60_000, eventCount: 12 },
  ]
  const { chat } = await bootWithEntries(raw)

  const enriched = chat.getEnrichedEntries()
  // eventCount must be forwarded verbatim — the filter's escape hatch depends on it.
  const bySession = new Map(enriched.map((e) => [e.sessionId, e]))
  assert.equal(bySession.get('smoke-a').eventCount, 0)
  assert.equal(bySession.get('real').eventCount, 12)

  const projected = chat.getSessions()
  // Same on the Mission projection — meta stashed the count in
  // ensureSession, getSessions reads it back out.
  const byMission = new Map(projected.map((p) => [p.sessionId, p]))
  assert.equal(byMission.get('smoke-a').eventCount, 0)
  assert.equal(byMission.get('real').eventCount, 12)

  const keptRecent = filterEmptySessions(enriched).map((r) => r.sessionId)
  const keptMission = filterEmptySessions(projected).map((r) => r.sessionId)
  assert.deepEqual(keptRecent, ['real'],
    `smoke rows must drop when hasUserMessage:undefined + eventCount:0; got ${keptRecent.join(',')}`)
  assert.deepEqual(keptMission, ['real'],
    `same drop must apply on the Mission projection; got ${keptMission.join(',')}`)
})

// Case 3 — locally-observed session. renderer.js flips meta.hasUserMessage
// = true when send() runs or user/message notifications arrive. enrichEntry
// must surface that as the enriched flag, and it wins over any eventCount
// heuristic.
test('pipeline: locally-observed hasUserMessage survives regardless of eventCount', async () => {
  const now = Date.now()
  const raw = [
    { sessionId: 'local-msg', title: '', persisted: true, live: true, running: false, lastEventTime: now - 1_000, eventCount: 0 },
  ]
  const { chat, renderer } = await bootWithEntries(raw)
  // Fake the "we sent a message" side-effect — same as `send()` does in
  // the composer path. state.sessions is the source of truth for the meta
  // bit; ensureSession-with-hasUserMessage is what send() actually calls.
  renderer.ensureSession('local-msg', { title: '', header: {}, hasUserMessage: true })

  const enriched = chat.getEnrichedEntries()
  assert.equal(enriched[0].hasUserMessage, true,
    'enrichEntry must surface meta.hasUserMessage when the local bit is set')
  const projected = chat.getSessions()
  assert.equal(projected[0].hasUserMessage, true,
    'getSessions() must surface meta.hasUserMessage even when eventCount says 0')

  const keptRecent = filterEmptySessions(enriched).map((r) => r.sessionId)
  const keptMission = filterEmptySessions(projected).map((r) => r.sessionId)
  assert.deepEqual(keptRecent, ['local-msg'])
  assert.deepEqual(keptMission, ['local-msg'])
})

// Case 4 — the specific 122-row round-4 corpus, in miniature. Once the
// wire side lands eventCount, the visual should look like a single real
// row plus the active empty. This is the shape team-lead's reshoot will
// hit next: 121 smoke fixtures with eventCount:0, 1 real, 1 active empty.
test('pipeline: round-4 corpus miniature — 12 smoke + 1 real + 1 active empty drops to 2', async () => {
  const now = Date.now()
  const raw = [
    { sessionId: 'real', title: 'devtools drawer test', persisted: true, live: false, running: false, lastEventTime: now - 60_000, eventCount: 12 },
    { sessionId: 'active-empty', title: '', persisted: false, live: true, running: false, lastEventTime: now - 100, eventCount: 0 },
  ]
  for (let i = 0; i < 12; i++) {
    raw.push({
      sessionId: `smoke-tr-${i}`,
      title: `smoke-tr-${i}`,
      persisted: true, live: false, running: false,
      lastEventTime: now - 3_600_000 - i * 1000,
      eventCount: 0,
    })
  }
  const { chat } = await bootWithEntries(raw)
  const kept = filterEmptySessions(chat.getEnrichedEntries(), { activeSessionId: 'active-empty' })
    .map((r) => r.sessionId).sort()
  assert.deepEqual(kept, ['active-empty', 'real'],
    `only the real session + the active empty survive; got ${kept.join(',')}`)
  // Mission uses getSessions() and would call this without an activeSessionId
  // hint. Without the hint the active-empty (eventCount:0, no flag) also drops
  // — that's fine, Mission's aggregate should reflect "sessions with real
  // activity" not "sessions currently focused".
  const missionKept = filterEmptySessions(chat.getSessions()).map((r) => r.sessionId).sort()
  assert.deepEqual(missionKept, ['real'])
})
