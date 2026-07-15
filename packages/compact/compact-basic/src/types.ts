/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compact-basic/types
 */

/** Optional pressure and retention policy for one metered model. */
export interface ModelCompactConfig {
  /** Compact at this fraction of the model's configured context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent surface tokens retained verbatim. Defaults to `floor(contextWindow * 0.16)`. */
  retainTokens?: number
}

/** Basic compaction configuration; every common field has a deployment default. */
export interface BasicCompactConfig {
  /** Field-wise pressure/retention overrides keyed by configured token-meter model name. */
  models?: Record<string, ModelCompactConfig>
  /** Summary model; `''` resolves the latest routed model, then `AgentOptions.model`. Defaults to `''`. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Enable the automatic `agent/pre-step` pressure listener. Defaults to `true`. */
  auto?: boolean
}

/** Validated top-level defaults plus detached per-model partial overrides. */
export interface ResolvedConfig {
  readonly models: Readonly<Record<string, Readonly<ModelCompactConfig>>>
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly auto: boolean
}

/** Fully resolved pressure/retention policy for one effective model. */
export interface ResolvedModelCompactConfig {
  readonly model: string
  readonly contextWindow: number
  readonly thresholdRatio: number
  readonly retainTokens: number
}
