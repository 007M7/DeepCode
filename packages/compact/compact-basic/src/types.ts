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

/**
 * Backend configuration. Every knob is REQUIRED except `auto`: there is no
 * concrete data yet to justify default thresholds/budgets, so a consumer must
 * state each value explicitly rather than inherit a guessed default. `auto`
 * alone defaults to `true` (auto-compaction is the intended posture).
 */
export interface BasicCompactConfig {
  /** Context window size in tokens. */
  contextWindow: number
  /** Compact when estimated token usage exceeds this fraction of context window. */
  thresholdRatio: number
  /** Number of tokens of recent context to retain during compaction. */
  retainTokens: number
  /** Model to use for summarization (`''` — uses the agent's model). */
  summarizationModel: string
  /** Provider generation cap for the summarization call. */
  maxTokens: number
  /** Extra compaction attempts when the first compacted surface is still over threshold. */
  compactionRetries: number
  /** Enable automatic compaction on the `agent/pre-step` seam (default true). */
  auto?: boolean
}

/** Resolved config with `auto` defaulted. */
export type ResolvedConfig = Required<BasicCompactConfig>

/**
 * Default `auto` when unset and reject nonsensical numeric knobs.
 *
 * Convergence is not a static config invariant: provider generation caps can be
 * spent on hidden or surfaced reasoning tokens, and the model may emit a summary
 * of unpredictable size. The backend instead enforces convergence dynamically:
 * each committed summary must be smaller than the content it shadows, and
 * `compactIfNeeded` may re-compact up to `compactionRetries` extra times before
 * throwing if the surface still exceeds the threshold.
 */
export function resolveConfig(config: BasicCompactConfig): ResolvedConfig {
  const resolved: ResolvedConfig = { auto: true, ...config }

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
