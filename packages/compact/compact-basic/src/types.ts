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
  /** Enable automatic compaction on the `agent/pre-step` seam (default true). */
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

/**
 * Apply defaults to a partial config and enforce the approximate convergence
 * invariant.
 *
 * `summarizationMaxTokens + retainTokens` must be strictly BELOW the compaction
 * threshold (`contextWindow * thresholdRatio`). The invariant bounds the two
 * variable pieces of post-compaction history — the summary and the retained
 * recent tail — but it is intentionally approximate: checkpoint framing,
 * per-message role overhead, system-prompt size, and the char/4 estimator's
 * error can still leave a narrow accepted config near the threshold. The bound
 * is strict (`>=` rejects) because `compactIfNeeded` declines only when the
 * estimate is `< threshold`: a post-compaction history sitting EXACTLY at the
 * threshold would re-trigger on the next check. Pre-release we reject rather
 * than clamp: a config that cannot satisfy even this structural bound is a bug
 * at the call site, not something to silently paper over.
 *
 * @throws if `summarizationMaxTokens + retainTokens >= contextWindow * thresholdRatio`.
 */
export function resolveConfig(config: BasicCompactConfig): ResolvedConfig {
  const resolved = { ...DEFAULTS, ...config }
  const threshold = Math.floor(resolved.contextWindow * resolved.thresholdRatio)
  const postCompactionFloor = resolved.summarizationMaxTokens + resolved.retainTokens
  if (postCompactionFloor >= threshold) {
    throw new Error(
      `BasicCompactConfig: summarizationMaxTokens (${resolved.summarizationMaxTokens}) + `
      + `retainTokens (${resolved.retainTokens}) = ${postCompactionFloor} is not below the compaction `
      + `threshold contextWindow * thresholdRatio = ${threshold}; post-compaction history would `
      + 'stay at/over threshold and re-compact endlessly. Lower retainTokens/summarizationMaxTokens '
      + 'or raise contextWindow/thresholdRatio.',
    )
  }
  return resolved
}
