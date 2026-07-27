/**
 * Configuration schema and provider-profile validation for the pi-ai adapter.
 *
 * @module dsh-llm-pi-ai/config
 */

import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CacheRetention, ModelThinkingLevel, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import z from 'schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Configuration for one pi-ai provider route. */
export interface PiAiProviderProfile {
  /** pi-ai provider catalog name and Harness route key. */
  provider: string
  /** Provider credential; when absent pi-ai uses its provider-native ambient discovery. */
  apiKey?: string
  /** Override the selected catalog model's endpoint without changing its protocol metadata. */
  baseURL?: string
  /** Provider request headers; Harness attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral pi-ai reasoning level. */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
}

/** Validated profile with every adapter-owned default resolved. */
export interface ResolvedPiAiProviderProfile extends PiAiProviderProfile {
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
}

/** Plugin configuration: the non-empty provider profiles this instance owns. */
export interface Config {
  /** Non-empty set of pi-ai provider routes this adapter instance owns. */
  providers: PiAiProviderProfile[]
}

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

const profile = z.object({
  provider: z.string().required(),
  apiKey: z.string(),
  baseURL: z.string(),
  headers: z.dict(z.string()),
  reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.array(profile).required(),
})

/**
 * Validate profiles against the installed pi-ai catalog and return a detached
 * shallow copy suitable for adapter construction.
 * @param profiles - configured provider profiles.
 * @returns validated profiles in configuration order.
 */
export function resolveProfiles(profiles: readonly PiAiProviderProfile[]): ResolvedPiAiProviderProfile[] {
  if (profiles.length === 0) throw new Error('llm-pi-ai: providers must contain at least one profile')
  const supported = new Set<string>(getBuiltinProviders())
  const seen = new Set<string>()
  return profiles.map((source) => {
    const legacy = source as PiAiProviderProfile & {
      maxRetries?: unknown
      maxRetryDelayMs?: unknown
    }
    if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
      throw new Error('llm-pi-ai: maxRetries and maxRetryDelayMs were removed; compose agent recovery with dsh-llm-retry')
    }
    if (source.provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (!supported.has(source.provider)) throw new Error(`llm-pi-ai: unknown pi-ai provider "${source.provider}"`)
    if (seen.has(source.provider)) throw new Error(`llm-pi-ai: duplicate provider profile "${source.provider}"`)
    if (source.apiKey !== undefined && source.apiKey.trim().length === 0) {
      throw new Error(`llm-pi-ai: provider "${source.provider}" has an empty apiKey; omit it to use ambient authentication`)
    }
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${source.provider}" has an empty baseURL`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${source.provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    seen.add(source.provider)
    return {
      ...source,
      streamIdleTimeoutMs,
      ...source.headers === undefined ? {} : { headers: { ...source.headers } },
      ...source.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...source.thinkingBudgets } },
    }
  })
}
