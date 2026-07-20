// feat/step-card-merge (2026-07-19): the tool call row and the trailing
// standalone step card get fused into a single unit at the tool call's
// narrative position. This covers the DOM contract fuseStepIntoToolBlock
// (renderer.js) produces + the finishTurnContainer guard that stops the
// fused card from getting lifted into a trailing turn-trace-drawer.
//
// Related design memo: the assistant turn's chat stream should show ONE
// entry per tool call (the tool-block, now upgraded to a step card),
// not two — the historical grammar dropped a `.tool-block` at the call
// position AND a `.trace-card` at the stream tail. The trailing card is
// suppressed for tool-only steps; text-only steps still emit it.

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { loadRenderer } = require('./renderer-harness.js')

// Small helpers: the test harness has a naive selector matcher that
// doesn't grok combinators or `:scope`. Walk children explicitly.
function directChild(el, predicate) {
  if (!el || !el.children) return null
  for (const c of el.children) if (predicate(c)) return c
  return null
}
function directSummary(el) {
  return directChild(el, c => c && c.tagName === 'SUMMARY')
}
function firstDescendant(el, cls) {
  return el && el.querySelector ? el.querySelector('.' + cls) : null
}
function playStream(renderer, sid, events) {
  for (const ev of events) renderer.onSessionEvent(sid, ev)
}

// Single-tool step in a single-step turn. Should produce:
//   - one .tool-block (also .trace-card-fused, data-step-fused=1)
//   - zero standalone .trace-card
//   - one .turn-footer with the flow glyph but NO .turn-trace-drawer
function makeSingleToolTurn() {
  return [
    { seq: 1, time: 1000, type: 'turn/start', data: {} },
    { seq: 2, time: 1005, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 3, time: 1020, type: 'tool/call', data: {
      callId: 'c-a', name: 'read', arguments: JSON.stringify({ path: 'foo.ts' }),
    } },
    { seq: 4, time: 1080, type: 'tool/result', data: {
      callId: 'c-a', content: [{ type: 'text', text: 'file contents' }],
    } },
    // usage rides on assistant/message; include one so the fused summary
    // gets a usage badge. Real DeepSeek traffic always emits at least one
    // assistant/message per step (the model reply that triggers the call).
    { seq: 5, time: 1100, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'looking at foo.ts' }],
      usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 200 },
    } },
    { seq: 6, time: 1120, type: 'step/end', data: {} },
    { seq: 7, time: 1125, type: 'turn/end', data: { reason: 'completed' } },
  ]
}

test('fused: single tool step upgrades its tool-block into the step card', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-fuse', { title: 't', header: {} })
  await renderer.selectSession('s-fuse')
  playStream(renderer, 's-fuse', makeSingleToolTurn())

  const fused = document.querySelectorAll('.tool-block.trace-card-fused')
  assert.equal(fused.length, 1, 'exactly one fused tool-block acting as the step card')
  const el = fused[0]
  assert.equal(el.dataset.stepFused, '1', 'stepFused marker present for downstream QA/tests')

  // Trailing standalone .trace-card is suppressed for a tool-only step.
  const standalone = document.querySelectorAll('.trace-card:not(.trace-card-fused)')
  assert.equal(standalone.length, 0, 'no trailing standalone .trace-card for tool-only step')

  // Streaming placeholder must be gone (retired on first tool/call).
  const placeholders = document.querySelectorAll('.trace-card-streaming')
  assert.equal(placeholders.length, 0, 'streaming placeholder retired')

  // Summary carries the fused usage badge + duration pill + fold glyph.
  const summary = directSummary(el)
  assert.ok(summary, 'fused card has a summary')
  const summaryChildren = summary.children.map(c => c.className)
  assert.ok(summaryChildren.some(cn => cn.includes('fused-usage-badge')),
    'usage badge attached to fused summary; got children ' + JSON.stringify(summaryChildren))
  const dur = directChild(summary, c => c.className && c.className.includes('fused-duration'))
  assert.ok(dur && /ms$/.test(dur.textContent), 'duration pill shows ms (got ' + (dur && dur.textContent) + ')')
  assert.ok(directChild(summary, c => c.className && c.className.includes('fused-fold-glyph')),
    'right-side fold glyph present')

  // Fused body includes the meta strip + three trace panes.
  const body = directChild(el, c => c.className && c.className.includes('fused-trace-body'))
  assert.ok(body, 'fused trace body appended inside the tool-block')
  assert.ok(firstDescendant(body, 'trace-step-meta'), 'step meta strip lives in fused body')
  const panes = Array.from(body.querySelectorAll('.trace-pane'))
  assert.ok(panes.length >= 3, 'three panes rendered inside fused body — got ' + panes.length)
})

test('fused: single tool step does not build a trailing turn-trace-drawer', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-drw', { title: 't', header: {} })
  await renderer.selectSession('s-drw')
  playStream(renderer, 's-drw', makeSingleToolTurn())

  const drawers = document.querySelectorAll('.turn-trace-drawer')
  assert.equal(drawers.length, 0,
    'fused card stays inline — footer drawer is suppressed for tool-only steps')

  // Turn footer still exists so the "turn ended" glyph + chips are reachable.
  const footers = document.querySelectorAll('.turn-footer')
  assert.equal(footers.length, 1, 'turn footer preserved (glyph + optional chips)')
})

test('fused: multi-tool step lists sibling calls inside the fused card + summary shows "<first> +N"', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-mul', { title: 't', header: {} })
  await renderer.selectSession('s-mul')
  const events = [
    { seq: 1, time: 1000, type: 'turn/start', data: {} },
    { seq: 2, time: 1005, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 3, time: 1010, type: 'tool/call', data: {
      callId: 'c-a', name: 'read', arguments: JSON.stringify({ path: 'a.ts' }),
    } },
    { seq: 4, time: 1015, type: 'tool/call', data: {
      callId: 'c-b', name: 'grep', arguments: JSON.stringify({ pattern: 'foo' }),
    } },
    { seq: 5, time: 1020, type: 'tool/call', data: {
      callId: 'c-c', name: 'bash', arguments: JSON.stringify({ cmd: 'ls' }),
    } },
    { seq: 6, time: 1050, type: 'tool/result', data: { callId: 'c-a', content: [{ type: 'text', text: '.' }] } },
    { seq: 7, time: 1051, type: 'tool/result', data: { callId: 'c-b', content: [{ type: 'text', text: '.' }] } },
    { seq: 8, time: 1052, type: 'tool/result', data: { callId: 'c-c', content: [{ type: 'text', text: '.' }] } },
    { seq: 9, time: 1070, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 20, outputTokens: 5 },
    } },
    { seq: 10, time: 1080, type: 'step/end', data: {} },
    { seq: 11, time: 1085, type: 'turn/end', data: { reason: 'completed' } },
  ]
  playStream(renderer, 's-mul', events)

  // Exactly one fused card, three tool-blocks total (first outer + two absorbed).
  const fused = document.querySelectorAll('.tool-block.trace-card-fused')
  assert.equal(fused.length, 1, 'multi-call step still fuses into one outer card')
  const outer = fused[0]
  assert.equal(outer.getAttribute('data-tool-name'), 'read', 'outer card is the first tool by call order')
  // Absorbed sibling blocks live inside the outer card with the marker class.
  const absorbed = outer.querySelectorAll('.fused-call-row')
  assert.equal(absorbed.length, 2, 'two sibling tool-blocks absorbed into the fused card')
  const absorbedNames = Array.from(absorbed).map(el => el.getAttribute('data-tool-name'))
  assert.deepEqual(absorbedNames, ['grep', 'bash'], 'absorbed rows retain their tool-name in call order')

  // Summary shows `<first> +N` with the total-N excluding the outer.
  const summary = directSummary(outer)
  const nameEl = directChild(summary, c => c.className && c.className.includes('tool-family-name'))
  assert.ok(nameEl && nameEl.textContent === 'read +2',
    'summary tool-name reads "<first> +N" — got ' + (nameEl && nameEl.textContent))
})

test('fused: text-only step (no tool/call) still emits a standalone trace-card', async () => {
  // Guardrail: the fusion path is opt-in — a step without any tool/call
  // must retain the historical trailing .trace-card so text-only reasoning
  // remains reachable via the turn-footer drawer.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-txt', { title: 't', header: {} })
  await renderer.selectSession('s-txt')
  const events = [
    { seq: 1, time: 1000, type: 'turn/start', data: {} },
    { seq: 2, time: 1005, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 3, time: 1050, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'a plain response' }],
      usage: { inputTokens: 5, outputTokens: 2 },
    } },
    { seq: 4, time: 1080, type: 'step/end', data: {} },
    { seq: 5, time: 1085, type: 'turn/end', data: { reason: 'completed' } },
  ]
  playStream(renderer, 's-txt', events)

  const fused = document.querySelectorAll('.tool-block.trace-card-fused')
  assert.equal(fused.length, 0, 'no fused card without a tool/call')
  // The standalone trace-card gets lifted into the turn drawer at turn/end.
  // Look at the drawer for its presence.
  const drawer = document.querySelector('.turn-trace-drawer')
  assert.ok(drawer, 'text-only step still emits a trailing trace-card lifted into the drawer')
})

// Glyph fallback contract: a turn whose only trace lives as a fused
// tool-block (no trailing drawer built) MUST still respond to the
// turn-flow-glyph's `dsh-open-turn-trace` event — open the fused card
// + scroll it into view + briefly ring it with `.flash-ring` so the
// reader tracks the jump. Without this the glyph would be a silent
// no-op on tool-only turns.
test('fused: glyph fallback opens + scrolls to + flash-rings the fused card when no drawer exists', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-glyph', { title: 't', header: {} })
  await renderer.selectSession('s-glyph')
  playStream(renderer, 's-glyph', makeSingleToolTurn())

  // Sanity: drawer suppressed, fused card present, footer built.
  assert.equal(document.querySelectorAll('.turn-trace-drawer').length, 0,
    'precondition: no drawer built for fused-only turn')
  const footer = document.querySelector('.turn-footer')
  assert.ok(footer, 'turn footer built')
  const fused = document.querySelector('.tool-block.trace-card-fused')
  assert.ok(fused, 'fused card exists')

  // Track scroll invocation on the fused card so we can assert the
  // fallback actually reached the scroll step.
  let scrolled = 0
  fused.scrollIntoView = function () { scrolled += 1 }
  fused.open = false

  // Fire the glyph's event through the harness's listener hook.
  assert.equal(typeof footer._fire, 'function',
    'harness footer exposes _fire for synthetic event dispatch')
  footer._fire('dsh-open-turn-trace', {})

  assert.equal(fused.open, true, 'fused card opened by fallback')
  assert.equal(scrolled, 1, 'fallback scrolled the fused card into view')
  assert.ok(fused.classList.contains('flash-ring'),
    'fallback applied .flash-ring accent for 2s visual cue')
})

// Twin of the above: when a text-only step already built a drawer,
// the fallback path must NOT fire — the historical drawer-open path
// remains authoritative. Guards against a regression where both
// listeners run and the fused-selector accidentally matches something.
test('fused: text-only turn keeps the drawer path — no flash-ring on the stream', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-txt2', { title: 't', header: {} })
  await renderer.selectSession('s-txt2')
  playStream(renderer, 's-txt2', [
    { seq: 1, time: 1000, type: 'turn/start', data: {} },
    { seq: 2, time: 1005, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 3, time: 1050, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'a plain response' }],
      usage: { inputTokens: 5, outputTokens: 2 },
    } },
    { seq: 4, time: 1080, type: 'step/end', data: {} },
    { seq: 5, time: 1085, type: 'turn/end', data: { reason: 'completed' } },
  ])
  const footer = document.querySelector('.turn-footer')
  const drawer = document.querySelector('.turn-trace-drawer')
  assert.ok(footer && drawer, 'precondition: drawer path in play')
  drawer.open = false
  footer._fire('dsh-open-turn-trace', {})
  assert.equal(drawer.open, true, 'drawer opened by drawer path')
  // No fused card to ring — the accent class must not be applied
  // anywhere in the tree.
  const ringed = document.querySelectorAll('.flash-ring')
  assert.equal(ringed.length, 0, 'flash-ring not applied on drawer-path turn')
})
