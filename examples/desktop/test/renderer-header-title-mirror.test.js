// §4.1 pair test: header.title mirror at ensureSession seed.
//
// Real-daemon wire truth (team-lead's port 9224 audit, docs/stabilization-
// review.md §4 follow-up 1): persisted rows ship the human title at
// `entry.header.title`, not the flat `entry.title` field. Reading only the
// flat field on `refreshSessionList` blanks meta.title to '' on every sweep,
// which then falls through to `smartSessionTitle`'s untitled path — so every
// persisted session in the Recent list reads "Untitled · <rel-time>" even
// when the daemon has a perfectly good stored title.
//
// The fix at renderer.js:284-294 merges wire fields with a precedence chain
// (flat > existing meta > header > empty). These tests fixate that chain:
//
//   1. flat entry.title wins when present
//   2. locally seeded meta.title is preserved across sweeps that lose the
//      flat field (wire lag, minimal daemon-echo profile, mid-turn state)
//   3. entry.header.title fills in when the daemon shape is header-only
//   4. truly empty rows land '' so smartSessionTitle collapses to Untitled
//
// The final chained test drives the same fixture through
// panels-c.smartSessionTitle to prove the full end-to-end pipeline —
// following the multi-agent shared-repo rule: fixture must mirror upstream
// wire shape, not a synthesized predicate input.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { loadRenderer } = require('./renderer-harness.js')

function loadPanelsC() {
  const p = require.resolve(path.resolve(__dirname, '..', 'src', 'renderer', 'panels-c.js'))
  delete require.cache[p]
  return require(p)
}

test('§4.1: flat entry.title wins when both flat and header carry a title', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-both',
        title: 'Flat wins',
        header: { title: 'Header loses' },
        live: false, persisted: true,
        lastEventTime: Date.now(),
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-both')
  assert.equal(meta.title, 'Flat wins',
    'server-authoritative flat title takes precedence over header.title')
})

test('§4.1: header.title fills meta.title when flat entry.title is empty (persisted daemon shape)', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      // Persisted-row shape as observed on real daemon port 9224: the human
      // title lives at header.title; flat entry.title is absent. This is
      // the exact fixture that produced Untitled-flood in the Recent list
      // pre-fix — every persisted row landed with meta.title=''.
      return [{
        sessionId: 's-header-only',
        header: { title: '修复 fs-local 边界' },
        live: false, persisted: true,
        lastEventTime: Date.now() - 60_000,
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-header-only')
  assert.equal(meta.title, '修复 fs-local 边界',
    'header.title must fall through when flat title is missing')
})

test('§4.1: locally seeded meta.title survives a refresh sweep that drops the flat field', async () => {
  // Team-lead's precedence note: "本地已有 title 不覆盖，只在 meta.title
  // 为空时兜底". The scenario: user sends a first message, send() seeds
  // meta.title from the message body slice; then a session/list sweep
  // arrives before the daemon has persisted the title back. Without the
  // guard, the sweep would clobber meta.title to '' → header.title (also
  // empty at this moment) → '' → Untitled. With the guard, the local seed
  // holds until the wire catches up.
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-race',
        // flat title empty; header also empty — wire hasn't caught up yet.
        header: {},
        live: true, persisted: false,
        lastEventTime: Date.now(),
      }]
    },
  })
  // Seed a local title as if the user had just sent a first message.
  renderer.ensureSession('s-race', { title: 'Locally seeded from send()' })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-race')
  assert.equal(meta.title, 'Locally seeded from send()',
    'refresh sweep must not clobber a locally seeded title with empty wire fields')
})

test('§4.1: truly empty row (no flat, no header, no local) lands meta.title=""', async () => {
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-empty',
        header: {},
        live: true, persisted: false,
        lastEventTime: Date.now(),
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-empty')
  assert.equal(meta.title, '',
    'truly untitled row must land empty so smartSessionTitle can collapse to Untitled')
})

test('§4.1 end-to-end: persisted daemon-shape row renders real title (not Untitled) via smartSessionTitle', async () => {
  // Full-chain assertion following the multi-agent shared-repo discipline:
  // fixture mirrors real daemon wire shape (header.title only) and we
  // assert the final user-visible label via the same panels-c.
  // smartSessionTitle path the Recent list renderer uses.
  const now = Date.now()
  const { renderer } = await loadRenderer({
    async listSessions() {
      return [{
        sessionId: 's-e2e',
        header: { title: 'Deep review of P0 batch' },
        live: false, persisted: true,
        lastEventTime: now - 120_000,
      }]
    },
  })
  await renderer.refreshSessionList()
  const meta = renderer.getSessionMeta('s-e2e')
  const { smartSessionTitle } = loadPanelsC()
  // renderSessionList feeds smartSessionTitle a rowMeta shaped like
  // `{ ...entry, title: meta.title || entry.title }`. Reconstruct that
  // here so this test breaks the same way the DOM would.
  const rowMeta = {
    sessionId: 's-e2e',
    title: meta.title,
    header: { title: 'Deep review of P0 batch' },
    lastEventTime: now - 120_000,
  }
  const out = smartSessionTitle(rowMeta, now)
  assert.equal(out.isUntitled, false,
    'persisted row with a real header.title must not render as Untitled')
  assert.equal(out.text, 'Deep review of P0 batch',
    'the header-shipped title must reach smartSessionTitle unchanged')
})
