/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compact-basic
 */

import { Context } from 'cordis'
import z from 'schemastery'
import { CompactService } from '@deepseek-ai/dsh-compact'
import type { CompactionResult } from '@deepseek-ai/dsh-compact'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerAutomaticCompaction } from './automatic.ts'
import { resolveConfig } from './config.ts'
import { compactSurfaceRegion, selectCompactableRange } from './region.ts'
import { summarizeWithLlm } from './summarizer.ts'
import type {
  BasicCompactConfig,
  ResolvedConfig,
} from './types.ts'

export { resolveConfig } from './config.ts'
export type {
  BasicCompactConfig,
  ResolvedConfig,
} from './types.ts'

/** Resolve the latest actual routed provider/model, then the complete agent fallback pair. */
function effectiveTarget(agent: Agent): { provider: string; model: string } | undefined {
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined) return { provider: latest.provider, model: latest.model }
  const { provider, model } = agent.options
  if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
    return undefined
  }
  return { provider, model }
}

/**
 * Build the provisional pre-step request envelope. Prompt and prefix are exact;
 * tools and non-model call config come from the latest logged request because
 * later request middleware has not run yet.
 */
function provisionalHeader(
  target: { provider: string; model: string },
  session: Session,
  fullSystemPrompt: string,
  sessionPrefix: readonly Message[],
): EpochHeader {
  const latest = session.requestHeader()
  return canonicalHeader({
    config: latest === undefined ? target : { ...latest.config, ...target },
    ...fullSystemPrompt.length === 0 ? {} : { system: fullSystemPrompt },
    ...latest?.tools === undefined ? {} : { tools: latest.tools },
    ...sessionPrefix.length === 0 ? {} : { messagePrefix: [...sessionPrefix] },
  })
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
    auto: z.boolean().default(true),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: BasicCompactConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config, ctx.tokenMeter)
    if (this.config.auto) registerAutomaticCompaction(ctx, this)
  }

  /**
   * Summarize a rendered region through a direct one-shot `ctx.llm.stream()`
   * call. Override this sole hook for a template or remote summarizer.
   * @param text - plain-text conversation region to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and exact auxiliary-call provenance.
   */
  async summarize(
    text: string,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string; maxTokens?: number }> {
    return summarizeWithLlm(this.ctx, this.config, text, agent, signal)
  }

  /**
   * Check replayed pressure for the provisional pre-step envelope and compact
   * a tool-balanced head until it falls below the service-wide threshold.
   * A genuinely model-less router-first step skips this provisional check.
   * @param agent - agent whose session and provisional provider/model are measured.
   * @param fullSystemPrompt - current assembled system prompt override.
   * @param sessionPrefix - current request-only prefix override.
   * @param signal - live step cancellation signal forwarded to summarization.
   * @returns the latest compaction result, or `null` when no check/work applies.
   */
  override async compactIfNeeded(
    agent: Agent,
    fullSystemPrompt: string,
    sessionPrefix: readonly Message[],
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = effectiveTarget(agent)
    if (target === undefined) return null
    const meter = this.ctx.tokenMeter
    const requestHeader = provisionalHeader(target, agent.session, fullSystemPrompt, sessionPrefix)
    const threshold = Math.floor(meter.contextWindow * this.config.thresholdRatio)
    let measurement = meter.measure(agent.session, requestHeader)
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
      result = await this.compactRegion(agent.session, range.start, range.end, agent, signal)
      measurement = meter.measure(agent.session, requestHeader)
      if (measurement.totalTokens < threshold) return result
    }

    throw new Error(
      `compaction still above threshold after ${this.config.compactionRetries + 1} compaction attempts `
      + `(${measurement.totalTokens} estimated tokens >= threshold ${threshold})`,
    )
  }

  /**
   * Compact one inclusive positional surface range using the effective
   * token meter for all retention and shrink pricing. Reject an agent that does
   * not own the exact target before any mutation.
   * @param session - session whose surface is mutated; must equal `agent.session`.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    session: Session,
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    if (session !== agent.session) {
      throw new Error('compactRegion: agent.session must be the exact target session')
    }
    return compactSurfaceRegion({
      meter: this.ctx.tokenMeter,
      summarize: (text, owner, abort) => this.summarize(text, owner, abort),
    }, session, start, end, agent, signal)
  }
}

export default BasicCompactService
