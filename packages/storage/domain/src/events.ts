/**
 * Change-event vocabulary of the domain data form. Every durable write emits
 * one event after the backend resolves durability, carrying the new snapshot
 * and an operation discriminant — never the old value (a diffing consumer
 * keeps its own previous snapshot). This is the event source for cross-process
 * change push (RPC frames) in a later phase.
 * @module @deepseek-ai/dsh-domain/src/events
 */

/** One durable domain change: a record upsert/delete or a global write. */
export interface DomainChanged {
  /** Owning domain name. */
  readonly domain: string
  /** Table name; `''` for a global-singleton write. */
  readonly table: string
  /** Record key; `''` for a global-singleton write. */
  readonly key: string
  /** What happened: `put` covers insert and overwrite; `deleted` is a tombstone. */
  readonly operation: 'put' | 'deleted'
  /** The new snapshot; absent for `deleted`. */
  readonly value?: unknown
}

declare module 'cordis' {
  interface Events {
    /**
     * A domain record or the global singleton changed, emitted once per write
     * strictly after the backend acknowledged durability. Events of one
     * domain arrive in its write-chain order.
     * @param change - domain, table (`''` for global), key (`''` for global),
     * operation discriminant, and the new snapshot (absent for deletions).
     * @mode emit
     */
    'domain/changed'(change: DomainChanged): void
  }
}
