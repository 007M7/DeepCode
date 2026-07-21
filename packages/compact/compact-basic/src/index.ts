/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compact-basic
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { CompactService } from '@deepseek-ai/dsh-compact'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compact'
import type { Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, assertNever } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compact-tool-result-prune'
import { resolveConfig } from './config.ts'
import { compactSurfaceRegion, selectCompactableRange } from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type {
  BasicCompactConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactConfig,
  ResolvedConfig,
} from './types.ts'

/** Resolve the exact model durably routed for the latest provider request. */
function routedModel(session: Session): string | undefined {
  const model = session.requestHeader()?.config.model
  return model === undefined || model.length === 0 ? undefined : model
}

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, provenance, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactService extends CompactService {
  static inject = ['llm', 'tokenMeter']

  static Config: z<BasicCompactConfig> = z.object({
    thresholdRatio: z.number().default(0.8),
    retainTokens: z.number().step(1),
    summarizationProvider: z.string().default(''),
    summarizationModel: z.string().default(''),
    maxTokens: z.number().step(1).min(1).default(8192),
    compactionRetries: z.number().step(1).min(0).default(1),
    maxOverflowRetries: z.number().step(1).min(0).default(1),
    auto: z.boolean().default(true),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: BasicCompactConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config, ctx.tokenMeter)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register the automatic post-step pressure and context-overflow recovery
   * listeners. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
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
        const result = await this.compactIfNeeded(agent, 'pressure', signal)
        if (result !== null) logResult(result, 'post-step pressure')
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`post-step compaction failed: ${message}; continuing the turn`)
      }
    })

    ctx.on('agent/request-error', async (agent, _turn, _step, _error, failure, priorFailures, signal, next) => {
      const priorOverflowFailures = priorFailures.filter(item => item.code === CONTEXT_WINDOW_EXCEEDED_CODE).length
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE
        || priorOverflowFailures >= this.config.maxOverflowRetries
        || signal.aborted) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          return { action: 'retry' }
        }
        ctx.logger.warn(
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      return { action: 'retry' }
    })
  }

  /**
   * Summarize a rendered region through a direct one-shot `ctx.llm.stream()`
   * call. Override this sole hook for a template or remote summarizer.
   * @param text - plain-text conversation region to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and exact auxiliary-call provenance.
   */
  protected async summarize(
    text: string,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string; maxTokens?: number }> {
    return summarizeWithLlm(this.ctx, this.config, text, agent, signal)
  }

  /**
   * Compact for replayed post-step pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal post-step pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const model = routedModel(agent.session)
    if (model === undefined) return null
    const meter = this.ctx.tokenMeter
    const threshold = Math.floor(meter.contextWindow * this.config.thresholdRatio)
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        if (measurement.totalTokens < threshold) return null
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compact-basic remains independently composable.
    // Once either trigger qualifies, land the model-free pass before choosing
    // a summary range, then remeasure through the singleton replay fold.
    const prune = this.ctx.get('toolResultPrune')
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }

    if (trigger === 'context-overflow') {
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    if (measurement.totalTokens < threshold) return null

    let result: CompactionResult | null = null
    for (let attempt = 0; attempt <= this.config.compactionRetries; attempt += 1) {
      const range = selectCompactableRange(agent.session, measurement, this.config.retainTokens)
      if (range === null) {
        /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
        if (result === null) return null
        /* v8 ignore next -- paired with the defensive post-success branch above. */
        break
      }
      result = await this.compactRegion(range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < threshold) return result
    }

    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${threshold})`,
    )
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    return compactSurfaceRegion({
      meter: this.ctx.tokenMeter,
      summarize: (text, owner, abort) => this.summarize(text, owner, abort),
    }, session, start, end, agent, signal)
  }
}

export default BasicCompactService
