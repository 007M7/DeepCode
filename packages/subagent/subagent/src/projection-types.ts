/**
 * Pure client-safe subagent projection vocabulary.
 *
 * @module @deepseek-ai/dsh-subagent/projection-types
 */

/** Durable active-turn timing for one descriptor-backed child session. */
export interface SubagentTimingProjection {
  /** Milliseconds accumulated across completed turns after the child's own descriptor. */
  settledMs: number
  /** Same-cut bounds of the currently open turn, when one has not reached `turn/end`. */
  active?: {
    /** Start of the open turn. */
    since: number
    /** Latest event time folded into this projection cut. */
    through: number
  }
}

/**
 * Durable identity of one descriptor-backed subagent session: lifecycle mode
 * plus creation label, folded last-wins from `subagent/descriptor` events.
 * Label strength follows the descriptor schema: a continuable child always
 * carries one, a one-shot child may omit it.
 */
export type SubagentIdentityProjection =
  | {
    /** A terminal one-shot child. */
    mode: 'one-shot'
    /** Optional durable creation label from the child's descriptor. */
    label?: string
  }
  | {
    /** A resumable conversation. */
    mode: 'continuable'
    /** Durable creation label from the child's descriptor. */
    label: string
  }

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Active-turn duration for a descriptor-backed subagent session. */
    subagentTiming: SubagentTimingProjection
    /**
     * Identity of a descriptor-backed subagent session. No value ⟺ no valid
     * descriptor: a missing, malformed, or unrecognized-version descriptor is
     * served identically as `undefined` in a live snapshot, and as an absent
     * key after any JSON boundary (query-index rows, wire frames) drops it.
     */
    subagent: SubagentIdentityProjection
  }
}
