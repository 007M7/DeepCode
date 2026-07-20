/**
 * Compaction service seam (`ctx.compact`): implementations decide when to
 * compact and replace a history range with one summary node by subclassing
 * {@link CompactService}. This interface necessarily depends on session and LLM
 * vocabulary; the rationale is in the
 * [compaction Agent Note](../../../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md).
 * @module @deepseek-ai/dsh-compact
 */

import { Context, Service } from 'cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from './types.ts'

export type { CompactionResult } from './types.ts'
export { renderContentBlocks, renderTranscript } from './render.ts'
export { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'

/** Why automatic policy is asking a backend to consider compaction. */
export type CompactionTrigger = 'pressure' | 'context-overflow'

/** Minimal agent context compaction needs without depending on the agent package. */
export interface CompactAgentContext {
  session: Session
  options: { provider?: string; model?: string }
}

declare module 'cordis' {
  interface Context {
    compact: CompactService
  }
}

/**
 * Abstract compaction service. Implementations own trigger policy, retention,
 * and summarization, and may consume a separate measurement service. A
 * successful run replaces the selected surface span with one summary node and
 * prevents concurrent compaction of the same session. Load one implementation
 * per context as `ctx.compact`.
 */
export abstract class CompactService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compact')
  }

  /**
   * Consider automatic compaction for one explicit trigger. Pressure policy
   * uses the latest durable routed request, while context-overflow policy may
   * force a useful balanced reduction even below the normal threshold. Return
   * `null` when no safe range can be compacted. A single oversized retained
   * unit or request envelope cannot be repaired through surface compaction.
   *
   * @param agent - agent context owning the session surface and routing options.
   * @param trigger - normal pressure or provider-confirmed context overflow.
   * @param signal - cancellation signal; model-backed implementations must forward it.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    agent: CompactAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   * `start` and `end` name an inclusive span by surface position, not numeric seq
   * order; replacements can make visible seqs non-monotonic. Both edges must be
   * balanced so assistant tool calls remain paired with their results. A model-
   * backed implementation forwards cancellation and rejects active, missing,
   * reversed, or unbalanced ranges. The target session is `agent.session`.
   * Use {@link toolPairingBalancedBefore} and {@link toolPairingBalancedAfter}
   * for the edge checks.
   *
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - context whose session is mutated and whose routing options guide summarization.
   * @param signal - optional cancellation; model-backed implementations must forward it.
   * @throws when compaction is active or the range is missing, reversed, or unbalanced.
   * @returns the appended event seqs, summary, replaced range, and token accounting.
   */
  abstract compactRegion(
    start: number,
    end: number,
    agent: CompactAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactService
