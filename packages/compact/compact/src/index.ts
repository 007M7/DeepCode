/**
 * The compaction service seam (`ctx.compact`): an abstract service defining
 * WHAT compaction does — decide when to compact, summarize a range of
 * conversation history into a single surface node — without saying HOW.
 *
 * Implementations subclass {@link CompactService}, implement
 * {@link CompactService.compactIfNeeded} and {@link CompactService.compactRegion},
 * and load as a plugin — registering as `ctx.compact` (one implementation per
 * context). A tokenizer-, template-, or model-backed implementation can live
 * as a sibling package; callers stay on the same `ctx.compact` seam without
 * touching consumers.
 *
 * The split follows the capability-seams RFC — interface (this) /
 * implementation (deferred) / consumer (a `/compact` tool, deferred) — modeled
 * on the bash trio. Unlike `dsh-bash`, this interface necessarily
 * depends on `dsh-session` and `dsh-llm`: the contract's verbs are defined over
 * a `Session` and its output is the `ContentBlock` vocabulary. That deviation
 * from the "interface depends only on cordis" guidance is intentional and
 * recorded in the [compaction capability-seam RFC](../../../../docs/rfc/proposed/feature/2026-06-18-compaction-capability-seam.md).
 *
 * @module @deepseek-ai/dsh-compact
 */

import { Context, Service } from 'cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from './types.ts'

export type { CompactionResult } from './types.ts'

declare module 'cordis' {
  interface Context {
    compact: CompactService
  }
}

/**
 * Abstract compaction service. Subclass implement the two abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.compact` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Both core methods are abstract: the contract states WHAT compaction does,
 * while the entire strategy — token estimation, retention policy, event
 * sequencing, summarization — is a HOW decision owned by the implementation.
 *
 * Implementations MUST honor:
 * - **Surface contract**: a successful compaction shadows the compacted surface
 *   nodes with a SINGLE replacement node carrying the summary. Because
 *   `SurfaceEventType` is a closed union, that node is a `user/message` with
 *   `surfaceOp: { op:'replace', start, end }`; the `compact/*` events are
 *   log-only (lock + provenance).
 * - **Blocking**: no compaction begins while another is in progress for the
 *   same session. The recommended mechanism is the log-recorded lock — append
 *   `compact/start` before the slow work and `compact/end` after (even on
 *   failure) — so the lock is visible to replay and crash recovery.
 */
export abstract class CompactService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compact')
  }

  /**
   * Check token pressure and compact if the conversation is too large.
   *
   * Estimates the current history size (optionally including a system prompt),
   * and if it exceeds the backend's threshold, compacts an older range via
   * {@link compactRegion}, keeping recent context intact.
   *
   * @param session - the session whose surface may be compacted.
   * @param systemPrompt - optional system prompt, counted toward the estimate.
   * @param model - optional summarization model (falls back to backend config).
   * @param signal - optional cancellation signal. A backend that summarizes via
   *   `ctx.llm.stream()` MUST forward this into the call's `GenerateOptions.signal`
   *   so an abort/dispose tears down the in-flight summarization rather than
   *   leaving an orphaned model call running past the cancellation.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    session: Session,
    systemPrompt?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   *
   * `start` and `end` are inclusive seqs of surface nodes to shadow; the backend
   * summarizes their content and appends a replacement surface node. Used by the
   * (future) `/compact` tool and internally by {@link compactIfNeeded}.
   *
   * @param session - the session whose surface is mutated.
   * @param start - inclusive seq of the first surface node to compact.
   * @param end - inclusive seq of the last surface node to compact.
   * @param model - summarization model.
   * @param signal - optional cancellation signal. A backend that summarizes via
   *   `ctx.llm.stream()` MUST forward this into the call's `GenerateOptions.signal`
   *   so an abort/dispose tears down the in-flight summarization rather than
   *   leaving an orphaned model call running past the cancellation.
   * @throws if compaction is already in progress, or if `start`/`end` are not
   *   valid surface nodes, or if `start > end`.
   */
  abstract compactRegion(
    session: Session,
    start: number,
    end: number,
    model: string,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactService
