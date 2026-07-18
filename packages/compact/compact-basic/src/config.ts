/**
 * Runtime defaulting and policy validation for compact-basic.
 *
 * @module @deepseek-ai/dsh-compact-basic/config
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { TokenMeterService } from '@deepseek-ai/dsh-token-meter'
import type { BasicCompactConfig, ResolvedConfig } from './types.ts'

/** Default request-pressure fraction of the token meter's context window. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction of the token meter's context window. */
const DEFAULT_RETAIN_RATIO = 0.16

/** Complete public configuration key set. */
const BASIC_COMPACT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'auto',
])

/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config: BasicCompactConfig): void {
  for (const key of Object.keys(config)) {
    if (!BASIC_COMPACT_CONFIG_KEYS.has(key)) {
      throw new Error(
        `BasicCompactConfig: unknown key "${key}" `
        + '(allowed: thresholdRatio, retainTokens, summarizationProvider, summarizationModel, maxTokens, compactionRetries, auto)',
      )
    }
  }
}

/**
 * Resolve defaults and validate the service-wide compaction policy.
 * @param config - raw compact-basic configuration.
 * @param tokenMeter - token meter supplying the context capacity.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(
  config: BasicCompactConfig = {},
  tokenMeter: TokenMeterService,
): ResolvedConfig {
  validateConfigKeys(config)
  const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retainTokens = config.retainTokens
    ?? Math.floor(tokenMeter.contextWindow * DEFAULT_RETAIN_RATIO)
  const resolved: ResolvedConfig = {
    thresholdRatio,
    retainTokens,
    summarizationProvider: config.summarizationProvider ?? '',
    summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    auto: config.auto ?? true,
  }

  assertRatio('thresholdRatio', resolved.thresholdRatio)
  assertNonNegativeInteger('retainTokens', resolved.retainTokens)
  const thresholdTokens = Math.floor(tokenMeter.contextWindow * resolved.thresholdRatio)
  if (resolved.retainTokens >= thresholdTokens) {
    throw new Error(
      `BasicCompactConfig: retainTokens (${resolved.retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  assertPositiveInteger('maxTokens', resolved.maxTokens)
  assertNonNegativeInteger('compactionRetries', resolved.compactionRetries)
  if (typeof resolved.summarizationProvider !== 'string') {
    throw new Error('BasicCompactConfig: summarizationProvider must be a string')
  }
  if (typeof resolved.summarizationModel !== 'string') {
    throw new Error('BasicCompactConfig: summarizationModel must be a string')
  }
  if ((resolved.summarizationProvider.length === 0) !== (resolved.summarizationModel.length === 0)) {
    throw new Error(
      'BasicCompactConfig: summarizationProvider and summarizationModel must both be set or both be empty',
    )
  }
  if (typeof resolved.auto !== 'boolean') {
    throw new Error('BasicCompactConfig: auto must be a boolean')
  }
  return deepFreeze(resolved)
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a non-negative integer`)
  }
}

function assertRatio(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`BasicCompactConfig: ${name} (${value}) must be a number in (0, 1]`)
  }
}
