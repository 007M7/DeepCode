// Context-usage meter: pure accumulator over the session event stream.
//
// the desktop shell needs a live indicator of how full the
// working context window is, plus a hook the "Compact now" button can read.
// This module owns the accounting; the statusbar reads level + label from it
// and renderer.js feeds it every session event.
//
// Two accounting modes coexist because upstream token accounting is spotty:
//
//   - **precise** — `assistant/message.data.usage` (`TokenUsage` in
//     packages/llm/llm/src/types.ts) reports `inputTokens + outputTokens`
//     when the adapter passes it through. Each `assistant/message` update
//     rewrites `tokens` to the current input+output count for the step
//     (input already covers the whole running prompt).
//   - **approx** — no adapter usage yet; we count bytes of event payloads
//     as a rough proxy (÷4 = pseudo-tokens). The UI badges this with a `~`
//     prefix so a reader knows it's a heuristic, not an accountant number.
//
// The two modes are stored on the same tracker instance; mode flips to
// 'precise' the moment we see the first `assistant/message.data.usage` on
// this session and never flips back. Approx accumulates until then so the
// meter isn't stuck at 0 for a mock-echo profile that never reports usage.
//
// `compact/summary` resets accounting: the summary replaces the shadowed
// range, so tokens after compaction should reflect only what's post-compact.
// Precise mode picks up the next `assistant/message.usage`; approx mode
// clamps to `shadowedTokenCount` subtracted from the running byte tally.
//
// This module is pure: no DOM, no globals, no timers. Tests exercise it via
// `node --test` in test/context-meter.test.js.

'use strict'

// Fallback budget in tokens when the wire hasn't told us the model's real
// context window. DeepSeek-v4 and Claude are 128K+, so 128000 is a
// reasonable "≈ typical modern model" number — but it's an assumption, not
// a truth, and the tracker snapshot marks it as such via `budgetSource:
// 'assumed'` so the UI can distinguish "known" vs "guessed" budgets.
// P0-2 red-line: the label
// must NEVER pretend an assumed 128k is precise; the shell has to say
// "~128k (assumed)" or "unknown budget" when the wire hasn't shipped the
// real number. createTracker() marks any explicit budgetTokens override
// as `budgetSource: 'server'` and the shell wires that from session-list
// header via contextWindowFromEntry() + tracker.setBudget().
const DEFAULT_BUDGET_TOKENS = 128000

// Level thresholds as fractions of budget. Kept as data so the statusbar
// CSS can key off `.level-<name>` classes without duplicating cutoffs.
const LEVEL_THRESHOLDS = Object.freeze([
  { name: 'nominal', min: 0.0 },
  { name: 'warn',    min: 0.5 },
  { name: 'high',    min: 0.8 },
  { name: 'critical', min: 0.95 },
])

/**
 * Classify a fraction (tokens / budget) into a threshold name.
 * @param {number} fraction — usage / budget in [0, ∞); anything past 1 is 'critical'.
 * @returns {'nominal' | 'warn' | 'high' | 'critical'}
 */
function levelForFraction(fraction) {
  const f = Number.isFinite(fraction) ? fraction : 0
  let out = 'nominal'
  for (const t of LEVEL_THRESHOLDS) if (f >= t.min) out = t.name
  return out
}

/**
 * Rough byte-size estimate of an event's payload. We JSON-stringify the
 * `data` field (falling back to the whole event) and count characters. Not
 * an accountant, but stable enough that the meter moves in the right
 * direction as the session grows.
 * @param {object} event
 * @returns {number}
 */
function estimateEventBytes(event) {
  if (!event || typeof event !== 'object') return 0
  const payload = event.data !== undefined ? event.data : event
  try { return JSON.stringify(payload).length }
  catch (_) { return 0 }
}

/**
 * Extract precise token count from an `assistant/message` event's usage
 * envelope. Returns `null` when the event isn't of the right shape or the
 * envelope is missing / partial — the caller falls through to approx.
 * @param {object} event
 * @returns {number | null}
 */
function usageTokensFromEvent(event) {
  if (!event || event.type !== 'assistant/message') return null
  const data = event.data || event
  const usage = data && data.usage
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null
  // Cache reads still count against context — the model still sees them.
  // Cache writes don't add to displayed usage (they're a write, not the
  // running total). Reasoning tokens are a subset of output on providers
  // that split them, so leaving them out avoids double-counting.
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)
}

/**
 * Create a new context-usage tracker. Mutable state is confined to the
 * returned object so multiple sessions can each hold their own.
 *
 * `budgetSource` on the snapshot distinguishes "the wire told us this
 * model's real context window" (`'server'`) from "we're guessing at the
 * default 128k" (`'assumed'`). The renderer uses that flag to badge the
 * statusbar label so the user is never told "~5k / 128k" as if the 128k
 * were authoritative — P0-2 red-line.
 *
 * @param {object} [opts]
 * @param {number} [opts.budgetTokens] — override the default budget with
 *   the model's real context window (usually from the wire). Marks the
 *   tracker's `budgetSource` as `'server'`.
 * @returns {{
 *   ingest(event: object): void,
 *   snapshot(): { tokens: number, mode: 'precise'|'approx', budget: number,
 *                 budgetSource: 'server' | 'assumed',
 *                 fraction: number, level: string, eventCount: number,
 *                 lastCompactTokens: number | null },
 *   setBudget(budgetTokens: number | null | undefined): void,
 *   reset(): void
 * }}
 */
function createTracker(opts = {}) {
  const explicit = Number.isFinite(opts.budgetTokens) && opts.budgetTokens > 0
  let budget = explicit ? Number(opts.budgetTokens) : DEFAULT_BUDGET_TOKENS
  let budgetSource = explicit ? 'server' : 'assumed'

  // Approx-mode running byte tally. Approx-tokens = bytes / 4 — the standard
  // 4-chars-per-token heuristic. We keep raw bytes so a later mode flip to
  // precise doesn't have to unwind rounded numbers.
  let approxBytes = 0
  // Precise-mode last seen input+output tokens on this session.
  let preciseTokens = 0
  let mode = 'approx'
  let eventCount = 0
  // Remember the last shadowedTokenCount so the UI can show "compacted N
  // tokens ago" without reaching back into the DOM for the divider text.
  let lastCompactTokens = null

  function ingest(event) {
    if (!event || typeof event !== 'object') return
    eventCount++
    // Precise mode: assistant/message with a usage envelope wins.
    const precise = usageTokensFromEvent(event)
    if (precise !== null) {
      preciseTokens = precise
      mode = 'precise'
      return
    }
    // Compaction: shadowed range is being replaced by the summary. Precise
    // mode will pick up the next `assistant/message.usage` and settle to
    // the post-compact number, so we just drop the flag here; approx mode
    // subtracts the shadowed byte-estimate (shadowedTokenCount × 4).
    if (event.type === 'compact/summary') {
      const data = event.data || event
      const shadowed = Number(data.shadowedTokenCount)
      lastCompactTokens = Number.isFinite(shadowed) ? shadowed : null
      if (mode === 'approx' && Number.isFinite(shadowed)) {
        approxBytes = Math.max(0, approxBytes - shadowed * 4)
      }
      return
    }
    // Approx mode default: add event bytes to the running tally. Precise
    // mode ignores non-assistant/message events (usage already covers the
    // full prompt).
    if (mode === 'approx') {
      approxBytes += estimateEventBytes(event)
    }
  }

  function snapshot() {
    const tokens = mode === 'precise'
      ? preciseTokens
      : Math.round(approxBytes / 4)
    const fraction = budget > 0 ? tokens / budget : 0
    return {
      tokens,
      mode,
      budget,
      budgetSource,
      fraction,
      level: levelForFraction(fraction),
      eventCount,
      lastCompactTokens,
    }
  }

  /**
   * Update the budget after construction — used by the shell when the
   * server ships a session/list entry whose header carries the real model
   * context window. Passing a positive number promotes to `'server'`;
   * passing null/undefined/non-positive clears back to the default budget
   * and marks the source `'assumed'` again (rare — happens when the shell
   * loses model info on a profile switch).
   */
  function setBudget(budgetTokens) {
    if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
      budget = Number(budgetTokens)
      budgetSource = 'server'
    } else {
      budget = DEFAULT_BUDGET_TOKENS
      budgetSource = 'assumed'
    }
  }

  function reset() {
    approxBytes = 0
    preciseTokens = 0
    mode = 'approx'
    eventCount = 0
    lastCompactTokens = null
  }

  return { ingest, snapshot, setBudget, reset }
}

/**
 * Extract the model's context window (in tokens) from a wire session-list
 * entry, so the shell can bind it into the tracker when the daemon ships
 * that metadata. Probes shapes in priority order:
 *
 *   1. entry.model.contextWindow        — top-level daemon projection
 *      (live sessions only; sourced from `ctx.compact.config.contextWindow`)
 *   2. entry.header.model.contextWindow — phantom-header shape retained
 *      for shells still consuming the pre-projection wire
 *   3. entry.contextWindow              — flat field (some wire variants)
 *
 * Returns a positive integer number of tokens, or null if the entry
 * doesn't carry that information (the caller stays on the assumed
 * default). Never derives from the model's *name* — the intent doc's
 * P0-2 red-line ("不许从模型名反查") is enforced by returning null when
 * the wire didn't ship the actual number.
 *
 * @param {object} entry - a wire session-list entry.
 * @returns {number | null}
 */
function contextWindowFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const projected = entry.model && entry.model.contextWindow
  if (Number.isFinite(projected) && projected > 0) return Number(projected)
  const nested = entry.header && entry.header.model && entry.header.model.contextWindow
  if (Number.isFinite(nested) && nested > 0) return Number(nested)
  const flat = entry.contextWindow
  if (Number.isFinite(flat) && flat > 0) return Number(flat)
  return null
}

/**
 * Extract the model name from a wire session-list entry, preferring the
 * daemon's live projection over the phantom-header echo. Returns a
 * non-empty string or null. The shell displays this in the header chip
 * and the meter title so the user knows which model the budget applies to.
 * Symmetric with {@link contextWindowFromEntry}: never fabricate from
 * anything except an authoritative wire field.
 *
 * @param {object} entry - a wire session-list entry.
 * @returns {string | null}
 */
function modelNameFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const projected = entry.model && entry.model.name
  if (typeof projected === 'string' && projected.length > 0) return projected
  const nested = entry.header && entry.header.model && entry.header.model.name
  if (typeof nested === 'string' && nested.length > 0) return nested
  return null
}

/**
 * Format a token count in the compact style the meter label uses: "999",
 * "9.9k", or "999k". Extracted here so tests can drive it without booting
 * the renderer harness.
 * @param {number} n
 * @returns {string}
 */
function formatTokensCompact(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * Compute the statusbar meter label + title for a given tracker snapshot.
 * Extracted from the renderer as a pure function so the P0-2 red-line —
 * "never present an assumed budget as authoritative" — is unit-testable
 * without a DOM harness.
 *
 * @param {{tokens: number, budget: number, mode: 'precise'|'approx', budgetSource: 'server'|'assumed'}} snap
 * @returns {{label: string, title: string, budgetClass: 'server' | 'assumed'}}
 */
function meterLabelFor(snap) {
  if (!snap || typeof snap !== 'object') {
    return { label: '—', title: '', budgetClass: 'assumed' }
  }
  const assumed = snap.budgetSource !== 'server'
  const tokenPrefix = snap.mode === 'approx' ? '~' : ''
  const budgetLabel = assumed
    ? `~${formatTokensCompact(snap.budget)} (assumed)`
    : formatTokensCompact(snap.budget)
  const label = `${tokenPrefix}${formatTokensCompact(snap.tokens)} / ${budgetLabel}`
  const tokenPhrase = snap.mode === 'approx'
    ? `~${snap.tokens} tokens (heuristic — the adapter didn't report token usage)`
    : `${snap.tokens} tokens`
  const budgetPhrase = assumed
    ? `an assumed ${snap.budget}-token budget (the runtime hasn't reported this model's real context window; showing the shell's default fallback)`
    : `a ${snap.budget}-token budget (from the runtime)`
  return {
    label,
    title: `Context usage: ${tokenPhrase} against ${budgetPhrase}.`,
    budgetClass: assumed ? 'assumed' : 'server',
  }
}

// Dual export shape mirrors widgets.js / tool-cards.js: CommonJS for node
// tests, `window.__dshContextMeter` for the renderer. The renderer's script
// tag runs before renderer.js so the handle is ready at the dispatch site.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createTracker,
    levelForFraction,
    estimateEventBytes,
    usageTokensFromEvent,
    contextWindowFromEntry,
    modelNameFromEntry,
    formatTokensCompact,
    meterLabelFor,
    LEVEL_THRESHOLDS,
    DEFAULT_BUDGET_TOKENS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshContextMeter = {
    createTracker,
    levelForFraction,
    contextWindowFromEntry,
    modelNameFromEntry,
    formatTokensCompact,
    meterLabelFor,
    LEVEL_THRESHOLDS,
    DEFAULT_BUDGET_TOKENS,
  }
}
