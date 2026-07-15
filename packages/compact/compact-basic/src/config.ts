/**
 * Runtime defaulting and per-model policy validation for compact-basic.
 *
 * @module @deepseek-ai/dsh-compact-basic/config
 */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { ModelTokenMeter, TokenMeterService } from '@deepseek-ai/dsh-token-meter'
import type {
  BasicCompactConfig,
  ModelCompactConfig,
  ResolvedConfig,
  ResolvedModelCompactConfig,
} from './types.ts'

/** Default request-pressure fraction for every metered model. */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** Default verbatim-tail fraction of a model's context window. */
const DEFAULT_RETAIN_RATIO = 0.16

/**
 * Resolve common defaults and validate every named model override.
 * @param config - raw compact-basic configuration.
 * @param tokenMeter - owning meter service used to reject unknown override names.
 * @returns a detached deeply immutable top-level configuration.
 */
export function resolveConfig(
  config: BasicCompactConfig = {},
  tokenMeter: TokenMeterService,
): ResolvedConfig {
  const configuredModels: unknown = config.models
  const models = configuredModels === undefined ? {} : configuredModels
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    throw new Error('BasicCompactConfig: models must be an object')
  }

  const detachedModels: Record<string, ModelCompactConfig> = {}
  for (const [model, override] of Object.entries(models as Record<string, unknown>)) {
    if (typeof override !== 'object' || override === null || Array.isArray(override)) {
      throw new Error(`BasicCompactConfig: models.${model} must be an object`)
    }
    const meter = tokenMeter.resolve(model)
    detachedModels[model] = { ...override as ModelCompactConfig }
    resolveModelConfig({
      models: detachedModels,
      summarizationModel: '',
      maxTokens: 8192,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      auto: true,
    }, meter)
  }

  const resolved: ResolvedConfig = {
    models: detachedModels,
    summarizationModel: config.summarizationModel ?? '',
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    auto: config.auto ?? true,
  }
  assertPositiveInteger('maxTokens', resolved.maxTokens)
  assertNonNegativeInteger('compactionRetries', resolved.compactionRetries)
  assertNonNegativeInteger('maxOverflowRetries', resolved.maxOverflowRetries)
  if (typeof resolved.summarizationModel !== 'string') {
    throw new Error('BasicCompactConfig: summarizationModel must be a string')
  }
  if (typeof resolved.auto !== 'boolean') {
    throw new Error('BasicCompactConfig: auto must be a boolean')
  }
  return deepFreeze(structuredClone(resolved))
}

/**
 * Resolve one effective model's default policy plus optional field overrides.
 * @param config - validated compact-basic configuration.
 * @param meter - effective model's token-meter handle and context capacity.
 * @returns a detached immutable model policy.
 */
export function resolveModelConfig(
  config: ResolvedConfig,
  meter: ModelTokenMeter,
): ResolvedModelCompactConfig {
  const override = config.models[meter.model]
  const thresholdRatio = override?.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO
  const retainTokens = override?.retainTokens ?? Math.floor(meter.contextWindow * DEFAULT_RETAIN_RATIO)
  assertRatio(`models.${meter.model}.thresholdRatio`, thresholdRatio)
  assertNonNegativeInteger(`models.${meter.model}.retainTokens`, retainTokens)
  const thresholdTokens = Math.floor(meter.contextWindow * thresholdRatio)
  if (retainTokens >= thresholdTokens) {
    throw new Error(
      `BasicCompactConfig: models.${meter.model}.retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    )
  }
  return deepFreeze({
    model: meter.model,
    contextWindow: meter.contextWindow,
    thresholdRatio,
    retainTokens,
  })
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
