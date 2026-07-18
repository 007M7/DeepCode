(function () {
// Pure functions for event-visibility rendering (batch B of the P0 renderer
// audit). Runs under both `node --test` (CJS require) and the classic-script
// loader in the renderer (globalThis attach). No DOM, no timers, no protocol
// dependency — the controller layer wraps these in one direction only.
//
// Rendered surface:
//   - todo/write           → foldTodoList(todos)  → checklist model
//   - prompt/blocked       → identity pass-through with reason/text
//   - turn/end             → formatTurnEndReason(reason) → detail string or null
//   - subagent.finished    → summarizeSubagentFinished(params) → summary or null
//   - bash/sandbox-mode    → { mode }
//   - permission/preset    → { preset }
//   - approval/asked+decided → auditRowForApproval(events)
//
// Payload shapes (integration branch, mirror @2026-07-16):
//   packages/core/session/src/types.ts           → TodoItem, TurnEndReasonMap,
//                                                  'todo/write', 'prompt/blocked'
//   packages/ui/user-approval/src/index.ts       → approval/{asked,decided,policy}
//   packages/ui/permission/src/index.ts          → permission/preset
//   packages/bash/bash/src/session-mode.ts       → bash/sandbox-mode
//   packages/ui/jsonrpc/src/server.ts:subagentFinished emit
//
// See docs/capability-ui-coverage.md P0-3/4/7/8/11/12/13 for the corresponding
// audit rows.

'use strict'

// -- todo/write --------------------------------------------------------------

/** Icon glyph per {@link TodoItem} status, as spec'd in the task brief. */
const TODO_STATUS_ICON = Object.freeze({
  pending: '·',
  in_progress: '⋯',
  completed: '✓',
})

/** Human-readable label per todo status. */
const TODO_STATUS_LABEL = Object.freeze({
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'completed',
})

/**
 * Normalize a `todo/write` payload's `todos` array into the checklist model
 * the DOM layer renders. Filters out malformed rows (non-string content,
 * unknown status) but preserves order and does NOT dedupe — the tool guarantees
 * unique content, and dropping a duplicate here would hide a bug rather than a
 * duplicate.
 *
 * The tool's rule "at most one in_progress" is a producer-side invariant we
 * surface as a `warnings` array rather than enforce here, so a violation
 * renders visibly instead of silently collapsing.
 *
 * @param {unknown} todos raw `event.data.todos`
 * @returns {{items: {content:string,status:'pending'|'in_progress'|'completed',icon:string,label:string}[], counts: {pending:number,in_progress:number,completed:number,total:number}, warnings: string[]}}
 */
function foldTodoList(todos) {
  const items = []
  const warnings = []
  const counts = { pending: 0, in_progress: 0, completed: 0, total: 0 }
  if (!Array.isArray(todos)) {
    return { items, counts, warnings: ['todo/write payload is not an array'] }
  }
  for (let i = 0; i < todos.length; i += 1) {
    const raw = todos[i]
    if (!raw || typeof raw !== 'object') {
      warnings.push(`row ${i}: not an object`)
      continue
    }
    const content = typeof raw.content === 'string' ? raw.content : null
    const status = raw.status
    if (content === null || content === '') {
      warnings.push(`row ${i}: missing content`)
      continue
    }
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      warnings.push(`row ${i}: unknown status "${String(status)}"`)
      continue
    }
    items.push({
      content,
      status,
      icon: TODO_STATUS_ICON[status],
      label: TODO_STATUS_LABEL[status],
    })
    counts[status] += 1
    counts.total += 1
  }
  if (counts.in_progress > 1) {
    warnings.push(`${counts.in_progress} items in progress (tool guarantees ≤1)`)
  }
  return { items, counts, warnings }
}

// -- turn/end reason ---------------------------------------------------------

/**
 * Turn `reason` → user-visible detail suffix, or `null` when there is nothing
 * beyond `reason.kind` worth appending. `renderer.js:615-620` already writes
 * `turn ended: <kind>` for every turn; this returns the *extra* line the
 * controller appends alongside for the reason shapes that carry details:
 *
 * - `error`      → "error at step N: <message>" (+ code when present), severity=error
 * - `max-tokens` → "hit max tokens" (no extra fields on the payload today,
 *                  but surfacing it as a yellow notice is spec'd in P0-7)
 * - `rejected`   → "rejected: <reason>"
 * - `aborted`    → "aborted: <reason>" only when a reason is present
 * - `interrupted`, `completed`, `disposed` → null (kind alone is enough)
 *
 * `TurnEndReasonMap` is merge-extensible — unknown kinds fall through with
 * `null` so this stays plugin-friendly.
 *
 * @param {unknown} reason event.data.reason
 * @returns {{detail: string, severity: 'error'|'warn'|'info'} | null}
 */
function formatTurnEndReason(reason) {
  if (!reason || typeof reason !== 'object') return null
  const kind = reason.kind
  switch (kind) {
    case 'error': {
      const step = Number.isInteger(reason.step) ? reason.step : null
      const message = typeof reason.message === 'string' && reason.message !== ''
        ? reason.message
        : '(no message)'
      const code = typeof reason.code === 'string' && reason.code !== '' ? ` [${reason.code}]` : ''
      const at = step === null ? '' : ` at step ${step}`
      return { detail: `error${at}: ${message}${code}`, severity: 'error' }
    }
    case 'max-tokens':
      return { detail: 'hit max tokens', severity: 'warn' }
    case 'rejected': {
      const r = typeof reason.reason === 'string' ? reason.reason : ''
      return { detail: r ? `rejected: ${r}` : 'rejected', severity: 'warn' }
    }
    case 'aborted': {
      const r = typeof reason.reason === 'string' && reason.reason !== '' ? reason.reason : null
      return r === null ? null : { detail: `aborted: ${r}`, severity: 'info' }
    }
    default:
      return null
  }
}

// -- turn/end complete line (audit §3 P0 #4 fix, 2026-07-17) -----------------
//
// The former rendering emitted two lines: renderer.js's `turn ended: <kind>`
// system line + this module's `formatTurnEndReason`-driven detail line.
// Fields §3 P0 #4 spec: fuse into ONE complete `turn ended: error (step N):
// <message>` line so a reader scanning the system stream sees the failure
// step + message at the top level, not in a follow-up. `message` may be long
// (adapter propagation of provider error strings), so callers get:
//
//   { line, title, severity }
//
// where `line` is truncated to ~120 chars (ellipsised, boundary preserved)
// and `title` is the full untruncated string for the hover. Non-error kinds
// stay short so `line === title`.
//
// `TurnEndReasonMap` shapes (kernel packages/core/session/src/types.ts):
//   completed  { kind: 'completed' }                                 (short)
//   aborted    { kind: 'aborted'; reason?: string }                  (short)
//   error      { kind: 'error'; step: number; message: string;
//                                    code?: string }                 (LONG)
//   disposed   { kind: 'disposed' }                                  (short)
//   max-tokens { kind: 'max-tokens' }                                (short)
//   rejected   { kind: 'rejected'; reason: string }                  (short)
//   interrupted{ kind: 'interrupted' }                               (short)
//
// Unknown kinds (plugin merges) fall through to `turn ended: <kind>` with no
// severity so the L0 line stays honest (raw `kind` only) without silently
// dropping information.
//
// @param {unknown} reason
// @returns {{line: string, title: string, severity: 'ok'|'error'|'warn'|'info'}}
const TURN_END_LINE_LIMIT = 120

function formatTurnEndLine(reason) {
  if (!reason || typeof reason !== 'object') {
    return { line: 'turn ended', title: 'turn ended', severity: 'ok' }
  }
  const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
  const detail = formatTurnEndReason(reason)
  if (!detail) {
    // `completed` / `disposed` / `interrupted` / `aborted` (no reason) /
    // unknown plugin-merged kinds — kind alone conveys everything.
    const line = `turn ended: ${kind}`
    const sev = kind === 'completed' ? 'ok'
      : kind === 'interrupted' || kind === 'disposed' || kind === 'aborted' ? 'info'
      : 'info'
    return { line, title: line, severity: sev }
  }
  const full = `turn ended: ${detail.detail}`
  const line = full.length > TURN_END_LINE_LIMIT
    ? full.slice(0, TURN_END_LINE_LIMIT - 1) + '…'
    : full
  return { line, title: full, severity: detail.severity }
}

// -- session.finished full line (audit §3 P0 #10 fix, 2026-07-17) -----------
//
// SessionFinishedNotification shape:
//   { sessionId, status: 'ok'|'error', reason?: TurnEndReason }
//
// Former rendering (renderer.js:5538) emitted only `session finished (<status>)`
// dropping reason.{message,step,code} on the floor. Fields §3 P0 #10 spec:
// expand to the same-shape one-liner used by turn/end so a researcher
// answering "why did this session die" reads the message + step at L0
// instead of chasing devtools drawer. Reuses `formatTurnEndLine` since the
// reason shape is byte-identical (TurnEndReason).
//
// @param {{status?: string, reason?: unknown}} params
// @returns {{line: string, title: string, severity: 'ok'|'error'|'warn'|'info'}}
function formatSessionFinishedLine(params) {
  const status = typeof params?.status === 'string' ? params.status : 'unknown'
  const reason = params?.reason
  // Ok path: no reason payload of interest; a bare status line is enough.
  if (status === 'ok') {
    const line = 'session finished (ok)'
    return { line, title: line, severity: 'ok' }
  }
  // Error/other status: pull the same detail formatter as turn/end.
  if (!reason || typeof reason !== 'object') {
    const line = `session finished (${status})`
    return { line, title: line, severity: status === 'error' ? 'error' : 'info' }
  }
  const inner = formatTurnEndLine(reason)
  // Strip the `turn ended: ` prefix inner adds and re-prefix with `session
  // finished (<status>): ` so the L0 reads as one clause. Fall back to the
  // untouched inner detail when the strip fails (unknown format).
  const stripped = inner.line.startsWith('turn ended: ')
    ? inner.line.slice('turn ended: '.length)
    : inner.line
  const fullStripped = inner.title.startsWith('turn ended: ')
    ? inner.title.slice('turn ended: '.length)
    : inner.title
  const line = `session finished (${status}): ${stripped}`
  const title = `session finished (${status}): ${fullStripped}`
  const severity = status === 'error' ? 'error' : inner.severity
  return { line, title, severity }
}

// -- assistant chunk finish reason (audit §3 P0 #9 fix, 2026-07-17) ---------
//
// FinishReasonMap:
//   'stop'         { kind: 'stop' }
//   'tool-calls'   { kind: 'tool-calls' }
//   'max-tokens'   { kind: 'max-tokens' }
//   'aborted'      { kind: 'aborted' }
//   'error'        { kind: 'error'; message: string; code?: string }
//
// Rides `assistant/chunk.chunk` shape `{ type: 'finish', reason: FinishReason }`
//. The chunk-level `finish` was previously
// unrendered — `assistant/message.usage.finish_reason` fed the Attributes-Usage
// group but no per-step badge showed at the trace-timeline level. Fields §3
// P0 #9 spec: L1 badge on step row (`stop / tool-calls / max-tokens / aborted
// / error`) so a reader scanning multi-step turns spots the max-tokens step
// without opening Attributes.
//
// Returns null for unknown / malformed inputs so the caller stays silent
// rather than painting a `[undefined]` chip.
//
// @param {unknown} reason
// @returns {{label: string, tone: 'ok'|'warn'|'error'|'info', title: string} | null}
function formatFinishReason(reason) {
  if (!reason || typeof reason !== 'object') return null
  const kind = typeof reason.kind === 'string' ? reason.kind : null
  if (!kind) return null
  switch (kind) {
    case 'stop':
      return { label: 'stop', tone: 'ok', title: 'finish: stop (model ended naturally)' }
    case 'tool-calls':
      return { label: 'tool-calls', tone: 'info', title: 'finish: tool-calls (waiting for tool results)' }
    case 'max-tokens':
      return { label: 'max-tokens', tone: 'warn', title: 'finish: max-tokens (hit output ceiling)' }
    case 'aborted':
      return { label: 'aborted', tone: 'info', title: 'finish: aborted' }
    case 'error': {
      const msg = typeof reason.message === 'string' && reason.message ? reason.message : ''
      const code = typeof reason.code === 'string' && reason.code ? ` [${reason.code}]` : ''
      const title = msg ? `finish: error — ${msg}${code}` : `finish: error${code}`
      return { label: 'error', tone: 'error', title }
    }
    default:
      // Plugin-merged FinishReason variant — surface the kind untouched so
      // the reader sees the extension, not a hidden fall-through.
      return { label: kind, tone: 'info', title: `finish: ${kind}` }
  }
}

// -- prompt/blocked ----------------------------------------------------------

/**
 * Extract the prompt-blocked card model. The whole `content` block array is
 * kept for the fold-out body; `text` is the joined text-only projection for
 * the always-visible summary line.
 *
 * @param {unknown} data event.data
 * @returns {{reason: string, text: string, source: string} | null}
 */
function foldPromptBlocked(data) {
  if (!data || typeof data !== 'object') return null
  const reason = typeof data.reason === 'string' && data.reason !== ''
    ? data.reason
    : '(no reason)'
  const text = joinContentText(data.content)
  const source = typeof data.source === 'string' ? data.source : 'user'
  return { reason, text, source }
}

// -- subagent.finished summary ----------------------------------------------

/**
 * `subagent.finished` notification `params` → optional summary card. When a
 * `lastAssistantMessage` is present we render the folded summary; when it is
 * missing (the runtime chose not to include it) we return `null` and let the
 * bland `subagent finished: …` system line renderer.js emits stand alone.
 *
 * `lastAssistantMessage` may arrive as a plain string or a `ContentBlock[]` —
 * the codepath in `packages/ui/jsonrpc/src/server.ts` mirrors the ReactLoop's
 * assembled message, which is `string | ContentBlock[]` at rest. Both are
 * normalized to text here.
 *
 * @param {unknown} params notification.params
 * @returns {{oneLine: string, full: string} | null}
 */
function summarizeSubagentFinished(params) {
  if (!params || typeof params !== 'object') return null
  const lam = params.lastAssistantMessage
  if (lam === undefined || lam === null) return null
  const full = typeof lam === 'string' ? lam : joinContentText(lam)
  if (full === '') return null
  const collapsed = full.replace(/\s+/g, ' ').trim()
  const oneLine = collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed
  return { oneLine, full }
}

// -- approval audit-row ------------------------------------------------------

/**
 * Given an `approval/asked` payload and its (optional) paired `approval/decided`
 * outcome, produce the muted audit row model. Called by the controller when it
 * sees an `approval/decided` — the ask alone doesn't yet have an outcome, and
 * an outcome without an ask is a defect we log rather than render.
 *
 * @param {object} asked event.data of `approval/asked` (may be null if not yet seen)
 * @param {object} decided event.data of `approval/decided`
 * @returns {{toolName: string, outcome: string, verb: string, reason: string | null, tone: 'ok'|'warn'|'error'} | null}
 */
function auditRowForApproval(asked, decided) {
  if (!decided || typeof decided !== 'object') return null
  const outcome = typeof decided.outcome === 'string' ? decided.outcome : 'unknown'
  const toolName = asked && typeof asked.toolName === 'string' ? asked.toolName : '(unknown tool)'
  const reason = asked && typeof asked.reason === 'string' && asked.reason !== '' ? asked.reason : null
  const verb = APPROVAL_VERB[outcome] || outcome
  const tone = APPROVAL_TONE[outcome] || 'warn'
  return { toolName, outcome, verb, reason, tone }
}

const APPROVAL_VERB = Object.freeze({
  'allowed-once': 'allowed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
})

const APPROVAL_TONE = Object.freeze({
  'allowed-once': 'ok',
  rejected: 'error',
  cancelled: 'warn',
  unavailable: 'warn',
})

// -- helpers -----------------------------------------------------------------

/**
 * Flatten a `ContentBlock[]` to plain text (or return the empty string). Mirrors
 * `renderer.js:textFromContentBlocks` but is kept pure and local so this
 * module remains DOM-free and independently testable.
 */
function joinContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('')
}

// -- classifyEvent -----------------------------------------------------------

/**
 * Runtime tag for the visibility-controller's dispatch — pure so the tests can
 * assert we bucket the right event types. `data` is a shallow reference to the
 * event's `data` field, never mutated.
 *
 * @param {{type: string, data?: any}} event a SessionEvent (or one of the
 *   subagent.* notification params re-boxed as a pseudo-event by the caller)
 */
function classifyEvent(event) {
  if (!event || typeof event !== 'object') return { kind: 'ignore' }
  switch (event.type) {
    case 'todo/write':      return { kind: 'todo', data: event.data }
    case 'prompt/blocked':  return { kind: 'prompt-blocked', data: event.data }
    case 'turn/end':        return { kind: 'turn-end', data: event.data }
    case 'approval/asked':  return { kind: 'approval-asked', data: event.data }
    case 'approval/decided':return { kind: 'approval-decided', data: event.data }
    case 'bash/sandbox-mode':  return { kind: 'sandbox-mode', data: event.data }
    case 'permission/preset':  return { kind: 'permission-preset', data: event.data }
    default:                return { kind: 'ignore' }
  }
}

// -- exports (dual: CJS + globalThis) ---------------------------------------

const api = Object.freeze({
  foldTodoList,
  formatTurnEndReason,
  formatTurnEndLine,
  formatSessionFinishedLine,
  formatFinishReason,
  foldPromptBlocked,
  summarizeSubagentFinished,
  auditRowForApproval,
  classifyEvent,
  joinContentText,
  TODO_STATUS_ICON,
  TODO_STATUS_LABEL,
})

if (typeof module !== 'undefined' && module.exports) module.exports = api
if (typeof globalThis !== 'undefined') globalThis.Visibility = api
})()
