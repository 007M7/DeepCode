/**
 * Read-only enumeration of one parent's durable subagent children straight
 * from the live session store and optional session persistence — no query
 * seam. Candidates are the live-preferred merge of both listings filtered to
 * durable `origin: 'subagent'` under the parent; each child's mode/label is
 * the registered `subagent` projection unit's value, served from the
 * registry's watermark cache for a live child and folded once over one
 * persistence inspection for a cold one. The projection fold is the single
 * classification authority — this module parses no descriptor itself. Absent
 * persistence, enumeration is live-only: a cold child is unreachable for
 * resume anyway, so its absence is capability absence, not an error. The
 * module owns no catalog state and does not consult Activation,
 * Agent-registry, continuation-manager, or provider state.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from 'cordis'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SubagentError } from './error.ts'
import type { SubagentIdentityProjection } from './projection-types.ts'

/**
 * Concurrent cold inspections per listing; a constant because it bounds one
 * read-only scan of local media, not deployment behavior. Should a networked
 * persistence backend appear, promote it to a validated `Config` field.
 */
const COLD_READ_CONCURRENCY = 4

/**
 * One entry of a {@link listChildren} result, ordered by header `createdAt`
 * with ties broken on id. Only a candidate whose durable header has
 * `origin: 'subagent'` is interpreted. A served `subagent` projection value
 * produces a `child`; a settled candidate whose fold served no identity
 * produces a `diagnostic`; a running candidate without one is omitted — its
 * descriptor may not be appended yet (the creation window). Diagnostics
 * relay the projection fold's outcome or a failed read, never a per-child
 * event scan, and never expose model-hidden descriptor content.
 */
export type SubagentListEntry =
  | {
    readonly kind: 'child'
    /** The durable child session id, stable across Activations. */
    readonly id: SessionId
    /**
     * Store snapshot activity: `running` means the logical record is live in
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
    /** The candidate's session id. */
    readonly id: SessionId
    /**
     * Why the candidate has no `child` row: `corrupt` for a settled candidate
     * whose projection fold served no identity (a missing, malformed, or
     * unrecognized-version descriptor — deliberately undistinguished), and
     * for any candidate whose log makes a registered unit's fold or schema
     * throw (deterministic data damage, contained per child); `unavailable`
     * when the candidate's persistence inspection failed (retried on the
     * next listing). `unsupported` is kept for consumers already routing on
     * it but is no longer produced.
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

/**
 * Enumerate one parent's origin-classified direct children from the
 * live-preferred merge of `ctx.sessions` and optional session persistence,
 * serving each identity from the `subagent` projection unit: the registry's
 * watermark snapshot for a live child, one bounded-concurrency persistence
 * inspection folded through the registry for a cold one.
 * @see SubagentService.listChildren for the public cancellation and failure contract.
 * @param ctx - context carrying the session store, the projection registry,
 *   and optional persistence.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param signal - caller-owned cancellation observed around every persistence read.
 * @returns children and per-child diagnostics ordered by `createdAt`, then id.
 * @throws {@link SubagentError} when the projection registry or the session
 *   store is not mounted, or the caller cancels the listing.
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentListEntry[]> {
  const projections = ctx.get('sessionProjections')
  // Checked before any read, even with zero candidates: mode/label are the
  // row's strong contract, so a missing fold capability is a deterministic
  // deployment configuration error, never an empty success.
  if (projections === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  // Strict global read, never the `ctx.sessions` property proxy: the proxy is
  // caller-scope bound, so a consumer plugin without its own `sessions`
  // injection (the model-facing tool, the API proxy) would throw on access.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @deepseek-ai/dsh-session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  assertListingNotCancelled(signal)
  const persistence = ctx.get('sessionPersistence')
  let persistedHeaders: readonly SessionHeader[] = []
  if (persistence !== undefined) {
    try {
      persistedHeaders = await persistence.list(signal)
    } catch (error: unknown) {
      // The backend may reject with its own abort failure after observing the
      // forwarded signal; cancellation stays a stable subagent failure.
      assertListingNotCancelled(signal)
      throw error
    }
    assertListingNotCancelled(signal)
  }
  // Live-preferred merge without header reconciliation: a live record wins
  // its id wholesale, exactly as a live-preferred corpus would serve it.
  const corpus = new Map<SessionId, { header: SessionHeader; live: Session | undefined }>()
  for (const header of persistedHeaders) corpus.set(header.id, { header, live: undefined })
  for (const session of sessions.list()) {
    corpus.set(session.header.id, { header: session.header, live: session })
  }
  const subagentParents = new Set<SessionId>()
  for (const record of corpus.values()) {
    if (record.header.origin === 'subagent' && record.header.parentSession !== undefined) {
      subagentParents.add(record.header.parentSession)
    }
  }
  const candidates = [...corpus.values()]
    .filter(record => record.header.parentSession === parentSessionId
      && record.header.origin === 'subagent')
    .sort((a, b) => a.header.createdAt - b.header.createdAt
      || a.header.id.localeCompare(b.header.id))

  const rows: (SubagentListEntry | undefined)[] = Array.from({ length: candidates.length })
  const coldReads: { index: number; id: SessionId }[] = []
  candidates.forEach((candidate, index) => {
    const childId = candidate.header.id
    if (candidate.live === undefined) {
      coldReads.push({ index, id: childId })
      return
    }
    // The registry's watermark cache serves the live value with zero log
    // reads; a live child without an identity yet is the creation window
    // before the establishing provider appends its descriptor.
    let identity: SubagentIdentityProjection | undefined
    try {
      identity = projections.snapshot(candidate.live).values.subagent
    } catch {
      // The snapshot folds EVERY registered unit over this child's log, so
      // any unit's fold or schema can reject damaged payloads. That is
      // deterministic data damage in this one child; it degrades to one
      // corrupt diagnostic instead of failing the whole listing.
      rows[index] = { kind: 'diagnostic', id: childId, reason: 'corrupt' }
      return
    }
    if (identity === undefined) return
    rows[index] = childRow(childId, identity, 'running', subagentParents.has(childId))
  })

  // Cold candidates exist only when persistence listed them, so the narrow
  // re-check is about types, not reachability.
  if (persistence !== undefined && coldReads.length > 0) {
    const queue = [...coldReads]
    await Promise.all(Array.from(
      { length: Math.min(COLD_READ_CONCURRENCY, queue.length) },
      async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          rows[job.index] = await inspectColdIdentity(
            persistence, projections, job.id, subagentParents.has(job.id), signal,
          )
        }
      },
    ))
  }
  assertListingNotCancelled(signal)
  return rows.filter((row): row is SubagentListEntry => row !== undefined)
}

/**
 * Resolve one cold candidate: one persistence inspection folded through the
 * projection registry (the same detached recipe the API proxy uses for
 * detached session projections). A failed inspection is one transient
 * `unavailable` row retried on the next listing; a settled log the fold
 * cannot identify — or that makes any registered unit throw — is final, so
 * it reports `corrupt`.
 */
async function inspectColdIdentity(
  persistence: SessionPersistence,
  projections: SessionProjectionRegistry,
  childId: SessionId,
  hasChildren: boolean,
  signal: AbortSignal | undefined,
): Promise<SubagentListEntry> {
  assertListingNotCancelled(signal)
  let events: readonly SessionEvent[]
  try {
    events = (await persistence.inspect(childId, signal)).events
  } catch {
    // Per-child isolation: the child vanished or its backend read failed —
    // one diagnostic row, and the listing itself still succeeds.
    assertListingNotCancelled(signal)
    return { kind: 'diagnostic', id: childId, reason: 'unavailable' }
  }
  assertListingNotCancelled(signal)
  let identity: SubagentIdentityProjection | undefined
  try {
    identity = projections.restore({}, events, 0).snapshot.values.subagent
  } catch {
    // The restore folds EVERY registered unit over this child's log, so any
    // unit's fold or schema can reject damaged payloads — deterministic data
    // damage in this one child, contained as its own corrupt diagnostic.
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  if (identity === undefined) {
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  return childRow(childId, identity, 'inactive', hasChildren)
}

/** Materialize one served identity as its child row. */
function childRow(
  id: SessionId,
  identity: SubagentIdentityProjection,
  activity: 'running' | 'inactive',
  hasChildren: boolean,
): SubagentListEntry {
  return identity.mode === 'one-shot'
    ? {
      kind: 'child',
      id,
      mode: 'one-shot',
      ...identity.label !== undefined ? { label: identity.label } : {},
      activity,
      hasChildren,
    }
    : {
      kind: 'child',
      id,
      mode: 'continuable',
      label: identity.label,
      activity,
      hasChildren,
    }
}

/** Stop a listing at its next cancellation checkpoint. */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}
