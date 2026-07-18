// assistant-turn.js — the pi-style "assistant turn container" (#162 rec
// 22-bis, + §2.3-bis). One <section> per
// assistant turn holding, in wire order, its reasoning blocks, text
// bodies, tool call rows, and tool result rows — plus a fixed footer
// row with per-turn model/usage/time/stop (usage fuses tokens+cost per
// LangSmith §9) and the trace drawer disclosure.
//
// This module is pure over any DOM implementation (real document or
// the tiny shim used by the test suite). All streaming/replay logic
// lives on the TurnBuilder class; renderer.js constructs one per
// turn/start (or per first assistant event when no explicit start
// arrives) and routes assistant/chunk, assistant/message, tool/call,
// tool/result, turn/end events through its methods. The renderer's
// existing ensureStreamingBubble is retired inside the container —
// text now lives in a <div class="text-block turn-child"> not a
// .msg.assistant bubble, and the user bubble stays outside the
// container (design-confirm-162.md §1).
//
// Six readability rules (pi §2.3-bis, transcribed into invariants
// asserted by the test suite):
//
//   R1  All turn-children share the same left indent — no per-type
//       stagger. The container is a plain block flow; child variants
//       (reasoning/text/tool-row/tool-result-row) do not push
//       themselves inward or outward.
//
//   R2  Fixed glyph column. Reasoning uses ▸ (open) or ▾ (expanded).
//       Tool rows use ▸ (in-flight) / ✓ (done) / ✗ (error). All glyphs
//       sit in a same-width `<span class="turn-glyph">` so the eye
//       tracks a single vertical rail.
//
//   R3  A tool call row and its result row are adjacent, compact
//       (single-line each, no extra vertical gap between call and
//       result).
//
//   R4  Repeat calls stream in place — a single tool row per call.
//       We never fold or collapse "duplicate calls" mid-stream, per
//       the study: it hides ordinal narration cadence.
//
//   R5  Narration cadence preserved. Text-block > reasoning-block >
//       tool-row appear in the exact wire order they arrived, so a
//       reader reconstructs "assistant thought, then said X, then
//       called write_file, then read result, then said Y" from a
//       linear scan.
//
//   R6  Footer is the sole divider row. No section rules, no headers
//       inside the container. The turn ends visually at its footer
//       and every child before it belongs to the same assistant step.
//
// Public API (all pure over the injected `doc`):
//
//   new TurnBuilder(doc, { turnId, sessionId, index })
//
//   openReasoning({ initialText? }) → { index }
//   appendReasoningDelta({ index, text })
//   sealReasoning({ index })
//
//   openText({ initialText? }) → { index }
//   appendTextDelta({ index, text })
//   sealText({ index, finalText? })
//
//   openToolRow({ callId, name, argumentsDelta?, argumentsSealed? }) → { callId }
//   updateToolRow({ callId, argumentsDelta })      — appends to buffer
//   sealToolRow({ callId, argumentsSealed })       — freezes call args
//   openToolResultRow({ callId, ok, summary?, durationMs?, meta? })
//
//   finishTurn({ footerSpec, traceDrawerEl? })     — appends footer
//   element()                                      — the <section>
//
//   isSealed()                                     — after finishTurn
//
// TurnBuilder does NOT know about specific tool card families. When
// the renderer needs the fancy per-family tool card (diff, terminal),
// it calls the tool-cards module to build the argument/summary body
// and hands the node to openToolRow via the `bodyEl` option. That
// keeps this module free of family knowledge and lets the tool card
// suite continue to own its own visuals.

'use strict'

const REASONING = 'reasoning-block'
const TEXT = 'text-block'
const TOOL_ROW = 'tool-row'
const TOOL_RESULT_ROW = 'tool-result-row'

class TurnBuilder {
  constructor(doc, opts) {
    if (!doc) throw new Error('TurnBuilder needs a document-like `doc`')
    const options = opts || {}
    this.doc = doc
    this.turnId = options.turnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessionId = options.sessionId || ''
    this.index = Number.isFinite(options.index) ? options.index : 0
    this.sealed = false

    // Per-child index tracks (parallel int counters, one per family)
    // so callers can hand back the same index they were given at open.
    this._nextReasoning = 0
    this._nextText = 0
    this._reasoningEls = new Map() // index -> el
    this._textEls = new Map()      // index -> el
    this._toolRows = new Map()     // callId -> { callEl, resultEl }

    this.el = doc.createElement('section')
    this.el.className = 'assistant-turn'
    this.el.dataset.turnId = this.turnId
    this.el.dataset.turnIndex = String(this.index)
    if (this.sessionId) this.el.dataset.sessionId = this.sessionId
    this.el.dataset.turnStatus = 'streaming'

    // A top rule sits above the first child and gives the container a
    // deliberate opening edge without a heading. R6: the footer is the
    // only divider row; this rule is a starting rail, not a divider
    // between siblings.
    const rule = doc.createElement('div')
    rule.className = 'turn-rule'
    rule.setAttribute('aria-hidden', 'true')
    this.el.append(rule)

    this.body = doc.createElement('div')
    this.body.className = 'turn-body'
    this.el.append(this.body)
  }

  element() { return this.el }

  isSealed() { return this.sealed }

  // -- reasoning ---------------------------------------------------------

  openReasoning(opts) {
    if (this.sealed) throw new Error('turn already sealed')
    const options = opts || {}
    const idx = this._nextReasoning++
    const initial = typeof options.initialText === 'string' ? options.initialText : ''
    let el
    // In the browser, the reasoning-block module is on window; under
    // node --test the test wires a plain object. Fall back to a
    // minimal shim so tests can validate composition without loading
    // the full module.
    const mod = _resolveReasoningModule()
    if (mod && typeof mod.buildReasoningBlock === 'function') {
      el = mod.buildReasoningBlock(this.doc, {
        index: idx,
        initialText: initial,
        sealed: false,
        collapsed: true,
      })
    } else {
      el = this.doc.createElement('div')
      el.className = 'turn-child reasoning-block'
      el.dataset.blockIndex = String(idx)
      el.dataset.buffer = initial
      el.dataset.sealed = '0'
      el.dataset.collapsed = '1'
    }
    this._reasoningEls.set(idx, el)
    this.body.append(el)
    return { index: idx }
  }

  appendReasoningDelta(opts) {
    const el = this._reasoningEls.get(opts && opts.index)
    if (!el) return
    const mod = _resolveReasoningModule()
    if (mod && typeof mod.appendReasoningDelta === 'function') {
      mod.appendReasoningDelta(el, opts.text)
      return
    }
    // Fallback for tests without the module: track buffer via dataset.
    if (typeof opts.text === 'string') {
      el.dataset.buffer = (el.dataset.buffer || '') + opts.text
    }
  }

  sealReasoning(opts) {
    const el = this._reasoningEls.get(opts && opts.index)
    if (!el) return
    const mod = _resolveReasoningModule()
    if (mod && typeof mod.sealReasoningBlock === 'function') {
      mod.sealReasoningBlock(el)
      return
    }
    el.dataset.sealed = '1'
  }

  // -- assistant text ----------------------------------------------------

  openText(opts) {
    if (this.sealed) throw new Error('turn already sealed')
    const options = opts || {}
    const idx = this._nextText++
    const el = this.doc.createElement('div')
    el.className = 'turn-child text-block'
    el.dataset.blockIndex = String(idx)
    el.dataset.buffer = typeof options.initialText === 'string' ? options.initialText : ''
    // The text block renders as prose (not a bubble). The bubble
    // shape existed to visually separate assistant from user; inside
    // the turn container the section already does that (the whole
    // container reads as one assistant utterance), and pi keeps text
    // as inline prose. This resolves the #93 tension: reasoning and
    // tool markers no longer leak into the bubble because there is
    // no bubble to leak into.
    el.textContent = el.dataset.buffer
    this._textEls.set(idx, el)
    this.body.append(el)
    return { index: idx }
  }

  appendTextDelta(opts) {
    const el = this._textEls.get(opts && opts.index)
    if (!el || typeof opts.text !== 'string' || opts.text.length === 0) return
    const buffer = (el.dataset.buffer || '') + opts.text
    el.dataset.buffer = buffer
    el.textContent = buffer
  }

  sealText(opts) {
    const el = this._textEls.get(opts && opts.index)
    if (!el) return
    if (typeof opts.finalText === 'string') {
      el.dataset.buffer = opts.finalText
      el.textContent = opts.finalText
    }
    el.dataset.sealed = '1'
  }

  // -- tool rows ---------------------------------------------------------

  openToolRow(opts) {
    if (this.sealed) throw new Error('turn already sealed')
    if (!opts || !opts.callId) return { callId: null }
    if (this._toolRows.has(opts.callId)) return { callId: opts.callId }
    const el = this.doc.createElement('div')
    el.className = 'turn-child tool-row'
    el.dataset.callId = opts.callId
    if (opts.name) el.dataset.toolName = opts.name
    el.dataset.buffer = typeof opts.argumentsDelta === 'string' ? opts.argumentsDelta
      : typeof opts.argumentsSealed === 'string' ? opts.argumentsSealed : ''
    el.dataset.sealed = typeof opts.argumentsSealed === 'string' ? '1' : '0'
    // Row shape: glyph + name(partial-args…). Partial args come from
    // parse-incremental-json — but we don't require that module here;
    // the row keeps a plain single-line preview by default and the
    // renderer feeds a nicer preview via updateToolRow's opts.preview
    // when it has one. R2: fixed-width glyph column.
    const glyph = this.doc.createElement('span')
    glyph.className = 'turn-glyph tool-glyph'
    glyph.textContent = el.dataset.sealed === '1' ? '✓' : '▸'
    const name = this.doc.createElement('span')
    name.className = 'tool-row-name'
    name.textContent = opts.name || ''
    const args = this.doc.createElement('span')
    args.className = 'tool-row-args'
    args.textContent = _previewToolArgs(el.dataset.buffer)
    el.append(glyph, name, args)
    this._toolRows.set(opts.callId, { callEl: el, resultEl: null })
    this.body.append(el)
    return { callId: opts.callId }
  }

  updateToolRow(opts) {
    if (!opts || !opts.callId) return
    const entry = this._toolRows.get(opts.callId)
    if (!entry) return
    const el = entry.callEl
    if (typeof opts.argumentsDelta === 'string' && opts.argumentsDelta.length > 0) {
      el.dataset.buffer = (el.dataset.buffer || '') + opts.argumentsDelta
      const args = el.querySelector('.tool-row-args')
      if (args) args.textContent = _previewToolArgs(el.dataset.buffer)
    }
  }

  sealToolRow(opts) {
    if (!opts || !opts.callId) return
    const entry = this._toolRows.get(opts.callId)
    if (!entry) return
    const el = entry.callEl
    if (typeof opts.argumentsSealed === 'string') el.dataset.buffer = opts.argumentsSealed
    el.dataset.sealed = '1'
    const glyph = el.querySelector('.tool-glyph')
    if (glyph) glyph.textContent = '✓'
    const args = el.querySelector('.tool-row-args')
    if (args) args.textContent = _previewToolArgs(el.dataset.buffer)
  }

  openToolResultRow(opts) {
    if (!opts || !opts.callId) return
    const entry = this._toolRows.get(opts.callId)
    if (!entry) return
    if (entry.resultEl) return
    const el = this.doc.createElement('div')
    el.className = 'turn-child tool-result-row'
    el.dataset.callId = opts.callId
    if (opts.ok === false) el.dataset.error = '1'
    const glyph = this.doc.createElement('span')
    glyph.className = 'turn-glyph tool-result-glyph'
    glyph.textContent = opts.ok === false ? '✗' : '✓'
    const summary = this.doc.createElement('span')
    summary.className = 'tool-result-summary'
    summary.textContent = opts.summary != null ? String(opts.summary) : ''
    const dur = this.doc.createElement('span')
    dur.className = 'tool-result-duration'
    dur.textContent = _formatDuration(opts.durationMs)
    el.append(glyph, summary, dur)
    // R3: result row sits directly after its call row. We append to
    // the container which usually places it there because the call
    // is the most recent tool-row; if intervening non-tool children
    // arrived (reasoning/text), the wire order is still respected —
    // the pi rule "adjacent" is a wire-order guarantee, not a DOM
    // sibling constraint under interleaving. In practice adapter
    // implementations do emit call+result back-to-back.
    this.body.append(el)
    entry.resultEl = el
  }

  // -- footer + finish ---------------------------------------------------

  finishTurn(opts) {
    if (this.sealed) return
    this.sealed = true
    this.el.dataset.turnStatus = 'sealed'
    const options = opts || {}
    const doc = this.doc
    // Zero-data footer suppression (user 2026-07-17 実機 screenshot): if
    // the caller supplied a footerSpec whose fields are all ABSENT
    // sentinels AND there is no trace drawer to expose, don't render a
    // footer at all.  The zero-drop rule keeps every field reachable at
    // L2; the L0 gist row is allowed to omit no-signal turns.  We reuse
    // the turn-footer module's specHasAnySignal helper when present.
    const tfMod = (typeof window !== 'undefined' && window.__dshTurnFooter) || null
    const specSig = tfMod && typeof tfMod.specHasAnySignal === 'function'
      ? tfMod.specHasAnySignal(options.footerSpec)
      : !!options.footerSpec
    if (!options.footerEl && !specSig && !options.traceDrawerEl) return
    const footer = doc.createElement('footer')
    footer.className = 'turn-footer'
    // We do NOT require the turn-footer module here — it's a UI-level
    // enrichment. If the renderer passes a pre-built footer element
    // via `footerEl`, use it; otherwise render a plain single-line
    // fallback with any provided spec fields.
    if (options.footerEl) {
      // Adopt the caller's footer node.
      footer.append(options.footerEl)
    } else if (options.footerSpec && specSig) {
      const spec = options.footerSpec
      // §9 fused-pill shape: [model, usage, time, stop]. Caller may pass
      // legacy `tokens` and `cost` — combine into `usage` on the fly.
      // 2026-07-18 echo-profile fix: skip chips whose value is a bare
      // ABSENT sentinel — `— · ` fragments read as junk mixed with real
      // metrics.  Keep the field reachable via L1/L2 (zero-drop).
      const fieldOrder = ['model', 'usage', 'time', 'stop']
      const legacyUsage = (spec.tokens || spec.cost)
        ? `${spec.tokens || '—'} / ${spec.cost || '—'}`
        : undefined
      const rawValues = {
        model: spec.model,
        usage: spec.usage || legacyUsage,
        time: spec.time,
        stop: spec.stop,
      }
      const emitted = []
      for (const label of fieldOrder) {
        const v = rawValues[label]
        if (typeof v !== 'string' || v.length === 0) continue
        const stripped = v.replace(/—/g, '').replace(/\$\?/g, '').replace(/[\/\s]/g, '')
        if (stripped.length === 0) continue
        emitted.push({ label, value: v })
      }
      for (let i = 0; i < emitted.length; i++) {
        if (i > 0) {
          const sep = doc.createElement('span')
          sep.className = 'turn-footer-sep'
          sep.textContent = '·'
          footer.append(sep)
        }
        const chip = doc.createElement('span')
        chip.className = `turn-footer-field field-${emitted[i].label}`
        chip.textContent = emitted[i].value
        footer.append(chip)
      }
    }

    // Trace drawer: inline <details> below the footer (team-lead
    // 2026-07-17 ruling §8.1). The renderer supplies the drawer body
    // element; TurnBuilder adds a `<details>` wrapper + summary that
    // reads "trace · N events" so the fold is discoverable.
    if (options.traceDrawerEl) {
      const drawer = doc.createElement('details')
      drawer.className = 'turn-trace-drawer'
      const summary = doc.createElement('summary')
      summary.className = 'turn-trace-drawer-summary'
      summary.textContent = options.traceSummaryText || 'trace'
      // fix/expand-affordance 2026-07-18: user-facing tooltip so the
      // row's clickability is discoverable even before the ▸ marker
      // (added in style.css tail block) is spotted. aria-expanded
      // reflects [open] state via the native `toggle` event — plugin
      // authors have a working reference for accessible disclosures.
      summary.title = 'Click to expand Tree / Timeline / Graph views'
      summary.setAttribute('aria-expanded', 'false')
      drawer.addEventListener('toggle', () => {
        summary.setAttribute('aria-expanded', drawer.open ? 'true' : 'false')
      })
      drawer.append(summary)
      drawer.append(options.traceDrawerEl)
      footer.append(drawer)
    }

    this.el.append(footer)
  }
}

// -- pure helpers exposed for tests ----------------------------------------

function _previewToolArgs(buffer) {
  if (typeof buffer !== 'string' || buffer.length === 0) return '(…)'
  const oneLine = buffer.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= 60) return `(${oneLine})`
  return `(${oneLine.slice(0, 59)}…)`
}

function _formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// -- module resolution ------------------------------------------------------

// In the renderer, reasoning-block is loaded before this file via
// <script>, exposing window.__dshReasoningBlock. In node --test, the
// caller can inject via a global. If neither is present, the fallback
// shim above is used — enough to satisfy the container's structural
// invariants under a bare-DOM test.
function _resolveReasoningModule() {
  if (typeof window !== 'undefined' && window.__dshReasoningBlock) {
    return window.__dshReasoningBlock
  }
  if (typeof globalThis !== 'undefined' && globalThis.__dshReasoningBlock) {
    return globalThis.__dshReasoningBlock
  }
  return null
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TurnBuilder,
    _previewToolArgs,
    _formatDuration,
    // Child kind labels for tests that assert class conventions.
    REASONING, TEXT, TOOL_ROW, TOOL_RESULT_ROW,
  }
}
if (typeof window !== 'undefined') {
  window.__dshAssistantTurn = { TurnBuilder }
}
