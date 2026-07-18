// Annotation — pure model. Trajectory-level scoring + per-turn 5-dim scoring
// + task-category tagging + JSONL export projection. Renderer (annotation-
// panel.js) drives the DOM around this; the model owns the shape math so
// tests catch drifts before they land in the export contract.
//
// Shape lock (per docs/design-refs/rl-workflow-needs.md §6 G13/G16, memory
// rl-rubric-annotation-plan §2):
//
//   sessionAnnotation = {
//     sessionId, updatedAt,
//     annotator?: string,                        // who wrote this record;
//                                                // demo tier defaults to
//                                                // 'local-user' at write time,
//                                                // G16 wire will replace w/
//                                                // real identity
//     overall: 'bad'|'ok'|'good'|null,          // required for export
//     taskGroup: <group id>|null,
//     taskSubtask: <subtask id>|null,
//     turnScores: [                              // per-assistant-turn
//       { turnIndex, updatedAt,                  // per-turn stamp — feeds
//                                                // #205 Feedback tab "time"
//                                                // column with per-turn
//                                                // precision (session-level
//                                                // updatedAt is a rollup)
//         dims: {feedback-understanding:1-5, fix-effectiveness:1-5,
//                no-regression:1-5, over-correction:1-5,
//                convergence:1-5},
//         note?: string, priorFeedback?: string }
//     ],
//     notes?: string,
//   }
//
// Consumer contract note (#205 Feedback tab, lane-trace-triview): read the
// stored record via `window.__dshAnnotation.read(sessionId)` (never touch
// `_state`). Push updates arrive via `dsh:annotation-updated` CustomEvent
// on document with detail `{sessionId, ann}`. Dim ids stay kebab-case at
// the model layer — triview adapts on its side if wire wants snake_case.
//
// Export shape (jsonl-to-html compatible — one JSONL row per session):
//   {
//     messages: [{role, content}, ...],
//     reasoning_content?: string,
//     tool_calls?: [...],
//     annotation-fields: {
//       overall: 'bad'|'ok'|'good',
//       task_group: <id>,
//       task_subtask: <id>,
//       turn_scores: [{turn_index, ...dims, note?, prior_feedback?}],
//       annotator?: <id>,
//       exported_at: <ms>
//     }
//   }
//
// Second format = triple projection (state, action, reward):
//   { state: <messages so far>, action: <assistant turn text>, reward: <0-1>,
//     turn_index, session_id }
// One row per assistant turn; reward is the mean of the 5 dims scaled to 0-1.

'use strict'

// Load the shared rubrics model — under `<script>` it is on window; under
// `node --test` it's a `require`. Same pattern used by growth-v2.js.
const R = (typeof window !== 'undefined' && window.__dshRubricsModel)
  ? window.__dshRubricsModel
  : require('./rubrics-model.js')

const OVERALL_VERDICTS = ['bad', 'ok', 'good']
const DIM_MIN = 1
const DIM_MAX = 5

function clampDim(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n < DIM_MIN) return DIM_MIN
  if (n > DIM_MAX) return DIM_MAX
  return Math.round(n)
}

// Build a blank session annotation record — used when the user opens the
// drawer for a session for the first time.
function blankAnnotation(sessionId) {
  return {
    sessionId: String(sessionId || ''),
    updatedAt: 0,
    annotator: null,
    overall: null,
    taskGroup: null,
    taskSubtask: null,
    turnScores: [],
    notes: '',
  }
}

// Set the overall verdict (bad/ok/good) and stamp updatedAt.
function setOverall(ann, verdict, now = Date.now()) {
  const next = { ...ann }
  if (verdict == null) next.overall = null
  else if (OVERALL_VERDICTS.includes(verdict)) next.overall = verdict
  else return ann
  next.updatedAt = now
  return next
}

// Set task tag (group + subtask). Passing `null` on both clears.
function setTaskTag(ann, groupId, subtaskId, now = Date.now()) {
  const cat = groupId ? R.getCategory(groupId) : null
  if (groupId && !cat) return ann
  if (subtaskId && cat && !cat.subtasks.includes(subtaskId)) return ann
  return { ...ann, taskGroup: groupId || null, taskSubtask: subtaskId || null, updatedAt: now }
}

// Write a per-turn score. Any missing dim keeps its previous value; passing
// null for a dim clears it. Stamps a per-turn updatedAt so #205's Feedback
// tab can render precise per-row times without falling back to the
// session-level rollup.
//
// The optional `opts.dims` — a list of dim specs (normalizeDimSpec shape) —
// is what the caller uses to validate typed rubric dimensions (continuous
// / categorical / boolean). When omitted, we fall back to the 5-fixed
// MULTI_TURN_DIMENSIONS list so legacy 1–5 button rows and existing
// stored records round-trip unchanged. Unknown-to-spec dims drop; values
// that don't match the type also drop, so the store never accumulates
// junk.
function setTurnScore(ann, turnIndex, patch, now = Date.now(), opts = null) {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) return ann
  const list = Array.isArray(ann.turnScores) ? ann.turnScores.slice() : []
  const idx = list.findIndex(t => t.turnIndex === turnIndex)
  const prev = idx >= 0 ? list[idx] : { turnIndex, updatedAt: 0, dims: {}, note: '', priorFeedback: '' }
  const dims = { ...prev.dims }
  const patchDims = (patch && patch.dims) || {}
  const specList = (opts && Array.isArray(opts.dims) && opts.dims.length)
    ? opts.dims
    : R.MULTI_TURN_DIMENSIONS
  const specById = new Map()
  for (const d of specList) {
    const spec = R.normalizeDimSpec ? R.normalizeDimSpec(d) : d
    if (spec) specById.set(spec.id, spec)
  }
  for (const key of Object.keys(patchDims)) {
    const spec = specById.get(key)
    if (!spec) continue                       // unknown dim → drop
    const raw = patchDims[key]
    if (raw == null) { delete dims[key]; continue }
    // Prefer the primitive-aware clamper when available; fall back to
    // the legacy 1–5 numeric clamp for records that predate typed dims.
    const clamped = R.clampDimValue
      ? R.clampDimValue(spec, raw)
      : clampDim(raw)
    if (clamped === undefined) continue       // unrepresentable → drop
    dims[key] = clamped
  }
  const merged = {
    turnIndex,
    updatedAt: now,
    dims,
    note: 'note' in (patch || {}) ? String(patch.note || '') : prev.note,
    priorFeedback: 'priorFeedback' in (patch || {}) ? String(patch.priorFeedback || '') : prev.priorFeedback,
  }
  if (idx >= 0) list[idx] = merged
  else list.push(merged)
  list.sort((a, b) => a.turnIndex - b.turnIndex)
  return { ...ann, turnScores: list, updatedAt: now }
}

// How complete is a session's annotation? Used to render the "annotated
// N/M turns" chip on Recent rows. Returns { annotatedTurns, totalTurns,
// hasOverall, complete }.
//
// The optional `opts.dims` list controls what "fully scored" means — a
// turn counts as annotated iff every dim in the list has a stored value.
// When omitted, falls back to the 5-fixed MULTI_TURN_DIMENSIONS so
// existing callers work unchanged.
function completeness(ann, totalTurns, opts = null) {
  const list = Array.isArray(ann && ann.turnScores) ? ann.turnScores : []
  const specList = (opts && Array.isArray(opts.dims) && opts.dims.length)
    ? opts.dims
    : R.MULTI_TURN_DIMENSIONS
  const dimIds = specList.map(d => d.id)
  const annotatedTurns = list.filter(t => {
    if (!t || !t.dims) return false
    for (const id of dimIds) if (!(id in t.dims)) return false
    return true
  }).length
  const hasOverall = !!(ann && ann.overall)
  const total = Math.max(0, Number(totalTurns) || 0)
  return {
    annotatedTurns,
    totalTurns: total,
    hasOverall,
    complete: hasOverall && (total === 0 || annotatedTurns >= total),
  }
}

// Given a list of session events (chat/quick-chat shape used elsewhere in
// the demo), enumerate assistant turns — the units the 5-dim rubric scores.
// Each entry carries: { turnIndex, priorFeedback (text of the preceding
// user message), snippet (first ~120 chars of the assistant text) }.
function enumerateAssistantTurns(events) {
  if (!Array.isArray(events)) return []
  const out = []
  let lastUser = ''
  let assistantIdx = -1
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const role = ev.role
      || (ev.type === 'user/message' ? 'user'
        : ev.type === 'assistant/message' ? 'assistant'
        : null)
    if (role === 'user') {
      lastUser = String(ev.content || ev.text || '')
    } else if (role === 'assistant') {
      assistantIdx++
      const text = String(ev.content || ev.text || '')
      out.push({
        turnIndex: assistantIdx,
        priorFeedback: lastUser,
        snippet: text.length > 120 ? text.slice(0, 117) + '…' : text,
      })
    }
  }
  return out
}

// Estimate export size for the drawer preview — a rough count that shows
// the user "your file will be about NN KB" before saving. The real writer
// pretty-prints per session so we serialize a projection.
function estimateExportSize(rows) {
  let total = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    total += JSON.stringify(row).length + 1  // +1 for the newline
  }
  return total  // bytes
}

// Project a session (events + annotation) into a single jsonl-to-html row.
// Returns null if the session has no messages (nothing to export).
//
// When `opts.dims` (a normalized dim-spec list) is passed, the row also
// carries `annotation-fields.dim_types`: `{ id: 'continuous'|... }` — the
// six-field LangSmith FeedbackSchema slice we adopted (key/score/value/
// type/min/max, plus enum values / bool labels where applicable). This
// gives downstream consumers the same metadata the LangSmith export ships
// with, so a categorical `verdict='good'` isn't accidentally treated as
// a numeric score.
function projectJsonlRow(events, ann, opts = {}) {
  if (!Array.isArray(events) || !events.length) return null
  const messages = []
  const toolCalls = []
  let reasoning = ''
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const role = ev.role
      || (ev.type === 'user/message' ? 'user'
        : ev.type === 'assistant/message' ? 'assistant'
        : ev.type === 'tool/call' ? 'tool'
        : null)
    if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: String(ev.content || ev.text || '') })
    } else if (role === 'tool') {
      toolCalls.push({
        id: ev.callId || ev.id || '',
        name: ev.tool || ev.name || '',
        arguments: ev.arguments || ev.args || {},
      })
    }
    if (ev.reasoning_content) reasoning += String(ev.reasoning_content)
  }
  if (!messages.length) return null
  const row = { messages }
  if (reasoning) row.reasoning_content = reasoning
  if (toolCalls.length) row.tool_calls = toolCalls
  row['annotation-fields'] = {
    overall: ann && ann.overall ? ann.overall : null,
    task_group: ann && ann.taskGroup ? ann.taskGroup : null,
    task_subtask: ann && ann.taskSubtask ? ann.taskSubtask : null,
    turn_scores: (ann && Array.isArray(ann.turnScores) ? ann.turnScores : []).map(t => ({
      turn_index: t.turnIndex,
      ...t.dims,
      updated_at: t.updatedAt || undefined,
      note: t.note || undefined,
      prior_feedback: t.priorFeedback || undefined,
    })),
  }
  // Dim-type metadata slice (LangSmith FeedbackSchema parity). Only emit
  // when opts.dims is supplied — legacy 5-fixed-dim exports remain
  // untouched so consumers built for that shape don't see a new key.
  if (opts && Array.isArray(opts.dims) && opts.dims.length && R.normalizeDimSpec) {
    const dimTypes = {}
    for (const raw of opts.dims) {
      const spec = R.normalizeDimSpec(raw)
      if (!spec) continue
      const entry = { key: spec.id, type: spec.type }
      if (spec.type === 'continuous') { entry.min = spec.min; entry.max = spec.max }
      else if (spec.type === 'categorical') { entry.values = spec.values.slice() }
      else if (spec.type === 'boolean') { entry.labels = { ...spec.labels } }
      dimTypes[spec.id] = entry
    }
    row['annotation-fields'].dim_types = dimTypes
  }
  const annotatorId = opts.annotator || (ann && ann.annotator) || null
  if (annotatorId) row['annotation-fields'].annotator = String(annotatorId)
  row['annotation-fields'].exported_at = Number(opts.now) || Date.now()
  return row
}

// Second format: one row per assistant turn as (state, action, reward).
// When `opts.dims` (typed spec list) is passed, reward = mean of the
// per-dim 0–1 normalizations (continuous scaled, categorical enum-indexed,
// boolean → 1/0). Without opts.dims, falls back to the legacy 1–5 average
// scaled to 0–1 so old callers keep the same reward math.
function projectTripleRows(events, ann, sessionId, opts = null) {
  if (!Array.isArray(events) || !events.length) return []
  const rows = []
  const scoreByTurn = new Map()
  for (const t of (ann && ann.turnScores) || []) scoreByTurn.set(t.turnIndex, t)
  const runningMessages = []
  let assistantIdx = -1
  const specList = (opts && Array.isArray(opts.dims) && opts.dims.length)
    ? opts.dims.map(d => R.normalizeDimSpec ? R.normalizeDimSpec(d) : d).filter(Boolean)
    : null
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const role = ev.role
      || (ev.type === 'user/message' ? 'user'
        : ev.type === 'assistant/message' ? 'assistant'
        : null)
    if (role === 'user') {
      runningMessages.push({ role: 'user', content: String(ev.content || ev.text || '') })
    } else if (role === 'assistant') {
      assistantIdx++
      const state = runningMessages.slice()
      const action = String(ev.content || ev.text || '')
      const t = scoreByTurn.get(assistantIdx)
      let reward = null
      if (t && t.dims) {
        if (specList) {
          const parts = []
          for (const spec of specList) {
            const r = R.normalizeReward(spec, t.dims[spec.id])
            if (r != null) parts.push(r)
          }
          if (parts.length) {
            const mean = parts.reduce((s, v) => s + v, 0) / parts.length
            reward = Math.round(mean * 1000) / 1000
          }
        } else {
          const vals = R.MULTI_TURN_DIMENSIONS.map(d => t.dims[d.id]).filter(v => Number.isFinite(v))
          if (vals.length) {
            const mean = vals.reduce((s, v) => s + v, 0) / vals.length
            reward = Math.round(((mean - DIM_MIN) / (DIM_MAX - DIM_MIN)) * 1000) / 1000
          }
        }
      }
      rows.push({
        session_id: String(sessionId || ''),
        turn_index: assistantIdx,
        state,
        action,
        reward,
      })
      runningMessages.push({ role: 'assistant', content: action })
    }
  }
  return rows
}

// Serialize a list of JSONL rows to a single string, newline-terminated,
// suitable for `writeFileSync`. `format` is 'jsonl' (default) or 'ndjson'.
function serializeJsonl(rows) {
  const lines = []
  for (const row of Array.isArray(rows) ? rows : []) lines.push(JSON.stringify(row))
  return lines.join('\n') + (lines.length ? '\n' : '')
}

const annotationModelApi = {
  OVERALL_VERDICTS,
  DIM_MIN,
  DIM_MAX,
  blankAnnotation,
  setOverall,
  setTaskTag,
  setTurnScore,
  completeness,
  enumerateAssistantTurns,
  estimateExportSize,
  projectJsonlRow,
  projectTripleRows,
  serializeJsonl,
}

if (typeof module !== 'undefined' && module.exports) module.exports = annotationModelApi
if (typeof window !== 'undefined') window.__dshAnnotationModel = annotationModelApi
