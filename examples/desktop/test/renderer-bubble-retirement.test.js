// Tests for task #162 rec 22-bis phase 2: assistant bubble retirement.
//
// Contract (pi-agent-ui-study.md §2.3): when an assistant bubble is
// created INSIDE an active `.turn-body` container, it must land as a
// peer of tool rows / reasoning / footer — the outer `.msg.assistant`
// stays for downstream selector compat (updateForkButtons, fork-seq
// stamping, JSON drawer, tool cards), but visually retires: role chip
// dropped, `.text-block.turn-child` on the body, `.in-turn` marker on
// the outer. Stream-root landings (any caller passing `target: streamEl`
// or omitting target — appendSystem is the current in-tree case, plus
// legacy replay callers if any) keep the legacy chip+body bubble shape
// so those regression surfaces stay untouched.
//
// The two regression paths (persisted-replay, quick-chat) are covered
// by the CDP selfie pack; this suite is the unit-level pin.

const test = require('node:test')
const assert = require('node:assert')
const { loadRenderer } = require('./renderer-harness.js')

test('in-turn assistant bubble adopts .in-turn + drops role chip + wraps body in .text-block.turn-child', async () => {
  const { renderer, window } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  // Open a turn container so appendMessage's target is a .turn-body.
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  renderer.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: { content: 'hi in turn' } })
  const bubbles = window.document.querySelectorAll('.msg.assistant')
  assert.ok(bubbles.length >= 1, 'expected assistant bubble in stream')
  const b = bubbles[bubbles.length - 1]
  // Phase 2 marker on the outer element so CSS can retire chrome.
  assert.ok(b.classList.contains('in-turn'),
    'assistant bubble inside .turn-body should carry .in-turn')
  // Role chip dropped in the retired shape.
  assert.equal(b.querySelector('.role'), null,
    '.role chip should be dropped for in-turn bubbles')
  // Body child is the first-class turn peer.
  const body = b.querySelector('.text-block.turn-child')
  assert.ok(body, 'expected .text-block.turn-child body child')
  // Fork anchor still present on the outer — moat for updateForkButtons.
  assert.ok(b.querySelector('.fork-here'),
    'fork-here anchor must survive bubble retirement')
})

test('fork-seq stamp lands on the retired-in-turn bubble at assistant/message time', async () => {
  const { renderer, window } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  renderer.onSessionEvent('s1', { type: 'turn/start', seq: 1 })
  renderer.onSessionEvent('s1', { type: 'assistant/message', seq: 2, data: { content: 'x' } })
  const b = window.document.querySelector('.msg.assistant.in-turn')
  assert.ok(b, 'in-turn bubble should exist')
  // assistant/message writes both data-seq (dataset) and data-fork-seq —
  // the latter is what session/fork consults at click time. Bubble
  // retirement preserved the outer `.msg.assistant`, so these stamps still
  // land on the fork-anchor element.
  assert.equal(b.dataset.forkSeq, '2',
    'assistant/message must stamp data-fork-seq on the retired-in-turn bubble')
  assert.equal(b.dataset.seq, '2',
    'assistant/message must stamp data-seq on the retired-in-turn bubble')
})

test('legacy stream-root bubble shape survives for user messages (no .in-turn, keeps .role chip)', async () => {
  const { renderer, window } = await loadRenderer()
  renderer.ensureSession('s1', { title: 'sess', header: {} })
  await renderer.selectSession('s1')
  // A user/message event never enters an assistant turn container and
  // never gains the retirement marker — this is the guard that keeps
  // history replay / quick-chat / user echoes from mis-inheriting the
  // retired shape.
  renderer.onSessionEvent('s1', { type: 'user/message', seq: 1, data: { content: 'hello' } })
  const userBubbles = window.document.querySelectorAll('.msg.user')
  const u = userBubbles[userBubbles.length - 1]
  assert.ok(u, 'user bubble present')
  assert.ok(!u.classList.contains('in-turn'),
    'user bubble must NOT carry .in-turn')
  assert.ok(u.querySelector('.role'), 'user bubble keeps the .role chip')
  assert.equal(u.querySelector('.text-block.turn-child'), null,
    'user bubble must not be wrapped in .text-block.turn-child')
})
