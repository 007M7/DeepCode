// workflow-live-model.js — fold the on-wire `workflow.event` train into the
// aggregate {name, kind, steps[]} shape that workflow-view.buildWorkflowCard
// draws.
//
// Why a separate model? The wire (runtime commit dd29d8631, `workflow.event`
// notification) ships INCREMENTAL lifecycle frames keyed by `runId`:
//
//   workflow/start        → { runId, meta:{name,description} }
//   workflow/phase        → { runId, meta, payload: <title:string> }
//   workflow/log          → { runId, meta, payload: <message:string> }
//   workflow/agent-start  → { runId, meta, payload: { seq, label, phase?, childId } }
//   workflow/agent-end    → { runId, meta, payload: { seq, label, phase?, childId, outcome } }
//   workflow/end          → { runId, meta, payload: { stopReason, error?, agentsStarted } }
//
// but buildWorkflowCard wants an AGGREGATE object with a `steps[]` list. The
// wire also carries no `kind` discriminator (seq/dag/iter/…) and no
// per-agent adjacency — only a flat run of agents keyed by `seq`. So the
// honest projection is the `seq` (linear stepper) family: each workflow-agent
// becomes one step, ordered by its `seq`, `running` on agent-start and
// `done`/`failed` on agent-end. Phases and log lines are folded onto the
// active step's meta so the demo still narrates progress without inventing a
// graph shape the wire never described.
//
// This module is the data structure ONLY — no DOM, no wire subscription. The
// renderer owns "subscribe to the notification, feed events here, re-render
// the card"; this file just accumulates run state so the fold semantics are
// lockable under `node --test` without an Electron harness.
//
// Shape:
//   runs: Map<runId, { runId, name, description, steps: Map<seq, step>,
//                      logs: string[], phase: string|null,
//                      stopReason: string|null, error: unknown,
//                      done: boolean, order: number }>
//   step: { id, name, status: 'running'|'done'|'failed'|'pending',
//           phase?, seq, output? }
//
// `toCard(runId)` projects one run into the `{ name, kind:'seq', steps[] }`
// object buildWorkflowCard consumes; the renderer passes that straight through
// with `{ isLive: true }` so the card wears the live chip, not the mock chip.

'use strict'

// The six wire kinds, mirrored from WorkflowEventNotification.WorkflowEventKind
// (protocol.ts). Anything else is dropped — additive-tolerant per the wire
// contract ("hosts must fall through unknown kinds").
const WORKFLOW_EVENT_KINDS = new Set([
  'workflow/start',
  'workflow/phase',
  'workflow/log',
  'workflow/agent-start',
  'workflow/agent-end',
  'workflow/end',
])

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Map a workflow-agent `outcome` (engine vocabulary) onto the step status the
// card renderer understands. Anything non-completed that isn't an explicit
// failure stays 'done' so a settled agent never looks stuck.
function statusForOutcome(outcome) {
  if (outcome === 'failed' || outcome === 'error' || outcome === 'aborted' || outcome === 'cancelled') {
    return 'failed'
  }
  return 'done'
}

function createWorkflowLiveModel() {
  /** @type {Map<string, any>} */
  const runs = new Map()
  let _order = 0

  function ensureRun(runId, meta) {
    let run = runs.get(runId)
    if (!run) {
      run = {
        runId,
        name: (meta && typeof meta.name === 'string') ? meta.name : '',
        description: (meta && typeof meta.description === 'string') ? meta.description : '',
        steps: new Map(),
        logs: [],
        phase: null,
        stopReason: null,
        error: null,
        done: false,
        order: (_order += 1),
      }
      runs.set(runId, run)
    } else if (meta) {
      // A later frame may carry a better name/description than start did.
      if (!run.name && typeof meta.name === 'string') run.name = meta.name
      if (!run.description && typeof meta.description === 'string') run.description = meta.description
    }
    return run
  }

  // Accept one notification param object ({ kind, runId, meta, payload }).
  // Returns the runId the event landed on, or null when the frame is
  // malformed / unknown-kind (so the caller can no-op — no card, no error).
  function apply(notif) {
    if (!isPlainObject(notif)) return null
    const { kind } = notif
    if (!WORKFLOW_EVENT_KINDS.has(kind)) return null
    const runId = (notif.runId === undefined || notif.runId === null) ? '' : String(notif.runId)
    if (!runId) return null
    const meta = isPlainObject(notif.meta) ? notif.meta : null
    const run = ensureRun(runId, meta)
    const payload = notif.payload

    switch (kind) {
      case 'workflow/start':
        // Identity only; ensureRun already captured name/description.
        break
      case 'workflow/phase':
        if (typeof payload === 'string') run.phase = payload
        else if (isPlainObject(payload) && typeof payload.title === 'string') run.phase = payload.title
        break
      case 'workflow/log': {
        const msg = typeof payload === 'string'
          ? payload
          : (isPlainObject(payload) && typeof payload.message === 'string' ? payload.message : null)
        if (msg != null) run.logs.push(msg)
        break
      }
      case 'workflow/agent-start': {
        if (!isPlainObject(payload)) break
        const seq = Number(payload.seq)
        if (!Number.isFinite(seq)) break
        const id = payload.childId != null ? String(payload.childId) : `agent-${seq}`
        run.steps.set(seq, {
          id,
          seq,
          name: typeof payload.label === 'string' && payload.label ? payload.label : id,
          status: 'running',
          phase: typeof payload.phase === 'string' ? payload.phase : (run.phase || undefined),
          output: undefined,
        })
        break
      }
      case 'workflow/agent-end': {
        if (!isPlainObject(payload)) break
        const seq = Number(payload.seq)
        if (!Number.isFinite(seq)) break
        const existing = run.steps.get(seq)
        const id = payload.childId != null ? String(payload.childId) : (existing ? existing.id : `agent-${seq}`)
        const step = existing || { id, seq, name: id, phase: undefined, output: undefined }
        step.status = statusForOutcome(payload.outcome)
        if (typeof payload.label === 'string' && payload.label) step.name = payload.label
        if (payload.outcome != null) step.output = String(payload.outcome)
        run.steps.set(seq, step)
        break
      }
      case 'workflow/end':
        run.done = true
        if (isPlainObject(payload)) {
          if (typeof payload.stopReason === 'string') run.stopReason = payload.stopReason
          if (payload.error != null) run.error = payload.error
        }
        break
      default:
        return null
    }
    return runId
  }

  function getRun(runId) {
    return runs.get(String(runId)) || null
  }

  function hasRun(runId) {
    return runs.has(String(runId))
  }

  // Project a run into the aggregate card model buildWorkflowCard consumes.
  // Steps are ordered by their engine `seq` (stable, monotonic). Returns null
  // for an unknown run.
  function toCard(runId) {
    const run = runs.get(String(runId))
    if (!run) return null
    const steps = Array.from(run.steps.values())
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: s.status,
        ...(s.output ? { output: s.output } : {}),
        ...(s.phase ? { phase: s.phase } : {}),
      }))
    return {
      name: run.name || run.runId,
      kind: 'seq',
      steps,
      // Carried through for callers that want to surface run-level state
      // (chip label, footer). buildWorkflowCard ignores unknown keys.
      _live: true,
      _runId: run.runId,
      _phase: run.phase,
      _logs: run.logs.slice(),
      _done: run.done,
      _stopReason: run.stopReason,
    }
  }

  function forget(runId) {
    runs.delete(String(runId))
  }

  function clear() {
    runs.clear()
  }

  return { apply, getRun, hasRun, toCard, forget, clear, runs }
}

// Dual export — module.exports for node --test, window for renderer.
const workflowLiveModelApi = { createWorkflowLiveModel, WORKFLOW_EVENT_KINDS, statusForOutcome }
if (typeof module !== 'undefined' && module.exports) module.exports = workflowLiveModelApi
if (typeof window !== 'undefined') window.__dshWorkflowLiveModel = workflowLiveModelApi
