/**
 * Automatic pre-step pressure listener for compact-basic.
 *
 * @module @deepseek-ai/dsh-compact-basic/automatic
 */

import type { Context } from 'cordis'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface AutomaticCompactor {
  compactIfNeeded(
    agent: Agent,
    fullSystemPrompt: string,
    sessionPrefix: readonly Message[],
    signal: AbortSignal,
  ): Promise<CompactionResult | null>
}

/**
 * Register the implementation-owned automatic compaction listener.
 * @param ctx - context owning the listener effect and logger.
 * @param service - compactor whose public methods remain dynamically dispatched.
 */
export function registerAutomaticCompaction(
  ctx: Context,
  service: AutomaticCompactor,
): void {
  ctx.on('agent/pre-step', async (
    agent: Agent,
    _turn: number,
    _step: number,
    fullSystemPrompt: string,
    sessionPrefix: readonly Message[],
    signal: AbortSignal,
  ) => {
    try {
      const result = await service.compactIfNeeded(agent, fullSystemPrompt, sessionPrefix, signal)
      if (result !== null) {
        ctx.logger.info(
          `compaction: shadowed ${result.shadowedSeqs.length} surface nodes `
          + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
          + `~${result.shadowedTokenCount} tokens)`,
        )
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`compaction failed: ${message}; proceeding with full history`)
    }
  })
}
