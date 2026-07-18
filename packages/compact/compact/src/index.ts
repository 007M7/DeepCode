/**
 * Compaction service seam (`ctx.compact`): implementations decide when to
 * compact and replace a history range with one summary node by subclassing
 * {@link CompactService}. This interface necessarily depends on session and LLM
 * vocabulary; the rationale is in the
 * [compaction RFC](../../../../docs/rfc/implemented/feature/2026-06-18-compaction-capability-seam.md).
 * @module @deepseek-ai/dsh-compact
 */

import { Context, Service } from 'cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CompactionResult } from './types.ts'

export type { CompactionResult } from './types.ts'
export { renderContentBlocks, renderTranscript } from './render.ts'
export { toolPairingBalancedAfter, toolPairingBalancedBefore } from './tool-pairing.ts'

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
   * Check token pressure and compact if the conversation is too large.
   * Estimate the next request, including its session prefix, derived history,
   * and system prompt. Above threshold, compact a head-anchored range ending at
   * a balanced tool boundary and reconsolidate any prior automatic checkpoint.
   * Return `null` when no compaction is needed or an open tail leaves no safe
   * cutoff. A single oversized retained unit or prefix cannot be repaired here.
   *
   * @param agent - agent context owning the session surface and model options.
   * @param fullSystemPrompt - assembled system prompt, counted toward the estimate.
   * @param sessionPrefix - the instance's composed session prefix, counted toward the
   *   estimate.
   * @param signal - cancellation signal; model-backed implementations must forward it.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    agent: CompactAgentContext,
    fullSystemPrompt: string,
    sessionPrefix: readonly Message[],
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   * `start` and `end` name an inclusive span by surface position, not numeric seq
   * order; replacements can make visible seqs non-monotonic. Both edges must be
   * balanced so assistant tool calls remain paired with their results. A model-
   * backed implementation forwards cancellation. The agent must own the exact
   * target session object; implementations reject an ownership mismatch before
   * model resolution, lock acquisition, summarization, or log mutation, and
   * reject active, missing, reversed, or unbalanced ranges.
   * Use {@link toolPairingBalancedBefore} and {@link toolPairingBalancedAfter}
   * for the edge checks.
   *
   * @param session - session to mutate; must be identical to `agent.session`.
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - owner of the target session and summarizer context.
   * @param signal - optional cancellation; model-backed implementations must forward it.
   * @throws when the agent does not own `session`, compaction is active, or the range is missing, reversed, or unbalanced.
   * @returns the replaced range and summary.
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
