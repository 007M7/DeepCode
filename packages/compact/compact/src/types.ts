/**
 * Compaction vocabulary: the result type and the `compact/*` session events.
 * Those declaration-merged events are log-only lock/provenance markers, not
 * surface events; a separate replacement `user/message` carries the summary.
 * Backend packages own configuration and retention policy; see
 * `.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md`.
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
      /** The provider route that wrote the summary. */
      provider: string
      /**
       * The model that wrote the summary — the summarize call's envelope,
       * reported by the backend that made the call, logged so the one-shot
       * request is reconstructable from log + code and "which model wrote
       * this summary" has a durable answer (the reconstructability Agent Note).
       */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
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
