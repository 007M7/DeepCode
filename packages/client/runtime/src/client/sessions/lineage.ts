// flattenLineage: summaries -> flat list with lineage indentation (pure function).
// The input order is authoritative; lineage only makes each child adjacent to its parent.
// Orphaned lineage degrades to root level; cycles fail soft and emit as roots.

import type { SessionId, SessionSummary } from '@deepseek-ai/dsh-client-connection/client'

/** Host list summary enriched with the latest mux-projected durable title. */
export interface TitledSessionSummary extends SessionSummary {
  title?: string
}

/** One flattened session-list row (summary + lineage indent depth + live pending-approval bit). */
export interface SessionListEntry {
  sessionId: SessionId
  title?: string
  updatedAt: number
  running: boolean
  /** Empty-log bit mirrored from the summary; lists hide blank sessions (filtering stays with the consumer). */
  blank: boolean
  parentSessionId?: SessionId
  cwd?: string
  /** An approval question is pending on this session (mux-frame derived; the sidebar's amber dot). */
  waitingApproval: boolean
  /** Lineage indent depth: root = 0; the UI just multiplies by the indent width. */
  depth: number
}

/**
 * Summaries -> flat list with lineage indentation. Root and sibling order
 * follows the established input order; this projection never re-sorts a
 * hydrated list from mutable timestamps.
 * @param summaries - the host's session.list items.
 * @param waitingApproval - sessions with a pending approval question (manager-owned live fact; absent = false).
 * @returns display rows in render order.
 */
export function flattenLineage(summaries: readonly TitledSessionSummary[], waitingApproval?: ReadonlySet<SessionId>): SessionListEntry[] {
  const byId = new Map<SessionId, TitledSessionSummary>()
  for (const s of summaries) byId.set(s.sessionId, s)

  const children = new Map<SessionId, TitledSessionSummary[]>()
  const roots: TitledSessionSummary[] = []
  for (const s of summaries) {
    if (s.parentSessionId !== undefined && byId.has(s.parentSessionId)) {
      const list = children.get(s.parentSessionId) ?? []
      list.push(s)
      children.set(s.parentSessionId, list)
    } else {
      roots.push(s) // root, or an orphan whose parent is absent from summaries (degrade to root, never drop)
    }
  }

  const out: SessionListEntry[] = []
  const visited = new Set<SessionId>()
  const walk = (s: TitledSessionSummary, depth: number): void => {
    if (visited.has(s.sessionId)) {
      console.warn(`[web-runtime] lineage cycle at ${s.sessionId}; emitting as root`)
      return
    }
    visited.add(s.sessionId)
    out.push({ ...s, waitingApproval: waitingApproval?.has(s.sessionId) ?? false, depth })
    const kids = children.get(s.sessionId)
    if (kids === undefined) return
    for (const kid of kids) walk(kid, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  // Cycle members (unreachable from any root): emit as roots so no entry is lost.
  for (const s of summaries) {
    if (!visited.has(s.sessionId)) walk(s, 0)
  }
  return out
}
