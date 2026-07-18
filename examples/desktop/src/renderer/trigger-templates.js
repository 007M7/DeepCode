;(function () {
// trigger-templates.js — pure module for §2.3 "context → GUI via template + trigger".
//
// Boss rule (strategy-feature-list v2 §2.3): "根据 context 做 GUI" is a
// **template + trigger** pipeline, NOT realtime layout generation. Each
// trigger is a matcher over the session-event stream; when it hits, we
// pick a pre-authored `WidgetSpec` template and hand it to `widgets.js`
// to paint. No new wire, no LLM round-trip.
//
// Kept in a pure module (mirror of `next-actions.js` and `inject-family.js`)
// so `node --test` can round-trip synthetic events → widget specs without
// booting the DOM. The renderer wires this into `onSessionEvent` at the
// same call sites that already dispatch cards, so triggers appear inline
// beside the event that provoked them (the chat-flow rule from §1 —
// "对话流本位" — applies here just as it does to trace cards).
//
// v0 covers three of the eight §2.3 triggers (the batch-6 demand: "8 条
// trigger 里 demo 至少 3 类"):
//
//   T2  Error recovery      → `tool/result.isError === true`
//   T4  Artifact preview    → `tool/result.meta.card === 'artifact'` OR
//                              `artifact/update` broadcast
//   T5  Context health warn → `context-budget/update` with pct > 0.85
//
// The remaining T1/T3/T6/T7/T8 land later, on the same seam.
//
// The verbs are all drawn from the existing 5-verb catalog in
// `next-actions.js` (prompt / open_link / open_artifact / switch_session
// / note); zero new verbs. Any producer that adds a new template just
// picks widget kinds and actions from the same closed set.

'use strict'

const NA = (typeof module !== 'undefined' && module.exports)
  ? require('./next-actions.js')
  : (typeof globalThis !== 'undefined' && globalThis.NextActions)
      ? globalThis.NextActions
      : null

// Context-budget warn threshold. Boss said "context meter >85% budget"
// verbatim (v2 §2.3 T5 row). Keeping the constant here (not in the meter
// module) so tests read one number and one rule together.
const CONTEXT_WARN_PCT = 0.85

// -- known error code patterns (T2) -------------------------------------------
//
// Small, closed set drawn from what the daemon actually surfaces on
// `tool/result.error` today (see `packages/core/tools/src/presentation.ts`
// for the error shape). Rules are ordered — first match wins. Anything
// unmatched still gets a generic "explain + retry" recovery card so a
// tool failure never lands without at least one suggested move.

const ERROR_RECIPES = Object.freeze([
  {
    id: 'file-not-found',
    match: /\b(ENOENT|no such file or directory|file not found|does not exist)\b/i,
    title: 'File not found',
    hint: 'The path passed to the tool did not resolve — likely a typo or a stale reference.',
    actions: [
      { id: 'list-dir', verb: 'prompt', label: 'List the directory', prompt: 'List the directory the tool tried to read; suggest the closest existing path.' },
      { id: 'retry',    verb: 'prompt', label: 'Retry with a corrected path', prompt: 'Retry the last tool call with the corrected path.' },
    ],
  },
  {
    id: 'permission-denied',
    match: /\b(EACCES|permission denied|forbidden|not permitted)\b/i,
    title: 'Permission denied',
    hint: 'The tool lacked the sandbox capability for that path. Broaden the workspace or run the equivalent read-only step.',
    actions: [
      { id: 'read-only', verb: 'prompt', label: 'Try a read-only version', prompt: 'Rewrite the last call as a read-only inspection and retry.' },
      { id: 'explain',   verb: 'prompt', label: 'Explain what to grant',   prompt: 'Explain in one sentence which permission the sandbox is missing.' },
    ],
  },
  {
    id: 'command-not-found',
    match: /\bcommand not found\b|\b: not found\b|which: no /i,
    title: 'Command not installed',
    hint: 'The binary the tool tried to exec is not on PATH inside the sandbox.',
    actions: [
      { id: 'alt-tool', verb: 'prompt', label: 'Suggest an alternative', prompt: 'Suggest a different command that produces the same result and is likely to be installed.' },
      { id: 'note',     verb: 'note',  label: 'Mark: needs install', note: 'user noted the command needs a real install (env fix), not a retry' },
    ],
  },
  {
    id: 'network-timeout',
    match: /\b(ETIMEDOUT|ECONNRESET|timeout|network is unreachable|handshake)\b/i,
    title: 'Network hiccup',
    hint: 'A transient network error — usually a retry succeeds. If it does not, back off and try a different endpoint.',
    actions: [
      { id: 'retry-once', verb: 'prompt', label: 'Retry once', prompt: 'Retry the last tool call exactly once and stop if it fails again.' },
      { id: 'diff-way',   verb: 'prompt', label: 'Try a different route', prompt: 'The endpoint is failing; propose a different way to fetch the same information.' },
    ],
  },
  {
    id: 'json-parse',
    match: /\b(SyntaxError.*JSON|Unexpected token .* in JSON|JSON parse error)\b/i,
    title: 'JSON parse failed',
    hint: 'The tool output looked textual, not JSON. Ask the model to inspect the raw text before parsing.',
    actions: [
      { id: 'raw',       verb: 'prompt', label: 'Show the raw output', prompt: 'Show me the raw text the tool returned before you tried to parse it.' },
      { id: 'guard',     verb: 'prompt', label: 'Add a parse guard',   prompt: 'Adjust the call to guard the parse with a fallback and try again.' },
    ],
  },
])

const GENERIC_RECOVERY = Object.freeze({
  id: 'generic',
  title: 'Tool call failed',
  hint: 'Unknown error class — walk through the failure and pick a recovery.',
  actions: [
    { id: 'explain', verb: 'prompt', label: 'Explain the failure', prompt: 'Explain the last tool failure in plain language and identify the likely root cause.' },
    { id: 'retry',   verb: 'prompt', label: 'Try again',            prompt: 'Try the last step again with any fix you can spot from the error message.' },
    { id: 'pivot',   verb: 'prompt', label: 'Try a different approach', prompt: 'Back out of the current approach and propose a different route to the same goal.' },
  ],
})

// -- T2: error recovery ------------------------------------------------------

function templateFromError(event) {
  if (!event || event.type !== 'tool/result') return null
  const data = event.data || event
  if (!data || data.isError !== true) return null

  const messageText = extractErrorText(data)
  const recipe = matchErrorRecipe(messageText) || GENERIC_RECOVERY

  const callId = String(data.callId || '')
  const widget = {
    kind: 'kv',
    id: `t2-error-${callId || Date.now()}`,
    data: {
      entries: [
        { key: 'error',   value: recipe.title },
        { key: 'signal',  value: truncate(messageText || '(no message)', 140) },
        { key: 'suggest', value: recipe.hint, hint: 'why this recovery makes sense' },
      ],
    },
    actions: recipe.actions.map((a) => ({ ...a })),
  }
  return { kind: 't2-error-recovery', ruleId: recipe.id, widget }
}

function extractErrorText(data) {
  // The wire has two shapes: (a) `error: { message, code }` on some
  // tool paths, and (b) content blocks with an error-like text prefix
  // on others. Read both, prefer (a).
  if (data && data.error && typeof data.error.message === 'string') return data.error.message
  if (Array.isArray(data && data.content)) {
    for (const block of data.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        return block.text.trim()
      }
    }
  }
  return ''
}

function matchErrorRecipe(text) {
  if (typeof text !== 'string' || text === '') return null
  for (const r of ERROR_RECIPES) {
    if (r.match.test(text)) return r
  }
  return null
}

// -- T4: artifact preview ----------------------------------------------------
//
// Two wire paths:
//   (a) tool/result.meta = { card: 'artifact', artifactId, title?, mime? }
//   (b) artifact/update  = { artifactId, title?, mime?, path? }  (main.js)

function templateFromArtifact(event) {
  if (!event) return null
  const type = event.type
  const data = event.data || event
  let artifactId = null
  let title = null
  let mime = null
  if (type === 'tool/result') {
    const meta = data && data.meta
    if (!meta || meta.card !== 'artifact') return null
    artifactId = String(meta.artifactId || meta.id || '')
    title = String(meta.title || '')
    mime = typeof meta.mime === 'string' ? meta.mime : null
  } else if (type === 'artifact/update') {
    artifactId = String(data.artifactId || data.id || '')
    title = String(data.title || '')
    mime = typeof data.mime === 'string' ? data.mime : null
  } else {
    return null
  }
  if (!artifactId) return null

  const displayTitle = title || artifactId
  const summary = mime
    ? `${displayTitle} · ${mime}`
    : displayTitle
  const widget = {
    kind: 'kv',
    id: `t4-artifact-${artifactId}`,
    data: {
      entries: [
        { key: 'artifact', value: displayTitle },
        { key: 'preview',  value: summary,      hint: 'click Open to view in browser' },
      ],
    },
    actions: [
      { id: 'open',     verb: 'open_artifact', label: 'Open the artifact', artifactId },
      { id: 'describe', verb: 'prompt',        label: 'Describe it',       prompt: `Describe the artifact ${displayTitle} in one paragraph.` },
    ],
  }
  return { kind: 't4-artifact-preview', ruleId: 'artifact.open', widget }
}

// -- T5: context health warning ----------------------------------------------
//
// Wire: `context-budget/update` (see context-meter module). Fires the
// template exactly once per session per "crossing" of the 85% threshold.
// Renderer dedupes via `state.triggerFired` (see hook in renderer.js);
// the pure module just decides "does this event qualify?".

function templateFromContextBudget(event) {
  if (!event) return null
  const type = event.type
  const data = event.data || event
  if (type !== 'context-budget/update' && type !== 'context/budget') return null
  const pct = numberOrNull(data.pct)
  if (pct === null || pct < CONTEXT_WARN_PCT) return null
  const usedTokens = numberOrNull(data.usedTokens)
  const budgetTokens = numberOrNull(data.budgetTokens)
  const displayPct = `${Math.round(pct * 100)}%`
  const displayUsed = usedTokens !== null && budgetTokens !== null
    ? `${usedTokens} / ${budgetTokens} tokens`
    : (usedTokens !== null ? `${usedTokens} tokens` : '(unknown)')
  const widget = {
    kind: 'kv',
    id: `t5-context-${Date.now()}`,
    data: {
      entries: [
        { key: 'context',  value: `${displayPct} used` },
        { key: 'budget',   value: displayUsed, hint: 'usage vs the current model budget' },
        { key: 'suggest',  value: 'Compact now, or fork a fresh chat to keep going.' },
      ],
    },
    actions: [
      { id: 'compact',   verb: 'prompt', label: 'Compact now',
        prompt: 'Please run session/compact so we free up context budget before the next step.' },
      { id: 'fork',      verb: 'prompt', label: 'Fork a fresh chat',
        prompt: 'This context is nearly full — fork a fresh chat that only carries the takeaways so far.' },
      { id: 'note',      verb: 'note',   label: 'Ack (keep going)',
        note: 'user acknowledged context-health warning; no action' },
    ],
  }
  return { kind: 't5-context-warning', ruleId: 'context.>=85', widget }
}

// -- top-level dispatcher ----------------------------------------------------

/**
 * Given a SessionEvent (raw wire shape), return one trigger template hit
 * or null. Pure; deterministic; no DOM. `ctx` is a small opt-in object
 * for state a single event cannot carry — currently only threshold state
 * for T5 dedupe lives outside this module (in the renderer's Set of
 * fired trigger ids), but we still take an object so callers can pass a
 * config knob (e.g. lowered warn pct in tests) without a second export.
 */
function templateFromEvent(event, ctx) {
  const _ = ctx // unused — retained for future knobs; keeps callsite stable
  return templateFromError(event) || templateFromArtifact(event) || templateFromContextBudget(event) || null
}

// -- small helpers -----------------------------------------------------------

function numberOrNull(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null
}

// Shared with interact-cards + trace-aggregator — see text-truncate.js.
const truncate = ((typeof window !== 'undefined' && window.__dshTextTruncate)
  || (typeof module !== 'undefined' && require('./text-truncate.js'))
).truncate

// -- exports -----------------------------------------------------------------

const api = {
  CONTEXT_WARN_PCT,
  ERROR_RECIPES,
  GENERIC_RECOVERY,
  templateFromEvent,
  templateFromError,
  templateFromArtifact,
  templateFromContextBudget,
  matchErrorRecipe,
}
if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.TriggerTemplates = api
if (typeof window !== 'undefined') window.__dshTriggerTemplates = api

// Silence unused-linter for the NA import — kept for parity with widgets.js
// pattern; a future template may pull VERBS out of it.
void NA
})()
