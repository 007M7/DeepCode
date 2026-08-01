/**
 * Read-only interpretation of session-query lineage as durable subagent
 * children. The module owns no catalog state and does not consult Activation,
 * Agent-registry, continuation-manager, or provider state. A child's
 * descriptor distinguishes one-shot work from a continuable conversation.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from 'cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryService, SessionRecord } from '@deepseek-ai/dsh-session-query'
import type SubagentService from './index.ts'
import { SubagentError } from './error.ts'
import { foldSubagentDescriptor } from './descriptor.ts'

type SessionQueryRuntime = Pick<
  typeof import('@deepseek-ai/dsh-session-query'),
  'assertSessionHeadersCompatible' | 'SessionQueryError'
>

/**
 * One entry of a {@link listChildren} result in trace candidate order. A valid
 * descriptor produces a `child`, a per-child inspection failure produces a
 * `diagnostic`, and a descriptor-less ordinary child is omitted. Healthy rows
 * include a one-level, origin-classified descendant hint. Diagnostics are
 * transient query results, never session events or catalog state, and never
 * expose model-hidden descriptor content.
 */
export type SubagentListEntry =
  | {
    readonly kind: 'child'
    /** The durable child session id, stable across Activations. */
    readonly id: SessionId
    /**
     * Corpus snapshot activity: `running` means the logical record is live in
     * `ctx.sessions`; `inactive` means it exists only in persistence. Neither
     * encodes a durable outcome, and a continuable child may still reject
     * delivery as an ownership conflict.
     */
    readonly activity: 'running' | 'inactive'
    /** Whether a direct descendant has durable `origin: 'subagent'`. */
    readonly hasChildren: boolean
  } & (
    | {
      /** A terminal one-shot child. */
      readonly mode: 'one-shot'
      /** Optional durable creation label from the child's descriptor. */
      readonly label?: string
    }
    | {
      /** A resumable conversation. */
      readonly mode: 'continuable'
      /** Durable creation label from the child's descriptor. */
      readonly label: string
    }
  )
  | {
    readonly kind: 'diagnostic'
    /** The traced candidate's session id. */
    readonly id: SessionId
    /**
     * Why the candidate was omitted: `corrupt` for invalid surfaces, header
     * conflicts, or malformed/duplicated descriptors; `unsupported` for an
     * unknown descriptor version; `unavailable` when the child disappeared or
     * its per-child read hit a persistence failure.
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/**
 * Interpret one parent's direct session descendants as session-backed subagents
 * without loading or resuming an Agent.
 * @see {@link SubagentService.listChildren} for the public cancellation and
 *   failure contract.
 * @param ctx - context carrying the optional session-query service.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation.
 * @returns children and per-child diagnostics in stable trace order.
 * @throws {@link SubagentError} when session query is unavailable or
 *   the caller cancels the scan.
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): ReturnType<SubagentService['listChildren']> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new SubagentError(
      'listing subagents requires session query (load a dsh-session-query backend)',
      'SUBAGENT_CONTROL_SESSION_QUERY_UNAVAILABLE',
    )
  }
  assertListingNotCancelled(signal)
  // Keep runtime values behind the listing-only boundary so ordinary
  // subagent imports and control operations do not evaluate the optional peer.
  const queryRuntime: SessionQueryRuntime = await import('@deepseek-ai/dsh-session-query')
  assertListingNotCancelled(signal)
  const trace = await runListingQuery(
    () => query.traceSession(parentSessionId, signal),
    signal,
  )
  const entries: SubagentListEntry[] = []
  for (const node of trace.descendants) {
    const hasChildren = node.descendants.some(
      descendant => descendant.session.header.origin === 'subagent',
    )
    const entry = await inspectChild(
      query, queryRuntime, parentSessionId, node.session, hasChildren, signal,
    )
    // Cancellation can race the inspection's last checkpoint or diagnostic
    // mapping; do not return success or begin another candidate afterward.
    assertListingNotCancelled(signal)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/** Interpret one traced direct-child record as a child, diagnostic, or exclusion. */
async function inspectChild(
  query: SessionQueryService,
  queryRuntime: SessionQueryRuntime,
  parentSessionId: SessionId,
  candidate: SessionRecord,
  hasChildren: boolean,
  signal?: AbortSignal,
): Promise<SubagentListEntry | undefined> {
  const childId = candidate.header.id
  try {
    const records = await runListingQuery(() => query.listEvents(childId), signal)
    // Only the child's own suffix: a fork seed may replay an ancestor's
    // descriptor without making the fork itself a subagent.
    const seedLength = candidate.header.seedLength ?? 0
    const descriptorSeqs = records
      .filter(record => record.seq >= seedLength && record.type === 'subagent/descriptor')
      .map(record => record.seq)
    if (descriptorSeqs.length === 0) return undefined
    if (descriptorSeqs.length > 1) {
      return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
    }
    // The length-one branch proves this exact-read sequence exists.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const seq = descriptorSeqs[0]!
    const window = await runListingQuery(
      () => query.readEvent({ sessionId: childId, seq }, signal),
      signal,
    )
    queryRuntime.assertSessionHeadersCompatible(window.session, candidate.header)
    if (window.session.parentSession !== parentSessionId || window.target.type !== 'subagent/descriptor') {
      return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
    }
    let descriptor: ReturnType<typeof foldSubagentDescriptor>
    try {
      descriptor = foldSubagentDescriptor([window.target])
    } catch {
      return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
    }
    if (descriptor === undefined) {
      return { kind: 'diagnostic', id: childId, reason: 'unsupported' }
    }
    const activity = candidate.live ? 'running' : 'inactive'
    if (descriptor.mode === 'one-shot') {
      return {
        kind: 'child',
        id: childId,
        mode: descriptor.mode,
        ...descriptor.label !== undefined ? { label: descriptor.label } : {},
        activity,
        hasChildren,
      }
    }
    return {
      kind: 'child', id: childId, mode: descriptor.mode, label: descriptor.label,
      activity, hasChildren,
    }
  } catch (error: unknown) {
    const reason = perChildDiagnosticReason(error, queryRuntime.SessionQueryError)
    if (reason === undefined) throw error
    return { kind: 'diagnostic', id: childId, reason }
  }
}

/** Stop a listing scan at its next cancellation checkpoint. */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}

/**
 * Run one session-query operation between cancellation checkpoints. Query
 * implementations may reject with their own abort error after observing the
 * forwarded signal; cancellation remains a stable subagent failure.
 */
async function runListingQuery<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  assertListingNotCancelled(signal)
  try {
    const result = await operation()
    assertListingNotCancelled(signal)
    return result
  } catch (error: unknown) {
    assertListingNotCancelled(signal)
    throw error
  }
}

/**
 * Map a per-child query failure to a fixed diagnostic. Configuration errors
 * and unrecognized failures remain operation failures.
 */
function perChildDiagnosticReason(
  error: unknown,
  SessionQueryError: SessionQueryRuntime['SessionQueryError'],
): 'corrupt' | 'unavailable' | undefined {
  if (!(error instanceof SessionQueryError)) return undefined
  switch (error.code) {
    case 'SESSION_QUERY_SESSION_NOT_FOUND':
    case 'SESSION_QUERY_EVENT_NOT_FOUND':
    case 'SESSION_QUERY_PERSISTENCE_FAILED':
      return 'unavailable'
    case 'SESSION_QUERY_INVALID_SURFACE':
    case 'SESSION_QUERY_SOURCE_CONFLICT':
      return 'corrupt'
    default:
      return undefined
  }
}
