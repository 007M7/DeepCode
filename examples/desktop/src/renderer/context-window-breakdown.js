// Context-window family breakdown — pure projections for the Context page
// occupancy bar (lane-ctx-deep, task #51 F1).
//
// The Context page's window-occupancy bar splits the current session's
// accumulated context into five families and renders their token shares as
// a stacked horizontal bar with hover tooltips. Because the wire does not
// (yet) tag each event with its context-family, we run a heuristic
// classifier over `cachedEvents`:
//
//   - system_prompt  — session-start injections and the daemon's own
//                      system-role seeds (context/message events whose
//                      source is `{kind:'system'}` or from the compact
//                      plugin's system seed, plus the running system
//                      preamble carried by turn/start.data.systemPreamble
//                      when it lands).
//   - tool_defs      — the JSON schemas for tool defintions we ship on the
//                      first turn. Best proxy is turn/start.data.tools (if
//                      present) or tool/definitions events; otherwise we
//                      estimate from tool/call event NAMES (schema footprint
//                      ≈ 400 chars per unique tool, an SDK-typical shape).
//   - thinking       — assistant/reasoning events. Cost accounting-wise
//                      these are output tokens the model produced but they
//                      DO occupy the response prompt on the next turn if
//                      the adapter round-trips reasoning tokens.
//   - responses      — assistant/message content the model produced.
//   - injections     — every OTHER context/message (plugin injects, user
//                      steer, recall pulls). These are the ones the Context
//                      Rail already highlights.
//
// The `estimateTokens(x)` primitive uses the same heuristic the
// context-meter approx mode uses (bytes ÷ 4) so a bar whose slices sum to
// the meter's approx-tokens read matches to the token. When
// assistant/message events carry a `usage` envelope we honour it — the
// `responses` slice snaps to precise `outputTokens` and `thinking` to
// `usage.thinking` if the adapter reports it.
//
// Pure module. Tested via node:test. See:
//   - test/context-window-breakdown.test.js (this task's coverage)
//   - src/renderer/context-page.js (renders the bar)

'use strict'

// Family palette hints — the CSS owns the actual color tokens; this map
// exists so the tooltip renderer and legend agree on one label per family.
const FAMILY_ORDER = ['system_prompt', 'tool_defs', 'thinking', 'responses', 'injections']

const FAMILY_LABELS = Object.freeze({
  system_prompt: 'System prompt',
  tool_defs:     'Tool definitions',
  thinking:      'Reasoning',
  responses:     'Assistant messages',
  injections:    'Injections & recall',
})

// Rough per-tool schema footprint (chars). Copied from a survey of DSH's
// bundled MCPs — schemas run 300–500 chars per tool once JSON-encoded with
// description strings and parameter schemas. 400 sits in the middle and
// keeps the bar honest without pretending we sniffed the actual schema.
const TOOL_SCHEMA_APPROX_CHARS = 400

/**
 * Rough byte-count proxy for one event's payload. Mirrors context-meter's
 * `estimateEventBytes` (private in that module) so bar arithmetic reads the
 * same as the statusbar meter under approx mode.
 * @param {object} event
 * @returns {number}
 */
function eventBytes(event) {
  if (!event || typeof event !== 'object') return 0
  const payload = event.data !== undefined ? event.data : event
  try { return JSON.stringify(payload).length } catch (_) { return 0 }
}

function tokensFromBytes(bytes) {
  return Math.max(0, Math.round((bytes || 0) / 4))
}

/**
 * Extract explicit `usage.outputTokens` when the adapter reports one, else
 * null. Kept separate from `usage.inputTokens` because outputs are what
 * `responses` needs — inputs cover the whole running prompt (which is what
 * ALL our slices combined represent).
 */
function outputTokensOf(ev) {
  if (!ev || ev.type !== 'assistant/message') return null
  const u = ev.data && ev.data.usage
  if (!u || typeof u !== 'object') return null
  const out = Number(u.outputTokens)
  return Number.isFinite(out) ? out : null
}

/**
 * Some adapters split reasoning tokens off in `usage.thinking`. When present
 * we use it verbatim for the `thinking` slice, otherwise we fall back to
 * counting bytes of the reasoning event payload.
 */
function thinkingTokensOf(ev) {
  if (!ev || ev.type !== 'assistant/message') return null
  const u = ev.data && ev.data.usage
  if (!u || typeof u !== 'object') return null
  const t = Number(u.thinking) || Number(u.reasoningTokens)
  return Number.isFinite(t) ? t : null
}

/**
 * Classify one event into a context family. Multi-family events (an
 * assistant/message that carries a usage envelope reporting both output and
 * reasoning tokens) are handled at the aggregator level — this per-event
 * classifier returns the *primary* family so the bar's chunking still lines
 * up with the wire event stream.
 * @param {object} ev
 * @returns {'system_prompt'|'tool_defs'|'thinking'|'responses'|'injections'|null}
 */
function classifyEventFamily(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null
  const t = ev.type
  const d = ev.data || {}

  // System-prompt seed. The daemon emits these as context/message with
  // source={kind:'system'} on session start; a system preamble sometimes
  // lands as its own event type too.
  if (t === 'session/start' || t === 'context/system') return 'system_prompt'
  if (t === 'context/message') {
    const src = d.source
    if (src && (src.kind === 'system' || src.kind === 'session-start')) return 'system_prompt'
    // The compact plugin's own summary re-injection is also a system-level
    // seed for the next turn — count it against system_prompt rather than
    // muddying `injections`.
    if (src && src.kind === 'plugin' && src.plugin === 'compact') return 'system_prompt'
    return 'injections'
  }
  if (t === 'compact/summary') return 'system_prompt'
  if (t === 'steering/message') return 'injections'

  // Tool definitions arrive with these type names on different adapters.
  // If nothing ever lands, we synthesize a slice from tool/call event names
  // in the aggregator (see toolSchemaEstimate).
  if (t === 'tool/definitions' || t === 'tools/available') return 'tool_defs'

  // Reasoning vs. response.
  if (t === 'assistant/reasoning') return 'thinking'
  if (t === 'assistant/message' || t === 'assistant/chunk') return 'responses'

  return null
}

/**
 * Estimate tool-def slice from unique tool NAMES seen in tool/call events.
 * When the wire never ships explicit tool/definitions events, this is the
 * fairest proxy: N unique tools × 400-char schema each.
 * @param {Array<object>} events
 * @returns {number}
 */
function toolSchemaEstimate(events) {
  const seen = new Set()
  for (const ev of events) {
    if (ev && ev.type === 'tool/call' && ev.data && typeof ev.data.name === 'string') {
      seen.add(ev.data.name)
    }
  }
  if (seen.size === 0) return 0
  return tokensFromBytes(seen.size * TOOL_SCHEMA_APPROX_CHARS)
}

/**
 * @typedef {Object} FamilySlice
 * @property {string} family
 * @property {string} label
 * @property {number} tokens
 * @property {number} eventCount
 * @property {number} pct
 */

/**
 * @typedef {Object} WindowBreakdown
 * @property {Array<FamilySlice>} slices  Five slices in FAMILY_ORDER.
 * @property {number} totalTokens         Sum across all slices.
 * @property {number} budget              Wire-reported context window when known, else 128000.
 * @property {'server'|'assumed'} budgetSource
 * @property {number} budgetPct           totalTokens / budget × 100 (clamped 0..999).
 * @property {'precise'|'approx'} mode    Whether responses/thinking used a usage envelope anywhere.
 * @property {boolean} toolsFromCalls     True when the tool_defs slice was estimated from tool/call NAMES rather than an explicit tool/definitions event.
 */

/**
 * Aggregate cachedEvents into a five-family breakdown with token counts and
 * percentages. Pure: no DOM, no window.* reads.
 *
 * Percentages sum to ≤100 (never > because they normalise against total).
 * When total is zero we return zeroed slices with pct=0 so the caller can
 * render the empty bar without divide-by-zero guards.
 *
 * @param {Array<object>} events
 * @param {object} [opts]
 * @param {number} [opts.budgetTokens]  Wire-reported context window; sets budgetSource='server'.
 * @returns {WindowBreakdown}
 */
function computeWindowBreakdown(events, opts) {
  const budgetOverride = opts && Number.isFinite(opts.budgetTokens) && opts.budgetTokens > 0
    ? Number(opts.budgetTokens)
    : null
  const budget = budgetOverride || 128000
  const budgetSource = budgetOverride ? 'server' : 'assumed'

  const totals = { system_prompt: 0, tool_defs: 0, thinking: 0, responses: 0, injections: 0 }
  const counts = { system_prompt: 0, tool_defs: 0, thinking: 0, responses: 0, injections: 0 }
  let mode = 'approx'
  let toolsFromCalls = false

  if (!Array.isArray(events)) events = []

  // Walk events, honouring `usage` envelopes when they land. Multi-family
  // accounting: an assistant/message with `usage.thinking` splits its
  // tokens between the thinking slice and the responses slice; otherwise
  // the whole payload byte-count falls into the primary family.
  for (const ev of events) {
    const fam = classifyEventFamily(ev)
    if (fam === null) continue

    // Precise-mode split for assistant/message: outputTokens → responses,
    // usage.thinking (or reasoningTokens) → thinking.
    if (ev && ev.type === 'assistant/message') {
      const out = outputTokensOf(ev)
      const think = thinkingTokensOf(ev)
      if (out !== null || think !== null) {
        mode = 'precise'
        if (out !== null) { totals.responses += out; counts.responses++ }
        if (think !== null) { totals.thinking += think; counts.thinking++ }
        continue
      }
    }

    totals[fam] += tokensFromBytes(eventBytes(ev))
    counts[fam]++
  }

  // Tool defs: prefer explicit tool/definitions events (already summed
  // above). Fall back to the tool-call-name proxy when the wire didn't ship
  // any. We mark `toolsFromCalls` in the return so the UI's hover tooltip
  // can honestly say "estimated from N unique tools" instead of "counted".
  if (totals.tool_defs === 0) {
    const est = toolSchemaEstimate(events)
    if (est > 0) {
      totals.tool_defs = est
      counts.tool_defs = 1 // synthetic single-blob slice
      toolsFromCalls = true
    }
  }

  const total = FAMILY_ORDER.reduce((s, f) => s + totals[f], 0)
  const slices = FAMILY_ORDER.map((f) => {
    const pct = total > 0 ? (totals[f] / total) * 100 : 0
    return {
      family: f,
      label: FAMILY_LABELS[f],
      tokens: totals[f],
      eventCount: counts[f],
      pct: Math.round(pct * 10) / 10, // one decimal so tests can lock a stable shape
    }
  })

  const budgetPct = budget > 0 ? Math.round((total / budget) * 100) : 0
  return {
    slices,
    totalTokens: total,
    budget,
    budgetSource,
    budgetPct: Math.max(0, Math.min(budgetPct, 999)),
    mode,
    toolsFromCalls,
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeWindowBreakdown,
    classifyEventFamily,
    toolSchemaEstimate,
    FAMILY_ORDER,
    FAMILY_LABELS,
    TOOL_SCHEMA_APPROX_CHARS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshContextWindowBreakdown = {
    computeWindowBreakdown,
    classifyEventFamily,
    toolSchemaEstimate,
    FAMILY_ORDER,
    FAMILY_LABELS,
    TOOL_SCHEMA_APPROX_CHARS,
  }
}
