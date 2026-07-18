// subagent-lineage.js — live subagent event router.
//
// The kernel wire (, audited
// 2026-07-17 against deepseek-harness-dev @ fa2065872) fans out three
// notifications for a subagent life-cycle:
//
//   session.event       — sessionId = <child session id> for every child
//                         assistant/chunk, tool/call, tool/result, etc.
//   subagent.started    — { parentSessionId, childSessionId }
//   subagent.finished   — { parentSessionId?, childSessionId, status,
//                           stopReason, lastAssistantMessage? }
//
// Nothing on the wire says "route this child event under the parent's
// spawn_agent tool row". The renderer used to swallow child session.event
// notifications entirely (they didn't match state.activeSessionId — see
// renderer.js onSessionEvent early return at ~3450). This module is the
// pure lineage bookkeeper that resolves the routing:
//
//   * `registerStarted({ parentSessionId, childSessionId, parentCallId? })`
//     stores the mapping and returns the row to render (RUNNING pill).
//   * `resolveChild(sessionId)` — the fast lookup onSessionEvent runs on
//     every incoming notification. Returns the lineage record or null.
//   * `markFinished(childSessionId, patch)` — flip running=false and
//     merge status/lastAssistantMessage so the card can lock its DONE
//     state without re-building.
//   * `spawnAnchorFor(parentSessionId, meta)` — heuristic that picks the
//     most recent spawn_agent tool/call id for a given parent-session
//     meta record. Broken out so tests can pin the exact rule.
//
// The bookkeeper does NOT touch the DOM — callers hand in DOM handles via
// `attachCard(childSessionId, { cardEl, bodyEl })` after they've built the
// live inline trace, so this module stays a pure map.
//
// Design note: the store keeps a Map keyed on childSessionId (unique per
// invocation). subagent.started may repeat if session/list refresh
// re-plays the notification — dedupe by returning the existing record
// unchanged rather than clobbering the DOM handles.

'use strict'

function createSubagentLineage() {
  const store = new Map()

  function registerStarted({ parentSessionId, childSessionId, parentCallId }) {
    if (!childSessionId) return null
    const existing = store.get(childSessionId)
    if (existing) {
      // Refresh anchor if the caller learned it after the first started
      // notification arrived (heuristic look-up can race the notification).
      if (parentCallId && !existing.parentCallId) existing.parentCallId = parentCallId
      existing.running = true
      return existing
    }
    const rec = {
      parentSessionId: parentSessionId || null,
      childSessionId,
      parentCallId: parentCallId || null,
      running: true,
      cardEl: null,
      bodyEl: null,
      // Ordered log of child events routed through this record — kept so
      // a later selfie or debug drawer can inspect what streamed in.
      childEvents: [],
      status: 'running',
      // viz-coverage-matrix §5 P0-6: stopReason from subagent.finished
      // wire (server.ts:114-122). Set by markFinished; null while running.
      stopReason: null,
      lastAssistantMessage: null,
    }
    store.set(childSessionId, rec)
    return rec
  }

  function attachCard(childSessionId, handles) {
    const rec = store.get(childSessionId)
    if (!rec || !handles) return null
    if (handles.cardEl) rec.cardEl = handles.cardEl
    if (handles.bodyEl) rec.bodyEl = handles.bodyEl
    return rec
  }

  function resolveChild(sessionId) {
    if (!sessionId) return null
    return store.get(sessionId) || null
  }

  function pushChildEvent(childSessionId, event) {
    const rec = store.get(childSessionId)
    if (!rec) return null
    rec.childEvents.push(event)
    return rec
  }

  function markFinished(childSessionId, patch = {}) {
    const rec = store.get(childSessionId)
    if (!rec) return null
    rec.running = false
    if (patch.status) rec.status = patch.status
    if (patch.lastAssistantMessage) rec.lastAssistantMessage = patch.lastAssistantMessage
    // viz-coverage-matrix §5 P0-6: absorb stopReason so downstream renderers
    // (rail tooltip, sidebar) can promote it. Guard against non-string types
    // so a wire quirk doesn't propagate `[object Object]` into a title=.
    if (typeof patch.stopReason === 'string') rec.stopReason = patch.stopReason
    return rec
  }

  function forget(childSessionId) {
    store.delete(childSessionId)
  }

  function entries() {
    return Array.from(store.values())
  }

  function size() {
    return store.size
  }

  return {
    registerStarted,
    attachCard,
    resolveChild,
    pushChildEvent,
    markFinished,
    forget,
    entries,
    size,
  }
}

// spawn_agent tool/call name lives in the kernel tools/subagent registration
// (packages/core/tools). We match by exact name — kernel-side rename would
// need to update this literal.
const SPAWN_TOOL_NAMES = new Set(['spawn_agent', 'subagent.spawn', 'spawn'])

function isSpawnAgentToolCall(event) {
  if (!event || event.type !== 'tool/call') return false
  const data = event.data || event
  const name = data && data.name
  return typeof name === 'string' && SPAWN_TOOL_NAMES.has(name)
}

// Heuristic anchor lookup for the live path. Real wire's subagent.started
// notification carries only parent/child sessionId (server.ts:89-96); the
// renderer maintains a `meta.lastSpawnCallId` per parent session, updated
// on every spawn_agent tool/call. When subagent.started arrives, we adopt
// that most-recent id as the anchor.
//
// Fixture wire (§2.6) can pass `parentCallId` explicitly; the caller
// prefers that when set. This function is only consulted when the caller
// has no explicit anchor to use.
function spawnAnchorFor(parentSessionMeta) {
  if (!parentSessionMeta) return null
  return parentSessionMeta.lastSpawnCallId || null
}

const subagentLineageApi = {
  createSubagentLineage,
  isSpawnAgentToolCall,
  spawnAnchorFor,
  SPAWN_TOOL_NAMES,
}

if (typeof module !== 'undefined' && module.exports) module.exports = subagentLineageApi
if (typeof window !== 'undefined') window.__dshSubagentLineage = subagentLineageApi
