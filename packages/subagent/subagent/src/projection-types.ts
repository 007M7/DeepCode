/**
 * Pure client-safe subagent projection vocabulary.
 *
 * @module @deepseek-ai/dsh-subagent/projection-types
 */

/** Durable active-turn timing for one descriptor-backed child session. */
export interface SubagentTimingProjection {
  /** Milliseconds accumulated across completed turns after the child's own descriptor. */
  settledMs: number
  /** Start of the currently open turn, when one has not reached `turn/end`. */
  activeSince?: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Active-turn duration for a descriptor-backed subagent session. */
    subagentTiming: SubagentTimingProjection
  }
}
