// reference tracing UI-study §6 rec 1/2/4/7 + density-spec §2/§4 conformance smoke test.
// Covers the visual additions #159 + trace-event-row density work land:
//   - trace-event-row carries a monochrome type glyph (rec 2)
//   - trace-event-row carries a duration bar sized against step baseline (rec 1)
//   - trace-event-row carries a 2px-edge run-type class (rec 7)
//   - trace-event-row summary has a `{ }` raw-JSON badge to reach L2 directly
//     without opening L1 (density-spec §4)
//   - step start emits a streaming placeholder, replaced on step/end (rec 4)
//   - request/header L1 renders tools list as flat rows with `{ }` badges
//     (density-spec §2 rule "L1 never nests L1")
//   - L2 payload block carries a copy affordance (density-spec §2.3)

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { loadRenderer } = require('./renderer-harness.js')

function playStream(renderer, sid, events) {
  for (const ev of events) renderer.onSessionEvent(sid, ev)
}

// Minimal 3-step-event stream: step/start → assistant/message → step/end.
// startTime=1000, endTime=1120 so `evt.time=1060` sits at 50% of the bar.
function makeVisualStream() {
  return [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1060, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 10, outputTokens: 3 },
    } },
    { seq: 3, time: 1120, type: 'step/end', data: {} },
  ]
}

test('trace-event-row emits monochrome type glyph (no color emoji)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-viz', { title: 't', header: {} })
  await renderer.selectSession('s-viz')
  playStream(renderer, 's-viz', makeVisualStream())

  const rows = document.querySelectorAll('.trace-event-row')
  assert.ok(rows.length >= 1, 'at least one trace event row')
  let sawGlyph = false
  for (const r of rows) {
    const g = r.querySelector('.trace-event-glyph')
    if (g && typeof g.textContent === 'string' && g.textContent.length > 0) {
      sawGlyph = true
      // Emoji ban: reject any glyph that's a color emoji (surrogate pair or in
      // the emoji block). Typographic characters (`*.>` etc.) are allowed.
      const first = g.textContent.codePointAt(0)
      assert.ok(first < 0x2000 || (first >= 0x2010 && first < 0x2100),
        `glyph "${g.textContent}" (U+${first.toString(16)}) must be typographic, not emoji`)
    }
  }
  assert.ok(sawGlyph, 'trace-event-row got at least one glyph populated')
})

test('trace-event-row carries a duration bar sized against step baseline', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-bar', { title: 't', header: {} })
  await renderer.selectSession('s-bar')
  playStream(renderer, 's-bar', makeVisualStream())

  // The middle assistant/message row (evt.time=1060) sits at 50% of the
  // step's duration (60/120). Bar width is expressed as a "50.0%" style
  // string; we accept anything in the 40-60% window to leave rounding room.
  const bars = document.querySelectorAll('.trace-event-bar')
  assert.ok(bars.length >= 1, 'at least one bar rendered')
  let sawMidBar = false
  for (const b of bars) {
    const w = String(b.style && b.style.width || '')
    if (!w) continue
    const n = parseFloat(w)
    if (Number.isFinite(n) && n >= 40 && n <= 60) sawMidBar = true
  }
  assert.ok(sawMidBar, `expected a bar width ~50%, got: ${Array.from(bars).map((b) => b.style.width).join(', ')}`)
})

test('trace-event-row has 2px run-type edge class', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-edge', { title: 't', header: {} })
  await renderer.selectSession('s-edge')
  playStream(renderer, 's-edge', makeVisualStream())

  // assistant/message row should carry trace-event-row-assistant.
  const rows = document.querySelectorAll('.trace-event-row')
  let sawAssistantEdge = false
  for (const r of rows) {
    if (r.classList && r.classList.contains('trace-event-row-assistant')) {
      sawAssistantEdge = true; break
    }
  }
  assert.ok(sawAssistantEdge, 'assistant/message row got trace-event-row-assistant class')
})

test('trace-event-row summary hosts the raw-JSON drawer badge (L2 reachable without opening L1)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-raw', { title: 't', header: {} })
  await renderer.selectSession('s-raw')
  playStream(renderer, 's-raw', makeVisualStream())

  // Density-spec §4: `{ }` reachable at L0 on every row.
  const badges = document.querySelectorAll('.trace-event-raw-badge')
  assert.ok(badges.length >= 1, 'at least one raw-JSON badge on a trace-event-row')
})

test('trace-event-payload embeds an L2 head + copy button', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-copy', { title: 't', header: {} })
  await renderer.selectSession('s-copy')
  playStream(renderer, 's-copy', makeVisualStream())

  const heads = document.querySelectorAll('.trace-event-l2-head')
  assert.ok(heads.length >= 1, 'L2 head strip present on every payload')
  const copies = document.querySelectorAll('.trace-event-copy')
  assert.ok(copies.length >= 1, 'copy button reachable inside every L2 head')
})

test('streaming placeholder appears on step/start, removed on step/end', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-stream', { title: 't', header: {} })
  await renderer.selectSession('s-stream')

  // Play only step/start — the placeholder should be alone in the stream.
  renderer.onSessionEvent('s-stream', { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } })
  let placeholders = document.querySelectorAll('.trace-card-streaming')
  assert.equal(placeholders.length, 1, 'streaming placeholder rendered on step/start')

  // Now play step/end — placeholder replaced by the final trace-card.
  renderer.onSessionEvent('s-stream', { seq: 2, time: 1120, type: 'step/end', data: {} })
  placeholders = document.querySelectorAll('.trace-card-streaming')
  assert.equal(placeholders.length, 0, 'placeholder removed on step/end')
  const finals = document.querySelectorAll('.trace-card:not(.trace-card-streaming)')
  assert.equal(finals.length, 1, 'exactly one final trace-card rendered')
})

test('request/header L1 tools list is flat rows with `{ }` drawer badges (no L1-in-L1 <details>)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-h', { title: 't', header: {} })
  await renderer.selectSession('s-h')

  const events = [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'request/header', data: {
      header: {
        system: 'You are Claude Fable 5, an agent-loop model.',
        tools: [
          { name: 'bash', description: 'run a shell command', parameters: { type: 'object' } },
          { name: 'read', description: 'read a file',        parameters: { type: 'object' } },
        ],
        messagePrefix: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      },
      reason: 'step-start',
    } },
    { seq: 3, time: 1120, type: 'step/end', data: {} },
  ]
  playStream(renderer, 's-h', events)

  const toolRows = document.querySelectorAll('.trace-header-tool')
  assert.equal(toolRows.length, 2, 'both tools rendered as flat rows')
  // Each tool row must be a DIV, not a DETAILS (no L1-in-L1 nested details).
  for (const r of toolRows) {
    assert.notEqual(r.tagName, 'DETAILS', 'tool row is a flat div, not <details>')
    const badge = r.querySelector('.trace-header-l1-badge')
    assert.ok(badge, 'each tool row exposes a `{ }` drawer badge')
  }
})

test('tool-block summary is LangSmith row-form (glyph + name + arg gist, no orange mono heading)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-tool', { title: 't', header: {} })
  await renderer.selectSession('s-tool')

  renderer.onSessionEvent('s-tool', {
    seq: 1, time: 1000, type: 'tool/call',
    data: { callId: 'c1', name: 'bash', arguments: { command: 'echo hello world' } },
  })

  const blocks = document.querySelectorAll('.tool-block')
  assert.equal(blocks.length, 1, 'exactly one tool-block rendered')
  const b = blocks[0]
  const glyph = b.querySelector('.tool-family-icon')
  const name = b.querySelector('.tool-family-name')
  const gist = b.querySelector('.tool-arg-gist')
  assert.ok(glyph, 'family glyph present')
  assert.ok(name, 'family name present')
  assert.equal(name.textContent, 'bash', 'name column shows plain tool name (no "family: name" prefix)')
  assert.ok(gist, 'arg-gist column present')
  assert.equal(gist.textContent, 'echo hello world', 'arg gist reads the bash command')
})

// ─── 2026-07-17 reference tracing UI live-run delta batch (205-Δ3/205-Δ4) ───────────

test('205-Δ3: assistant/message row carries a model chip when the step knows a model', async () => {
  // reference tracing UI renders `ChatOpenAI deepseek-chat` on every LLM span. We
  // ship the model name alone (event.type carries the "kind" already).
  // The step's request/header ships `header.model`; the chip must pick
  // that up and render on the assistant/message row without fabricating
  // anything when the model is absent.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-model', { title: 't', header: {} })
  await renderer.selectSession('s-model')
  playStream(renderer, 's-model', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'request/header', data: {
      header: { model: 'deepseek-chat', system: 's', tools: [] }, reason: 'step-start',
    } },
    { seq: 3, time: 1060, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }],
      usage: { inputTokens: 10, outputTokens: 3 },
    } },
    { seq: 4, time: 1120, type: 'step/end', data: {} },
  ])
  const rows = document.querySelectorAll('.trace-event-row-assistant')
  assert.ok(rows.length >= 1, 'at least one assistant/message row')
  let sawChip = false
  for (const r of rows) {
    const chip = r.querySelector('.trace-event-model')
    if (chip && String(chip.textContent).trim() === 'deepseek-chat') { sawChip = true; break }
  }
  assert.ok(sawChip, 'assistant/message row carries a `.trace-event-model` chip = deepseek-chat')
})

test('205-Δ3: model chip is absent when the step ships no model (zero-fabrication)', async () => {
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-nomodel', { title: 't', header: {} })
  await renderer.selectSession('s-nomodel')
  playStream(renderer, 's-nomodel', makeVisualStream()) // no request/header → no model
  // NB: harness selector matcher only supports a single compound (no
  // descendant combinator), so query the chip class directly.
  const chips = document.querySelectorAll('.trace-event-model')
  assert.equal(chips.length, 0, 'no model chip when the wire never ships one')
})

test('205-Δ4: token badge renders as a pill with "tok" suffix', async () => {
  // Latency + token pills read as a two-pill row. The bare "60" from the
  // pre-delta patch reads as a bar-position number; append " tok" so the
  // pill is self-describing (reference tracing UI parity).
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-tok', { title: 't', header: {} })
  await renderer.selectSession('s-tok')
  playStream(renderer, 's-tok', makeVisualStream())
  const badges = document.querySelectorAll('.trace-event-token-badge')
  assert.ok(badges.length >= 1, 'at least one token badge on an assistant/message row')
  let sawSuffix = false
  for (const b of badges) {
    if (/\btok\b/.test(String(b.textContent))) { sawSuffix = true; break }
  }
  assert.ok(sawSuffix, 'token badge text ends with "tok" (pill-style label)')
})

test('205-Δ4: descendant rows carry a duration pill (LangSmith per-row latency)', async () => {
  // Every event row that has a computable duration ships a
  // `.trace-event-duration` pill — not only the root/step-level. The
  // simplest hit is a paired tool/call ↔ tool/result: the call row's
  // pill reads the span (result.time - call.time) in ms/s.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-dur', { title: 't', header: {} })
  await renderer.selectSession('s-dur')
  playStream(renderer, 's-dur', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: { command: 'ls' } } },
    { seq: 3, time: 1330, type: 'tool/result',
      data: { callId: 'c1', ok: true, output: 'a b c' } },
    { seq: 4, time: 1400, type: 'step/end', data: {} },
  ])
  const pills = document.querySelectorAll('.trace-event-duration')
  assert.ok(pills.length >= 1, 'tool/call row exposes a duration pill')
  // Expected span is 320ms → "320ms" text (sub-second rule).
  const texts = Array.from(pills).map(p => String(p.textContent).trim())
  assert.ok(texts.some(t => t === '320ms'),
    `duration pill reads "320ms" for the 1010→1330 tool span; got: ${texts.join(', ')}`)
})

test('trace-parity: token pill hover shows a multi-line breakdown tooltip', async () => {
  // reference tracing UI round-6 shot 06 hover reveals a three-row Input/Output/cache-
  // read breakdown on the LLM leaf. Our equivalent is a native `title` on
  // the token pill: one line per USAGE_KEYS field, absent fields as `—`
  // (§7 zero-discard). Any tooltip library would fight the desktop
  // browser's rendering — native title is the right primitive.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-tooltip', { title: 't', header: {} })
  await renderer.selectSession('s-tooltip')
  playStream(renderer, 's-tooltip', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1060, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }],
      // Ships input+output+cache-read; cache-write + reasoning are omitted
      // on the wire → tooltip must render them as `—` (not skip them).
      usage: { inputTokens: 50, outputTokens: 12, cacheReadTokens: 8 },
    } },
    { seq: 3, time: 1120, type: 'step/end', data: {} },
  ])
  const badges = document.querySelectorAll('.trace-event-token-badge')
  assert.ok(badges.length >= 1, 'token badge present on assistant/message row')
  const title = String(badges[0].title || '')
  assert.ok(title.includes('\n'), 'tooltip is multi-line (breakdown table)')
  assert.ok(/input\s*=\s*50/.test(title),   'tooltip lists input tokens')
  assert.ok(/output\s*=\s*12/.test(title),  'tooltip lists output tokens')
  assert.ok(/cache-read\s*=\s*8/.test(title), 'tooltip lists cache-read tokens')
  assert.ok(/cache-write\s*=\s*—/.test(title),
    'absent cache-write renders as em-dash (zero-drop rule)')
  assert.ok(/reasoning\s*=\s*—/.test(title),
    'absent reasoning renders as em-dash (zero-drop rule)')
})

test('trace-parity: request/header row exposes an "Edit & re-run" chip', async () => {
  // Task 3 (trace-parity batch): the LLM-leaf equivalent gets a row-level
  // "Edit & re-run" trigger — hover-revealed, chip-tier, delegates click
  // to the existing edit-rerun-header widget in the L1 payload (#168).
  // Tool rows keep their pre-existing trigger; this test covers the
  // request/header (LLM step) branch.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-rerun', { title: 't', header: {} })
  await renderer.selectSession('s-rerun')
  playStream(renderer, 's-rerun', [
    { seq: 1, time: 1000, type: 'step/start', data: { turn: 0, step: 0 } },
    { seq: 2, time: 1010, type: 'request/header', data: {
      header: { model: 'deepseek-v4', provider: 'deepseek',
        config: { temperature: 0.7, topP: 0.9, maxTokens: 4096 } },
    } },
    { seq: 3, time: 1050, type: 'assistant/message', data: {
      content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 5, outputTokens: 2 },
    } },
    { seq: 4, time: 1120, type: 'step/end', data: {} },
  ])
  const chips = document.querySelectorAll('.trace-event-rerun-chip')
  assert.ok(chips.length >= 1,
    'request/header row must expose one .trace-event-rerun-chip')
  const chip = chips[0]
  assert.strictEqual(String(chip.textContent).trim(), 'Edit & re-run',
    'chip label matches LangSmith Playground-style entrypoint')
  assert.strictEqual(chip.tagName, 'BUTTON', 'chip is a real button, not a span')
})

test('trace-card summary carries a right-side subtree-fold ∨ glyph (spec §7)', async () => {
  // Task #38 (density-layering-spec §7 positive-reference lock):
  // "Tree rows fold their subtree via a right-side ∨ on parent rows."
  // Every rendered trace-card must expose the affordance; clicking it
  // toggles the parent `<details>` open state.
  const { renderer, document } = await loadRenderer()
  renderer.ensureSession('s-fold', { title: 't', header: {} })
  await renderer.selectSession('s-fold')
  playStream(renderer, 's-fold', makeVisualStream())

  const cards = document.querySelectorAll('.trace-card:not(.trace-card-streaming)')
  assert.ok(cards.length >= 1, 'at least one final trace-card')
  const card = cards[0]
  const glyph = card.querySelector('.trace-card-fold-glyph')
  assert.ok(glyph, 'right-side fold glyph rendered on the summary')
  assert.strictEqual(glyph.textContent, '∨', 'glyph is the typographic ∨')
  assert.strictEqual(glyph.getAttribute('aria-hidden'), 'true',
    'purely decorative — screen readers rely on <details> semantics')
  // Right-side: appears after .trace-duration in the summary flex row.
  const summary = card.querySelector('summary')
  const kids = Array.from(summary.children)
  const glyphIdx = kids.indexOf(glyph)
  const durIdx = kids.findIndex((c) => c.classList && c.classList.contains('trace-duration'))
  assert.ok(glyphIdx > durIdx, 'fold glyph sits after the duration chip (right side)')
  // Click toggles `.open`.
  const startOpen = card.open
  glyph.click()
  assert.notStrictEqual(card.open, startOpen, 'click toggled details.open')
})
