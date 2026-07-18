// Diff-card rendering must survive the wire meta shape today's runtime emits.
//
// # Why this test exists
//
// Two facts about the current runtime (see docs/upstream-ledger.md
// "runtime should emit presented view"):
//
//   1. `agent-loop` persists the tool's raw `execute()` meta verbatim on the
//      `tool/result` event. For `fs.edit`, that shape is `{diffs: [...]}` —
//      NO `card` field. (packages/fs/tool-fs/src/edit.ts:92-96,
//      packages/core/agent-loop/src/loop.ts around the tool/result emit.)
//   2. The tool's `presentResult()` — which WOULD add `card: 'diff'` — is a
//      display-time callback the runtime does not invoke. So the renderer
//      never sees a `card: 'diff'` for fs.edit on the wire today.
//
// The dispatch at src/renderer/renderer.js:4744 primarily routes by
// `view.card === 'diff'`; without a fallback the diff card is unreachable
// on the shipped default profile — as observed in lane-showcase 12/12 run
// (check 5_diff_card_fs = fail, 2026-07-18).
//
// # What this test locks
//
//   - Given the real wire shape (fixture pinned in-repo — see the fixture's
//     own header for provenance), driving `tool/call` + `tool/result` through
//     the renderer's reducer must produce a `.card-diff` element inside the
//     result box.
//   - The primary path (`view.card === 'diff'`) still works — a second
//     assertion drives the same fs.edit callId but with the `card:'diff'`
//     shape a future runtime seam would emit. Both routes render the card.
//
// If the wire shape ever gains a `card` discriminant natively, the fallback
// becomes dead code but this test still passes via the primary branch, so
// there is no rush to prune it.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadRenderer } = require('./renderer-harness')

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'fs-edit-wire-shape.json'), 'utf8'),
)

// Locate a descendant element by CSS class name. Mirrors the renderer's
// probe hook approach (see docs/renderer-probe.md); the shim in
// renderer-harness.js only supports simple class selectors so we walk
// the tree by hand to be robust across nested structures.
function findByClass(root, className) {
  if (!root) return null
  const classList = root.classList
  if (classList && typeof classList.contains === 'function' && classList.contains(className)) {
    return root
  }
  if (Array.isArray(root.children)) {
    for (const child of root.children) {
      const hit = findByClass(child, className)
      if (hit) return hit
    }
  }
  return null
}

test('diff card renders when the wire meta has {diffs} but no card discriminant (fs family fallback)', async () => {
  const { renderer, window, document: doc } = await loadRenderer()
  // tool-cards.js is preloaded as a CommonJS module (see renderer-harness.js
  // preloadPure). Its `renderDiffCard` reads `document` from the module's
  // enclosing scope; when triggered from a Node test rather than inside the
  // renderer wrapper, that reference is the global `document`. The
  // convention (see tool-cards.test.js) is to set it globally per-test.
  global.document = doc
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')

  // The real runtime always emits tool/call before tool/result — the
  // renderer allocates the resBox on tool/call. Drive that sequence.
  renderer.onSessionEvent('s1', FIXTURE.toolCall)
  renderer.onSessionEvent('s1', FIXTURE.toolResult)

  const meta = renderer.getSessionMeta('s1')
  const resBox = meta.toolCalls.get(FIXTURE.toolCall.data.callId)
  assert.ok(resBox, 'renderer must allocate a result box on tool/call')

  const diffCard = findByClass(resBox, 'card-diff')
  assert.ok(
    diffCard,
    'fs.edit tool/result with {diffs:[...]} (no card field) must still render '
      + 'a .card-diff — see docs/upstream-ledger.md "runtime should emit presented view"',
  )

  // Sanity: the raw text fallback branch must NOT have swallowed the box.
  // If the fallback misfires, resBox.textContent gets the flat text content
  // instead of the diff card being appended.
  assert.doesNotMatch(
    (resBox.textContent || ''),
    /Edited \/tmp\/dsh-showcase\/seed-3lines\.txt/,
    'fallback text must not fire when the diff card renders',
  )

  // Reference the window stub so the harness knows it's live — silences
  // the lint about the unused destructured var and documents that this
  // test intentionally observes DOM state through the shared shim.
  assert.ok(window)
})

test('diff card renders on the primary path when the wire ever emits card:"diff" natively', async () => {
  const { renderer, document: doc } = await loadRenderer()
  global.document = doc
  renderer.ensureSession('s1', { title: 's', header: {} })
  await renderer.selectSession('s1')

  renderer.onSessionEvent('s1', FIXTURE.toolCall)
  // Same fixture, but simulate the future-good wire shape by re-wrapping
  // the meta with the discriminant a presentResult-emitting runtime would
  // author. If the primary branch ever regresses, this catches it before
  // the fallback ever runs.
  const primaryResult = {
    ...FIXTURE.toolResult,
    data: {
      ...FIXTURE.toolResult.data,
      meta: {
        card: 'diff',
        title: 'Edit /tmp/dsh-showcase/seed-3lines.txt',
        diffs: FIXTURE.toolResult.data.meta.diffs,
      },
    },
  }
  renderer.onSessionEvent('s1', primaryResult)

  const meta = renderer.getSessionMeta('s1')
  const resBox = meta.toolCalls.get(FIXTURE.toolCall.data.callId)
  const diffCard = findByClass(resBox, 'card-diff')
  assert.ok(diffCard, 'primary card:"diff" dispatch must render .card-diff')
})
