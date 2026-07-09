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
 * recorded in the [compaction capability-seam RFC](../../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md).
 *
 * @module @deepseek-ai/dsh-compact
 */

import { Context, Service } from 'cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from './types.ts'

export type { CompactionResult } from './types.ts'
export { renderContentBlocks, renderTranscript } from './render.ts'

/** Minimal agent context compaction needs without depending on the agent package. */
export interface CompactAgentContext {
  session: Session
  options: { model?: string }
}

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
   * Estimates the current surface-derived history size (including the system
   * prompt), and if it exceeds the backend's threshold, compacts an older range
   * via {@link compactRegion}, keeping recent context intact. Returns `null`
   * when no compaction is needed.
   *
   * Scope and guarantees a backend MUST honor:
   * - **Surface-derived history only.** The decision is made against the history
   *   derived from the session surface — the only thing compaction can act on.
   *   Non-surface context injected downstream (into the request `messages` by a
   *   later listener) is out of this accounting by construction.
   * - **Head-anchored, best-effort.** Auto-compaction consolidates from the
   *   surface HEAD up to a balanced tool-pairing cutoff, so a prior head
   *   checkpoint is
   *   re-summarized into one fresh checkpoint (the surface holds at most one
   *   auto-generated checkpoint, always at the head). It is best-effort over
   *   CLOSED steps: when the only compactable content left is an un-splittable
   *   open tail step, it declines (`null`) and retries once that step closes.
   * - **Single-unit overflow is out of scope.** If a single retained unit (one
   *   closed step, or a large free node such as a pasted `user/message`) ALONE
   *   exceeds the budget, compaction cannot help and the call may go out
   *   over-budget. Bounding an individual unit's size is a separate concern.
   *
   * @param agent - agent context owning the session surface and model options.
   * @param fullSystemPrompt - assembled system prompt, counted toward the estimate.
   * @param signal - cancellation signal. A backend summarizing via
   *   `ctx.llm.stream()` MUST forward this into the call's `GenerateOptions.signal`
   *   so an abort/dispose tears down the in-flight summarization rather than
   *   leaving an orphaned model call running past the cancellation.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    agent: CompactAgentContext,
    fullSystemPrompt: string,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   *
   * `start` and `end` are inclusive seqs of surface nodes to shadow; the backend
   * summarizes their content and appends a replacement surface node. Used by the
   * (future) `/compact` tool and internally by {@link compactIfNeeded}.
   *
   * The region MUST NOT split a step's `assistant/message` tool-calls from their
   * `tool/result`s, leaving the rehydrated transcript with a dangling tool-call
   * or an orphaned tool-result that every provider rejects. A region is safe iff
   * both its edges are balanced cuts on the surface: the cut before `start` and
   * the cut after `end` each have no unanswered tool-call before them. A node
   * that belongs to no step (a pre-step user message, inter-step steering, or an
   * injection context message) is a balanced (free) boundary; an `end` inside an
   * open (unclosed) tail step is invalid — its tool-calls have no results yet.
   * `dsh-session` exports `isToolPairingBalanced` for this check.
   *
   * @param session - the session whose surface is mutated.
   * @param start - inclusive seq of the first surface node to compact.
   * @param end - inclusive seq of the last surface node to compact.
   * @param agent - agent context used by router-aware summarizers.
   * @param signal - optional cancellation signal. A backend that summarizes via
   *   `ctx.llm.stream()` MUST forward this into the call's `GenerateOptions.signal`
   *   so an abort/dispose tears down the in-flight summarization rather than
   *   leaving an orphaned model call running past the cancellation.
   * @throws if compaction is already in progress, if `start`/`end` are not
   *   valid surface nodes, if `start` is positioned after `end` on the surface
   *   (the range is a surface-POSITION span, not a numeric seq interval — a
   *   prior replace can leave the surface non-monotonic in seq order), or if
   *   either boundary is not a balanced tool-pairing cut (would split a step's
   *   tool-call/result pair).
   * @returns what the compaction did (the replaced range and its summary node).
   */
  abstract compactRegion(
    session: Session,
    start: number,
    end: number,
    agent: CompactAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactService
