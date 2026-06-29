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
  /** Provider generation cap for the summarization call (default 8192). */
  maxTokens?: number
  /** Extra compaction attempts when the first compacted surface is still over threshold (default 1). */
  compactionRetries?: number
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
  maxTokens: 8192,
  compactionRetries: 1,
  auto: true,
}

/**
 * Apply defaults to a partial config and reject nonsensical numeric knobs.
 *
 * Convergence is not a static config invariant: provider generation caps can be
 * spent on hidden or surfaced reasoning tokens, and the model may emit a summary
 * of unpredictable size. The backend instead enforces convergence dynamically:
 * each committed summary must be smaller than the content it shadows, and
 * `compactIfNeeded` may re-compact up to `compactionRetries` extra times before
 * throwing if the surface still exceeds the threshold.
 */
export function resolveConfig(config: BasicCompactConfig): ResolvedConfig {
  const resolved = { ...DEFAULTS, ...config }

  assertPositiveInteger('contextWindow', resolved.contextWindow)
  assertRatio('thresholdRatio', resolved.thresholdRatio)
  assertNonNegativeInteger('retainTokens', resolved.retainTokens)
  assertPositiveInteger('maxTokens', resolved.maxTokens)
  assertNonNegativeInteger('compactionRetries', resolved.compactionRetries)
  if (typeof resolved.summarizationModel !== 'string') {
    throw new Error('BasicCompactConfig: summarizationModel must be a string.')
  }
  if (typeof resolved.auto !== 'boolean') {
    throw new Error('BasicCompactConfig: auto must be a boolean.')
  }
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a positive integer.`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a non-negative integer.`)
  }
}

function assertRatio(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a number in (0, 1].`)
  }
}
