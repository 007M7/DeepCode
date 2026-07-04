/**
 * Compaction vocabulary: the result type and the `compact/*` session events.
 *
 * Extends {@link SessionEventMap} with `compact/*` event types via declaration
 * merging. {@link SurfaceEventType} is deliberately NOT extended — `compact/*`
 * events are log-only markers (lock + provenance); only the five
 * surface-eligible types can carry `surfaceOp`. The actual surface mutation is
 * performed by a separate `user/message` event carrying the summary (see the
 * [compaction capability-seam RFC](../../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)).
 *
 * Configuration lives in the backend, not here: the contract states WHAT
 * compaction produces, while every tunable (context window, thresholds,
 * retention budget) is a HOW decision owned by the implementation.
 *
 * @module @deepseek-ai/dsh-compact/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Marks the start of a compaction — log-only, holds the lock until `compact/end`. */
    'compact/start': { turn: number }
    /**
     * Provenance record of a completed summarization — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by a subsequent `user/message` event that shadows the
     * compacted range.
     */
    'compact/summary': {
      summary: ContentBlock[]
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
    }
    /** Marks the end of a compaction — log-only, releases the lock. `error` set if summarization failed. */
    'compact/end': { turn: number; error?: string }
  }
}

/** Result of a successful compaction operation. */
export interface CompactionResult {
  /** The seq of the appended `compact/start` event. */
  startSeq: number
  /** The seq of the appended `compact/summary` event. */
  summarySeq: number
  /** The seq of the appended `compact/end` event. */
  endSeq: number
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: number; end: number }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
