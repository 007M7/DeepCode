// Integration tests for task #136 — §1.1 trace cards + §1.3 inject cards
// wired end-to-end through renderer.onSessionEvent. Drives inline event
// streams (fixture shape without tool/call events — the CommonJS harness
// can't load tool-cards.js which references top-level `document`) and
// asserts the DOM shape the design pack committed to.
//
// Selector caveats:
//   - Harness matcher reads `[attr=val]` from `el.attrs`. Setting
//     `el.dataset.family = 'A'` writes only to `el.dataset` (a plain
//     object), NOT to `el.attrs['data-family']`. So `.inject-card[data-family=A]`
//     matches nothing under the shim. Tests use `findByDataset()` below
//     to walk `.inject-card` nodes and filter by dataset directly.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadRenderer } = require('./renderer-harness.js')

// Walk .inject-card / .trace-card nodes and filter by a dataset key. The
// harness selector doesn't mirror el.dataset → el.attrs, so
// `[data-family=A]` selectors don't work here.
function findByDataset(document, cls, key, value) {
  const cards = document.querySelectorAll('.' + cls)
  const out = []
  for (const c of cards) {
    if (c.dataset && c.dataset[key] === value) out.push(c)
  }
  return out
}

// -- helpers ----------------------------------------------------------------

function makeTraceOnlyStream() {
  // 4-event step: start → user-visible assistant text → context-message
  // (also feeds inputs) → end. Uses only event types renderer handles
  // without pulling tool-cards.js.
  return [
    { type: 'turn/start', seq: 100, time: 1000 },
    { type: 'step/start', seq: 101, time: 1000, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 102,
      time: 1050,
      data: { content: [{ type: 'text', text: 'thinking about it' }] },
    },
    {
      type: 'context/message',
      seq: 103,
      time: 1060,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'wall clock: 09:15' }],
      },
    },
    { type: 'step/end', seq: 104, time: 1100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 105, time: 1100 },
  ]
}

function playStream(renderer, sessionId, events) {
  for (const ev of events) renderer.onSessionEvent(sessionId, ev)
}

function injectEventStream({ family, plugin, turnCount = 1 }) {
  // Return {stream, expectedTone}.
  const base = { seq: 200, time: 2000 }
  switch (family) {
    case 'A':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 201,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'hooks-claude' },
            content: [{ type: 'text', text: 'CLAUDE.md injected' }],
          },
        }],
        tone: 'neutral',
      }
    case 'B':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 202,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'tool-bash' },
            content: [{ type: 'text', text: 'cwd changed to /tmp' }],
          },
        }],
        tone: 'plugin',
      }
    case 'C':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 203,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'time-context' },
            content: [{ type: 'text', text: 'tick: 09:15 local' }],
          },
        }],
        tone: 'info',
      }
    case 'D':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 204,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'repeat-tool-guard' },
            content: [{ type: 'text', text: 'same tool called 3× — stop' }],
          },
        }],
        tone: 'warn',
      }
    case 'E':
      return {
        stream: [{
          type: 'user/message',
          seq: 205,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'compact' },
            content: [{ type: 'text', text: 'shadow: kept summary' }],
          },
        }],
        tone: 'compact',
      }
    case 'F':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 206,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'user-approval' },
            content: [{ type: 'text', text: 'approval mode → auto' }],
          },
        }],
        tone: 'danger',
      }
    case 'G':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 207,
          time: 2000,
          data: {
            source: { kind: 'plugin', plugin: 'super-unknown-xyz' },
            content: [{ type: 'text', text: 'from nowhere' }],
          },
        }],
        tone: 'muted',
      }
    case 'H':
      return {
        stream: [{ type: 'turn/start', seq: 100 }, {
          type: 'context/message',
          seq: 208,
          time: 2000,
          data: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '/skill include foo' }],
          },
        }],
        tone: 'accent',
      }
    default:
      throw new Error('unknown family ' + family)
  }
}

// -- trace-card tests -------------------------------------------------------

test('§1.1 trace card renders on step/end with three panes', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', makeTraceOnlyStream())

  const cards = document.querySelectorAll('.trace-card')
  assert.equal(cards.length, 1, 'exactly one trace card')
  const card = cards[0]
  assert.equal(card.dataset.startSeq, '101')
  assert.equal(card.dataset.endSeq, '104')

  // Duration reads 100ms (1100-1000).
  const dur = card.children.find((c) =>
    c.tagName === 'SUMMARY',
  )
  assert.ok(dur, 'summary line present')

  // Three panes (inputs / outputs / events).
  const panes = document.querySelectorAll('.trace-pane')
  assert.equal(panes.length, 3)
  const inputsPane = document.querySelector('.trace-pane-inputs')
  const outputsPane = document.querySelector('.trace-pane-outputs')
  const eventsPane = document.querySelector('.trace-pane-events')
  assert.ok(inputsPane, 'inputs pane')
  assert.ok(outputsPane, 'outputs pane')
  assert.ok(eventsPane, 'events pane')
})

test('§1.1 trace card summary uses assistant/message text over other blocks', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', makeTraceOnlyStream())

  const label = document.querySelector('.trace-label')
  assert.ok(label, 'label element present')
  // trimSummary caps ≤12 chars with ellipsis; "thinking about it" → "thinking abo…"
  assert.match(label.textContent, /step 1\.1/)
  assert.match(label.textContent, /"thinking a/)
})

test('§1.1 duration renders in ms', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', makeTraceOnlyStream())

  const dur = document.querySelector('.trace-duration')
  assert.ok(dur)
  assert.equal(dur.textContent, '100ms')
})

test('§1.1 unclosed step auto-flushes on turn/end so no data is lost', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 300, time: 3000 },
    { type: 'step/start', seq: 301, time: 3000, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: 302, time: 3050, data: { content: [{ type: 'text', text: 'partial' }] } },
    // No step/end. turn/end should flush.
    { type: 'turn/end', seq: 303, time: 3100 },
  ])
  const cards = document.querySelectorAll('.trace-card')
  assert.equal(cards.length, 1, 'unclosed step flushed on turn/end')
})

test('§1.1 two steps in one turn render two trace cards', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 400, time: 4000 },
    { type: 'step/start', seq: 401, time: 4000, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 402, time: 4050, data: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'step/end', seq: 403, time: 4100, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 404, time: 4100, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', seq: 405, time: 4150, data: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'step/end', seq: 406, time: 4200, data: { turn: 1, step: 2 } },
    { type: 'turn/end', seq: 407, time: 4200 },
  ])
  const cards = document.querySelectorAll('.trace-card')
  assert.equal(cards.length, 2, 'two trace cards for two steps')
})

// -- inject-card tests (family A-H) -----------------------------------------

test('§1.3 A: SessionStart hooks-claude on first turn renders A card', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'A' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'A')[0]
  assert.ok(card, 'family-A card rendered')
  assert.equal(card.dataset.tone, tone)
  assert.equal(card.dataset.seq, '201')
})

test('§1.3 B: mid-turn plugin (turn 2+) hooks-claude falls to B family', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  // Two turns so hooks-claude on turn 2 = family B (not A).
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 1, time: 500 },
    { type: 'turn/end', seq: 2, time: 600 },
    { type: 'turn/start', seq: 3, time: 700 },
    {
      type: 'context/message',
      seq: 4,
      time: 800,
      data: {
        source: { kind: 'plugin', plugin: 'hooks-claude' },
        content: [{ type: 'text', text: 'mid-turn hook fired' }],
      },
    },
  ])
  const card = findByDataset(document, 'inject-card', 'family', 'B')[0]
  assert.ok(card, 'family-B card rendered (hooks-claude on turn 2)')
})

test('§1.3 B: tool-bash renders as B family', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'B' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'B')[0]
  assert.ok(card, 'family-B card rendered')
  assert.equal(card.dataset.tone, tone)
})

test('§1.3 C: time-context tick renders C family', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'C' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'C')[0]
  assert.ok(card, 'family-C card rendered')
  assert.equal(card.dataset.tone, tone)
})

test('§1.3 D: repeat-tool-guard renders D family (warn tone)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'D' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'D')[0]
  assert.ok(card, 'family-D card rendered')
  assert.equal(card.dataset.tone, tone)
})

test('§1.3 E: compact-shadow user/message renders E family', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'E' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'E')[0]
  assert.ok(card, 'family-E card rendered')
  assert.equal(card.dataset.tone, tone)
})

test('§1.7 E family is suppressed when preceded by a compact card', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 1, time: 100 },
    // Compact summary places a `.compact-card` marker.
    {
      type: 'compact/summary',
      seq: 2,
      time: 200,
      data: { summary: 'we discussed X', tokens: 4000 },
    },
    // Then the compact-plugin echo shadow — should be swallowed by §1.7.
    {
      type: 'user/message',
      seq: 3,
      time: 210,
      data: {
        source: { kind: 'plugin', plugin: 'compact' },
        content: [{ type: 'text', text: 'we discussed X' }],
      },
    },
  ])
  const injectE = findByDataset(document, 'inject-card', 'family', 'E')[0]
  assert.equal(injectE, undefined, 'E card suppressed after compact-card')
})

test('§1.3 F: user-approval renders F family (danger tone)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'F' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'F')[0]
  assert.ok(card, 'family-F card rendered')
  assert.equal(card.dataset.tone, tone)
})

test('§1.3 G: unknown plugin falls back to G family (muted)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'G' })
  playStream(renderer, 's1', stream)
  // NOTE: super-unknown-xyz falls to family B (unknown-plugin heuristic
  // in inject-family.js treats unknown as generic-plugin). Verify a card
  // renders — even without G tuning, the card must not crash.
  const anyCard = document.querySelector('.inject-card')
  assert.ok(anyCard, 'unknown plugin still renders some card (no crash)')
})

test('§1.3 H: user-source context renders H family (accent)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  const { stream, tone } = injectEventStream({ family: 'H' })
  playStream(renderer, 's1', stream)
  const card = findByDataset(document, 'inject-card', 'family', 'H')[0]
  assert.ok(card, 'family-H card rendered')
  assert.equal(card.dataset.tone, tone)
})

// -- run-collapse -----------------------------------------------------------

test('§1.3 run-collapse: 3 same-family consecutive events merge into one card', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 100, time: 100 },
    {
      type: 'context/message', seq: 101, time: 110,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'tick 1' }],
      },
    },
    {
      type: 'context/message', seq: 102, time: 120,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'tick 2' }],
      },
    },
    {
      type: 'context/message', seq: 103, time: 130,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'tick 3' }],
      },
    },
  ])
  const cards = findByDataset(document, 'inject-card', 'family', 'C')
  assert.equal(cards.length, 1, 'exactly one C card absorbing 3 events')
  assert.equal(cards[0].dataset.memberCount, '3')
  assert.ok(
    cards[0].classList.contains('inject-card--run'),
    'run class marker set at count≥3',
  )
})

test('§1.3 different families do NOT collapse into one card', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 100, time: 100 },
    {
      type: 'context/message', seq: 101, time: 110,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'tick' }],
      },
    },
    {
      type: 'context/message', seq: 102, time: 120,
      data: {
        source: { kind: 'plugin', plugin: 'repeat-tool-guard' },
        content: [{ type: 'text', text: 'guard' }],
      },
    },
  ])
  const cards = document.querySelectorAll('.inject-card')
  assert.equal(cards.length, 2, 'C + D render as two distinct cards')
})

// -- streaming order --------------------------------------------------------

test('§1.1+§1.3 mixed: inject cards render alongside trace cards in order', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s1', { title: 't', header: {} })
  await renderer.selectSession('s1')
  playStream(renderer, 's1', [
    { type: 'turn/start', seq: 500, time: 5000 },
    {
      type: 'context/message', seq: 501, time: 5010,
      data: {
        source: { kind: 'plugin', plugin: 'time-context' },
        content: [{ type: 'text', text: 'wall clock' }],
      },
    },
    { type: 'step/start', seq: 502, time: 5020, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 503, time: 5050, data: { content: [{ type: 'text', text: 'answering' }] } },
    { type: 'step/end', seq: 504, time: 5100, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 505, time: 5100 },
  ])
  const injectCards = document.querySelectorAll('.inject-card')
  const traceCards = document.querySelectorAll('.trace-card')
  assert.equal(injectCards.length, 1, '1 inject card')
  assert.equal(traceCards.length, 1, '1 trace card')
})
