/**
 * Automatic post-step pressure and context-overflow recovery listeners.
 *
 * @module @deepseek-ai/dsh-compact-basic/automatic
 */

import type { Context } from 'cordis'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compact'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import {
  TOKEN_METER_MODEL_UNCONFIGURED,
  TokenMeterError,
} from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface AutomaticCompactor {
  readonly config: { readonly maxOverflowRetries: number }
  compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
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
  const logResult = (result: CompactionResult, trigger: string): void => {
    ctx.logger.info(
      `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
      + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
      + `~${result.shadowedTokenCount} tokens)`,
    )
  }

  ctx.on('agent/post-step', async (
    agent: Agent,
    _turn: number,
    _step: number,
    signal: AbortSignal,
  ) => {
    if (signal.aborted) return
    try {
      const result = await service.compactIfNeeded(agent, 'pressure', signal)
      if (result !== null) logResult(result, 'post-step pressure')
    } catch (error: unknown) {
      // A named routed model without a meter profile is configuration failure,
      // not an optional operational compaction miss.
      if (error instanceof TokenMeterError
        && error.code === TOKEN_METER_MODEL_UNCONFIGURED) throw error
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`post-step compaction failed: ${message}; continuing the turn`)
    }
  })

  ctx.on('agent/request-error', async (agent, _turn, _step, error, retryAttempt, signal, next) => {
    if (error.code !== CONTEXT_WINDOW_EXCEEDED_CODE
      || retryAttempt >= service.config.maxOverflowRetries
      || signal.aborted) return next()

    let generation: number
    let result: CompactionResult | null
    try {
      generation = agent.session.surface.replaceGeneration
      result = await service.compactIfNeeded(agent, 'context-overflow', signal)
    } catch (recoveryError: unknown) {
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      ctx.logger.warn(
        `context-overflow compaction failed: ${message}; preserving the original request error`,
      )
      return next()
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort while compaction is awaited.
    if (signal.aborted || result === null
      || agent.session.surface.replaceGeneration <= generation) return next()
    logResult(result, 'context overflow recovery')
    return { action: 'retry' }
  })
}
