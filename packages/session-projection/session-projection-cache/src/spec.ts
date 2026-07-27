/**
 * The session-projcache domain declaration: one `sessions` table keyed by
 * {@link SessionId}, each record the full projection checkpoint for one
 * session (`key → {stateVersion, observedSeq, state}` rows). The spec object
 * is the single source of the domain's identity, version, and record schema;
 * the storage-domain routing decides the medium (the shipped composition's
 * json backend lands it at `<root>/session_projcache.json`, beside
 * `workspace.json`).
 * @module @deepseek-ai/dsh-session-projection-cache/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * One persisted checkpoint row (the RFC's `(sessionId, key, stateVersion,
 * observedSeq, state)` minus the two record keys). `state` is the unit's
 * internal state — plain JSON by the unit contract; `z.json()` enforces that
 * at the durable boundary. A row is never wrong, only possibly stale:
 * `observedSeq` says exactly how stale, and a `stateVersion` mismatch
 * discards it at read time (never a migration).
 */
export const checkpointRow = z.object({
  stateVersion: z.number().int().nonnegative(),
  observedSeq: z.number().int().gte(-1),
  state: z.json(),
})

/**
 * One session's stored record: its checkpoint rows keyed by projection key.
 * The whole record is replaced on every write (whole-value discipline — the
 * registry checkpoint is always the complete per-session cut).
 */
export const checkpointRecord = z.object({
  rows: z.record(z.string(), checkpointRow),
})

/** One stored per-session checkpoint record, inferred from {@link checkpointRecord}. */
export type CheckpointRecord = z.infer<typeof checkpointRecord>

/**
 * The session-projcache domain spec. Version bumps discard the whole medium
 * (cache semantics: a stale or unreadable cache costs a longer tail replay,
 * never a wrong value).
 */
export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 1,
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})
