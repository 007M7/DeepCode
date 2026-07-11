/**
 * The compaction service seam (`ctx.compact`): an abstract service defining what compaction
 * does — decide when to compact, summarize a range of conversation history into a single
 * surface node — without saying how.
 * @module @deepseek-ai/dsh-compact
 */

import { Context, Service } from 'cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
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
 * Abstract compaction service. Subclass implement the two abstract methods, and load the
 * subclass as a plugin — it registers as `ctx.compact` (one implementation per context;
 * loading a second throws, which is cordis' standard duplicate-service behavior).
 */
export abstract class CompactService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compact')
  }

  /**
   * Check token pressure and compact if the conversation is too large.
   *
   * @param agent - agent context owning the session surface and model options.
   * @param fullSystemPrompt - assembled system prompt, counted toward the estimate.
   * @param sessionPrefix - the instance's composed session prefix, counted toward the
   *   estimate.
   * @param signal - cancellation signal.
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
   *
   * @param session - session to mutate.
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - summarizer context.
   * @param signal - optional cancellation.
   * @throws when compaction is active or the range is invalid or unbalanced.
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
