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
 * The stored-log identity a record is bound to: the immutable header fields
 * that distinguish one session lifecycle from another under the same id. A
 * session id names a slot, not a lifecycle — a deleted-then-recreated id, or
 * a persistence root swapped under a surviving cache, would otherwise let an
 * old row pass every watermark check and seed state folded from an unrelated
 * log. Reads validate this against the live header (listing) or the stored
 * header (cold read) before accepting any row.
 */
export const checkpointIdentity = z.object({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
})

/** The identity fields a record is bound to, inferred from {@link checkpointIdentity}. */
export type CheckpointIdentity = z.infer<typeof checkpointIdentity>

/**
 * One session's stored record: the log identity it was folded from plus its
 * checkpoint rows keyed by projection key. The whole record is replaced on
 * every write (whole-value discipline — the registry checkpoint is always
 * the complete per-session cut).
 */
export const checkpointRecord = z.object({
  identity: checkpointIdentity,
  rows: z.record(z.string(), checkpointRow),
})

/** One stored per-session checkpoint record, inferred from {@link checkpointRecord}. */
export type CheckpointRecord = z.infer<typeof checkpointRecord>

/**
 * The session-projcache domain spec. Version bumps discard the whole medium
 * (cache semantics: a stale or unreadable cache costs a longer tail replay,
 * never a wrong value). v2 added the record's log-identity binding.
 */
export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 2,
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})
