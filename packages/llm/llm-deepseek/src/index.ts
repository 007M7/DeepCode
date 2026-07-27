/**
 * Register a {@link DeepSeekAdapter} for the `deepseek` provider route on `ctx.llm`. Configuration uses
 * Cordis schemastery; pass secrets from environment variables through `cordis.yml` with `!!js`,
 * as shown in the package README, rather than reading ad hoc files.
 * @module @deepseek-ai/dsh-llm-deepseek
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, DeepSeekAdapter } from './adapter.ts'
import type { DeepSeekCatalogModel } from './adapter.ts'

export { DeepSeekAdapter } from './adapter.ts'
export type { DeepSeekAdapterOptions, DeepSeekCatalogModel } from './adapter.ts'
export type { RequestDefaults } from './serialize.ts'
export type * from './types.ts'

export const name = 'llm-deepseek'
export const inject = ['llm']

const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-v4-flash', contextWindow: 128_000 },
  { id: 'deepseek-v4-pro', contextWindow: 128_000 },
]

/**
 * Plugin config, validated by the same-named schemastery schema. Every field
 * is optional in yml: credentials/endpoint fall back to the environment (a
 * missing API key fails plugin load, not the first call), omitted thinking
 * mode uses the provider default, and omitted reasoning effort resolves to
 * `high`.
 */
export interface Config {
  /** API key; falls back to $DEEPSEEK_API_KEY. Required one way or the other. */
  apiKey?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to V4 Flash and V4 Pro. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'high', 'max']),
  defaultContextWindow: z.number().step(1).min(1),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Public API default; the internal endpoint comes from $DEEPSEEK_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly DeepSeekCatalogModel[] | undefined): DeepSeekCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-deepseek: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    }
  })
}

export function apply(ctx: Context, config: Config): void {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('llm-deepseek: an API key is required (Config.apiKey or $DEEPSEEK_API_KEY)')
  }
  const baseURL = config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL
  ctx.llm.registerAdapter(['deepseek'], new DeepSeekAdapter({
    apiKey,
    baseURL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    ...config.defaultContextWindow === undefined
      ? {}
      : { defaultContextWindow: config.defaultContextWindow },
    models: resolveModels(config.models),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    ...config.retryPolicy === undefined ? {} : { retryPolicy: config.retryPolicy },
  }))
}
