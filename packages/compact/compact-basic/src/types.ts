/**
 * Configuration vocabulary for the replay-aware basic compaction backend.
 *
 * @module @deepseek-ai/dsh-compact-basic/types
 */

/** Basic compaction configuration; every common field has a deployment default. */
export interface BasicCompactConfig {
  /** Compact at this fraction of the token meter's context window. Defaults to `0.8`. */
  thresholdRatio?: number
  /** Recent surface tokens retained verbatim. Defaults to `floor(contextWindow * 0.16)`. */
  retainTokens?: number
  /** Summary provider; `''` resolves the latest routed pair, then the agent pair. Defaults to `''`. */
  summarizationProvider?: string
  /** Summary model; `''` resolves the latest routed pair, then the agent pair. Defaults to `''`. */
  summarizationModel?: string
  /** Provider generation cap for summarization. Defaults to `8192`. */
  maxTokens?: number
  /** Extra attempts after the first compaction when pressure remains above threshold. Defaults to `1`. */
  compactionRetries?: number
  /** Maximum retries after canonical context overflow; `0` disables recovery. Defaults to `1`. */
  maxOverflowRetries?: number
  /** Enable automatic post-step pressure and overflow-recovery listeners. Defaults to `true`. */
  auto?: boolean
}

/** Validated and detached compaction configuration. */
export interface ResolvedConfig {
  readonly thresholdRatio: number
  readonly retainTokens: number
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly compactionRetries: number
  readonly maxOverflowRetries: number
  readonly auto: boolean
}
