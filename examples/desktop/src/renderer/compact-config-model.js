// Pure model for the compact-card "Config" tab (lane-ctx-deep, task #51 F2).
//
// The Config tab is an info-only entrance to the compaction policy: it names
// the current threshold, the strategy, how many times the daemon has fired
// compact this session, and a "distance to next compact" progress bar. It
// is *not* an edit surface — a live editor belongs on the Settings page,
// and the tab tooltip points there ("Adjust in Settings › Compaction").
//
// Model shape is a plain object so tests can lock it without a DOM harness.
// The `buildCompactConfigView` function is the single entry point; it takes
// a session's cached events and (optionally) a policy override the shell
// pulls from the Settings profile, and returns:
//
//   {
//     thresholdTokens,       // e.g. 96000 (server-reported) or fallback 96k
//     thresholdSource,       // 'server'|'assumed'
//     strategyName,          // e.g. 'summarize-shadowed' / 'unknown'
//     model,                 // summary model, e.g. 'deepseek-chat' or null
//     maxSummaryTokens,      // policy cap on the summary output
//     triggersFired,         // total compact/summary events observed
//     lastCompactSeq,        // seq of the last compact/summary, or null
//     currentTokens,         // running tokens at end of stream
//     tokensSinceLastCompact,// tokens accumulated after the last compact
//     tokensUntilNext,       // max(threshold − tokensSinceLastCompact, 0)
//     progressPct,           // tokensSinceLastCompact / threshold × 100
//     progressLevel,         // 'nominal'|'warn'|'high'|'critical'
//   }
//
// Threshold source: we prefer the wire (`session/list` entry's
// `context.compact.threshold` if the daemon ever ships one), else fall back
// to 75% of the model's context window ("industry default"), else a hard
// fallback of 96000. The `thresholdSource` field marks which path we took
// so the tab tooltip can be honest.

'use strict'

const DEFAULT_THRESHOLD_TOKENS = 96000

/**
 * Return the compact threshold (tokens) plus its provenance.
 * Priority order:
 *   1. `override.thresholdTokens` (Settings profile / test override).
 *   2. `budgetTokens * 0.75` when a wire-reported budget is available.
 *   3. DEFAULT_THRESHOLD_TOKENS (96000).
 * @param {object} [opts]
 * @param {number} [opts.thresholdTokens] explicit override
 * @param {number} [opts.budgetTokens] wire-reported model context window
 * @returns {{ tokens: number, source: 'server'|'assumed' }}
 */
function resolveThreshold(opts) {
  const explicit = opts && Number.isFinite(opts.thresholdTokens) && opts.thresholdTokens > 0
  if (explicit) return { tokens: Number(opts.thresholdTokens), source: 'server' }
  const budget = opts && Number.isFinite(opts.budgetTokens) && opts.budgetTokens > 0
    ? Number(opts.budgetTokens) : null
  if (budget) return { tokens: Math.round(budget * 0.75), source: 'assumed' }
  return { tokens: DEFAULT_THRESHOLD_TOKENS, source: 'assumed' }
}

/**
 * Roughly count tokens the same way context-meter's approx mode does:
 * bytes ÷ 4 over `event.data` JSON. Duplicated here (not imported) so the
 * config model stays a leaf — importing context-meter would require the
 * caller to pass a tracker to keep coherent, and every callsite already
 * has cachedEvents in hand.
 * @param {object} event
 * @returns {number}
 */
function approxTokensFor(event) {
  if (!event || typeof event !== 'object') return 0
  // Precise-mode signal: honour the usage envelope if present.
  if (event.type === 'assistant/message') {
    const u = event.data && event.data.usage
    if (u && typeof u === 'object') {
      const inp = Number(u.inputTokens)
      const out = Number(u.outputTokens)
      const sum = (Number.isFinite(inp) ? inp : 0) + (Number.isFinite(out) ? out : 0)
      if (sum > 0) return sum
    }
  }
  const payload = event.data !== undefined ? event.data : event
  try { return Math.round(JSON.stringify(payload).length / 4) } catch (_) { return 0 }
}

function levelForPct(pct) {
  if (!Number.isFinite(pct)) return 'nominal'
  if (pct >= 95) return 'critical'
  if (pct >= 80) return 'high'
  if (pct >= 50) return 'warn'
  return 'nominal'
}

/**
 * Build the full config-tab view model.
 *
 * @param {Array<object>} events
 * @param {object} [opts]
 * @param {number} [opts.thresholdTokens]
 * @param {number} [opts.budgetTokens]
 * @param {string} [opts.strategyName]
 * @returns {{
 *   thresholdTokens:number,
 *   thresholdSource:'server'|'assumed',
 *   strategyName:string,
 *   model:string|null,
 *   maxSummaryTokens:number|null,
 *   triggersFired:number,
 *   lastCompactSeq:number|null,
 *   currentTokens:number,
 *   tokensSinceLastCompact:number,
 *   tokensUntilNext:number,
 *   progressPct:number,
 *   progressLevel:'nominal'|'warn'|'high'|'critical',
 * }}
 */
function buildCompactConfigView(events, opts) {
  const threshold = resolveThreshold(opts || {})

  let triggers = 0
  let lastSeq = null
  let lastPolicy = null
  let tokensTotal = 0
  let tokensSinceLast = 0

  if (Array.isArray(events)) {
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue
      const tk = approxTokensFor(ev)
      tokensTotal += tk
      tokensSinceLast += tk
      if (ev.type === 'compact/summary') {
        triggers++
        if (Number.isFinite(ev.seq)) lastSeq = ev.seq
        const d = ev.data || {}
        lastPolicy = {
          model: typeof d.model === 'string' ? d.model : null,
          maxTokens: Number.isFinite(d.maxTokens) ? d.maxTokens : null,
        }
        // A compact resets the "since last" counter; the shadowed range
        // just replaced the running budget so tokens after should count
        // from zero.
        tokensSinceLast = 0
      }
    }
  }

  const progressPct = threshold.tokens > 0
    ? Math.round((tokensSinceLast / threshold.tokens) * 1000) / 10
    : 0
  const tokensUntilNext = Math.max(0, threshold.tokens - tokensSinceLast)

  const strategyName = (opts && typeof opts.strategyName === 'string' && opts.strategyName)
    || (lastPolicy ? 'summarize-shadowed' : 'summarize-shadowed (default)')

  return {
    thresholdTokens: threshold.tokens,
    thresholdSource: threshold.source,
    strategyName,
    model: lastPolicy && lastPolicy.model,
    maxSummaryTokens: lastPolicy && lastPolicy.maxTokens,
    triggersFired: triggers,
    lastCompactSeq: lastSeq,
    currentTokens: tokensTotal,
    tokensSinceLastCompact: tokensSinceLast,
    tokensUntilNext,
    progressPct: Math.max(0, Math.min(progressPct, 999)),
    progressLevel: levelForPct(progressPct),
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildCompactConfigView,
    resolveThreshold,
    approxTokensFor,
    levelForPct,
    DEFAULT_THRESHOLD_TOKENS,
  }
}
if (typeof window !== 'undefined') {
  window.__dshCompactConfigModel = {
    buildCompactConfigView,
    resolveThreshold,
    approxTokensFor,
    levelForPct,
    DEFAULT_THRESHOLD_TOKENS,
  }
}
