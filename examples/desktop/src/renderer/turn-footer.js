// turn-footer.js — per-turn cost/usage terminator row (#162,
// ). One line per assistant turn, rendered
// at the bottom of the turn container:
//
//   <responseModel> · ↑<in>k (<cache>k cached) ↓<out>k / $<cost> · <ttft>ms/<dur>s · <stop>
//
// Every field is a pure projection of AssistantMessage.usage +
// step meta already computed by trace-aggregator.js (ttftMsForStep,
// costForUsage) or the header (responseModel, provider). Absent
// fields render as `—` — the zero-drop rule (density-layering §2.4)
// forbids silent omission; a researcher scanning the footer never
// wonders "did we not get cost, or did the model not report it?".
//
// LangSmith §9 correction (2026-07-17 live verification, screenshot
// docs/design-refs/langsmith-live/01-trace-run-tree-detail.png): the
// root row fuses tokens and cost into ONE pill (`55 / <$0.0001`) —
// we adopt the same shape as a single `usage` field. This saves a
// separator slot and matches the reader's mental model (both are
// "what did this turn cost me" facts about the same LLM call).
//
// Also acts as the disclosure surface for the trace drawer: when the
// TurnBuilder wires the footer, clicking it toggles the L2 raw trace
// card (finishTraceStep's output) that lives immediately below.
//
// Pure export shape:
//
//   formatFooterFields({model, provider, usage, cost, ttftMs, durationMs, stopReason})
//     → Array<{label: string, value: string}>
//
//   buildTurnFooter(doc, spec) → <footer class='turn-footer'>
//     A single row with the fields formatted via formatFooterFields.

'use strict'

const ABSENT = '—'

function isFiniteNumber(n) { return typeof n === 'number' && Number.isFinite(n) }

function fmtTokens(n) {
  if (!isFiniteNumber(n)) return ABSENT
  if (n < 1000) return String(Math.round(n))
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

function fmtCost(total) {
  if (!isFiniteNumber(total)) return '$?'
  // pi renders every cost with 4 decimals — one format for every
  // magnitude means the reader never has to reparse alignment when a
  // small $0.0042 turn shows up next to a large $1.23 turn. Zero
  // renders as $0.0000, which is legible and honest (a cache-only turn
  // costs zero, and hiding it as $0.00 would falsely suggest "no
  // data").
  return `$${total.toFixed(4)}`
}

// Renamed from `fmtDuration` — workflow-view.js exports a top-level
// `function fmtDuration` too, and the renderer-collisions test bans
// silent overwrites between non-IIFE modules. Same idea; different
// scope. `fmtDurationMs` is unique across the whole renderer surface.
function fmtDurationMs(ms) {
  if (!isFiniteNumber(ms) || ms <= 0) return ABSENT
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtTtft(ms) {
  if (!isFiniteNumber(ms) || ms <= 0) return ABSENT
  return `${Math.round(ms)}ms`
}

function fmtStopReason(reason) {
  if (reason == null) return ABSENT
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    if (typeof reason.kind === 'string') return reason.kind
  }
  return ABSENT
}

function fmtProviderModel(provider, model) {
  const p = typeof provider === 'string' && provider ? provider : null
  const m = typeof model === 'string' && model ? model : null
  if (p && m) return `${p} · ${m}`
  return m || p || ABSENT
}

/**
 * Does a footer spec carry ANY concrete metric worth rendering? Returns
 * `false` for the all-absent shape (model/usage/cost/time/stop all
 * missing) so the caller can skip mounting the terminator row entirely
 * — the zero-drop rule guarantees each field is reachable at L2, but
 * "no data" turns should not paint `— · — / $? · — · —` in the stream
 * (user 2026-07-17 zero-data footer screenshot).
 *
 * Cost/model chip may still be present even when everything else is
 * absent (e.g. a completed turn that returned no usage) — we render in
 * that case because the model name is real information.
 *
 * @param {object} spec  same shape as formatFooterFields
 * @returns {boolean}
 */
function specHasAnySignal(spec) {
  if (!spec || typeof spec !== 'object') return false
  // Accept both the *raw* shape (as fed into formatFooterFields — usage is
  // an object of counts, cost is `{total}`, times are numbers) AND the
  // *formatted* shape returned by buildTurnFooterSpecFromMeta in the
  // renderer (each field is already an ABSENT-or-string). Callers use both.
  //
  // Formatted-shape detection: field is a string.  A field is "signal" if
  // the string is non-empty and is not one of the ABSENT sentinels
  // (`—`, `$?`) or a compound of them (`— / $?`).
  const strFieldHasSignal = (v) => {
    if (typeof v !== 'string' || v.length === 0) return false
    // Strip em-dashes, slashes, `$?`, whitespace — if anything is left,
    // the field carries information.
    const stripped = v
      .replace(/—/g, '')
      .replace(/\$\?/g, '')
      .replace(/[\/\s]/g, '')
    return stripped.length > 0
  }
  // If ANY spec value is a formatted string, treat the whole thing as
  // formatted and probe each field with strFieldHasSignal.
  const anyFormatted = ['model', 'usage', 'time', 'stop'].some(k => typeof spec[k] === 'string')
  if (anyFormatted) {
    return ['model', 'usage', 'time', 'stop'].some(k => strFieldHasSignal(spec[k]))
  }
  const hasModel = (typeof spec.model === 'string' && spec.model.length > 0)
    || (typeof spec.provider === 'string' && spec.provider.length > 0)
  const u = spec.usage || {}
  const hasUsage = isFiniteNumber(u.inputTokens) || isFiniteNumber(u.outputTokens)
    || isFiniteNumber(u.cacheReadTokens) || isFiniteNumber(u.cacheWriteTokens)
    || isFiniteNumber(u.reasoningTokens)
  const c = spec.cost || {}
  const hasCost = isFiniteNumber(c.total)
  const hasTime = (isFiniteNumber(spec.ttftMs) && spec.ttftMs > 0)
    || (isFiniteNumber(spec.durationMs) && spec.durationMs > 0)
  const hasStop = (typeof spec.stopReason === 'string' && spec.stopReason.length > 0)
    || !!(spec.stopReason && typeof spec.stopReason === 'object' && typeof spec.stopReason.kind === 'string')
  return !!(hasModel || hasUsage || hasCost || hasTime || hasStop)
}

/**
 * Convert a footer spec into an ordered list of label→value pairs.
 * The array shape lets callers (buildTurnFooter, tests) iterate in
 * a stable order without re-deriving field precedence.
 *
 * Order after §9 fuse (2026-07-17): [model, usage, time, stop].
 * `usage` renders as `<tokens> / $<cost>` — the LangSmith root-row
 * shape — collapsing what used to be two separate fields.
 *
 * Segment-level suppression (user 2026-07-18 echo-profile screenshot):
 * a footer that mixes real data with `— · ` placeholders reads as
 * junk (`— · ↑20 ↓58 / $? · — · completed`). We now emit only fields
 * whose value carries information. The zero-drop rule still holds —
 * absent fields remain reachable at L1/L2 via the trace drawer and
 * detail pane — but the L0 footer row is clean.
 *
 * @param {object} spec
 * @param {string} [spec.model]
 * @param {string} [spec.provider]
 * @param {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number, reasoningTokens?:number}} [spec.usage]
 * @param {{total?:number, input?:number, output?:number, cacheRead?:number, cacheWrite?:number}} [spec.cost]
 * @param {number} [spec.ttftMs]
 * @param {number} [spec.durationMs]
 * @param {string|{kind:string}} [spec.stopReason]
 * @returns {Array<{label: string, value: string, hint?: string}>}
 */
function formatFooterFields(spec) {
  const s = spec || {}
  const usage = s.usage || {}
  const cost = s.cost || {}
  const fields = []

  // model: emit only when we have a provider and/or model name.
  const modelValue = fmtProviderModel(s.provider, s.model)
  if (modelValue !== ABSENT) fields.push({ label: 'model', value: modelValue })

  // Fused tokens+cost pill (§9 LangSmith correction 2026-07-17).
  //
  // Emission rules (2026-07-18 echo-profile fix):
  //   * tokens absent + cost absent → drop the whole usage chip.
  //   * tokens present + cost absent → emit `↑… ↓…` (no `$?` tail).
  //     `$?` in the L0 footer is noise; the L1 detail pane keeps `$?`
  //     because the reader has already asked "why is cost missing?".
  //   * tokens absent + cost present → emit `— / $<cost>` (kept: cost
  //     alone is still legible; `—` on the token side explains the
  //     `/`).
  //   * both present → emit `↑… ↓… / $<cost>`.
  const inTok  = fmtTokens(usage.inputTokens)
  const outTok = fmtTokens(usage.outputTokens)
  const cacheRead = fmtTokens(usage.cacheReadTokens)
  const hasCache  = cacheRead !== ABSENT
  const tokenBits = []
  if (inTok !== ABSENT) tokenBits.push(`↑${inTok}`)
  if (hasCache)         tokenBits.push(`(${cacheRead} cached)`)
  if (outTok !== ABSENT) tokenBits.push(`↓${outTok}`)
  const tokenValue = tokenBits.length ? tokenBits.join(' ') : ABSENT
  const hasTokens = tokenValue !== ABSENT
  const hasCost   = isFiniteNumber(cost.total)
  if (hasTokens && hasCost) {
    fields.push({ label: 'usage', value: `${tokenValue} / ${fmtCost(cost.total)}` })
  } else if (hasTokens) {
    fields.push({ label: 'usage', value: tokenValue })
  } else if (hasCost) {
    fields.push({ label: 'usage', value: `${ABSENT} / ${fmtCost(cost.total)}` })
  }
  // else: neither → chip omitted entirely.

  // Timings: `<ttft>ms / <dur>s` when both present, else just what we
  // have; drop the chip entirely when neither present.
  const ttft = fmtTtft(s.ttftMs)
  const dur  = fmtDurationMs(s.durationMs)
  if (ttft !== ABSENT && dur !== ABSENT) {
    fields.push({ label: 'time', value: `${ttft} / ${dur}` })
  } else if (dur !== ABSENT) {
    fields.push({ label: 'time', value: dur })
  } else if (ttft !== ABSENT) {
    fields.push({ label: 'time', value: ttft })
  }

  const stopValue = fmtStopReason(s.stopReason)
  if (stopValue !== ABSENT) fields.push({ label: 'stop', value: stopValue })

  return fields
}

/**
 * Build the terminator row DOM. The footer sits at the bottom of the
 * assistant-turn container; the small horizontal rule above it is
 * created by CSS (turn-footer::before), not this builder.
 *
 * @param {Document} doc
 * @param {object} spec  see formatFooterFields
 * @returns {HTMLElement}
 */
function buildTurnFooter(doc, spec) {
  const el = doc.createElement('footer')
  el.className = 'turn-footer'
  const fields = formatFooterFields(spec)
  fields.forEach((f, i) => {
    const chip = doc.createElement('span')
    chip.className = `turn-footer-field field-${f.label}`
    chip.textContent = f.value
    if (f.hint) chip.title = f.hint
    el.appendChild(chip)
    if (i < fields.length - 1) {
      const sep = doc.createElement('span')
      sep.className = 'turn-footer-sep'
      sep.textContent = ' · '
      el.appendChild(sep)
    }
  })
  return el
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatFooterFields, buildTurnFooter, specHasAnySignal,
    fmtTokens, fmtCost, fmtDurationMs, fmtTtft, fmtStopReason, fmtProviderModel,
    ABSENT,
  }
}
if (typeof window !== 'undefined') {
  window.__dshTurnFooter = {
    formatFooterFields, buildTurnFooter, specHasAnySignal,
  }
}
