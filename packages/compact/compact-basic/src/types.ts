/**
 * Configuration vocabulary for the basic compaction backend.
 *
 * Every tunable lives here, in the implementation — the abstract contract
 * (`@deepseek-ai/dsh-compact`) carries no config, because thresholds and
 * retention policy are HOW decisions a different backend would make
 * differently.
 *
 * @module @deepseek-ai/dsh-compact-basic/types
 */

/** Backend configuration — all optional with sensible defaults. */
export interface BasicCompactConfig {
  /** Context window size in tokens (default 128000). */
  contextWindow?: number
  /** Compact when estimated token usage exceeds this fraction of context window (default 0.8). */
  thresholdRatio?: number
  /** Number of tokens of recent context to retain during compaction (default 20480). */
  retainTokens?: number
  /** Model to use for summarization (default '' — uses the agent's model). */
  summarizationModel?: string
  /** Maximum tokens for the summarization response (default 2048). */
  summarizationMaxTokens?: number
  /** Enable automatic compaction on the `agent/request` waterfall (default true). */
  auto?: boolean
}

/** Resolved config with all defaults applied. */
export type ResolvedConfig = Required<BasicCompactConfig>

/** Default configuration values. */
export const DEFAULTS: ResolvedConfig = {
  contextWindow: 128000,
  thresholdRatio: 0.8,
  retainTokens: 20480,
  summarizationModel: '',
  summarizationMaxTokens: 2048,
  auto: true,
}

/** Apply defaults to a partial config. */
export function resolveConfig(config: BasicCompactConfig): ResolvedConfig {
  return { ...DEFAULTS, ...config }
}
