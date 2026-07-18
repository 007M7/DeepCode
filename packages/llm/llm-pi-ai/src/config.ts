/**
 * Configuration schema and provider-profile validation for the pi-ai adapter.
 *
 * @module dsh-llm-pi-ai/config
 */

import { getProviders } from '@earendil-works/pi-ai'
import type { CacheRetention, ThinkingBudgets, ThinkingLevel, Transport } from '@earendil-works/pi-ai'
import z from 'schemastery'

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
  reasoning?: ThinkingLevel
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
  /** Provider SDK retry count. */
  maxRetries?: number
  /** Maximum provider-requested retry delay in milliseconds. */
  maxRetryDelayMs?: number
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
  reasoning: z.union(['minimal', 'low', 'medium', 'high', 'xhigh']),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  maxRetries: z.natural(),
  maxRetryDelayMs: z.natural(),
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
export function resolveProfiles(profiles: readonly PiAiProviderProfile[]): PiAiProviderProfile[] {
  if (profiles.length === 0) throw new Error('llm-pi-ai: providers must contain at least one profile')
  const supported = new Set<string>(getProviders())
  const seen = new Set<string>()
  return profiles.map((source) => {
    if (source.provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (!supported.has(source.provider)) throw new Error(`llm-pi-ai: unknown pi-ai provider "${source.provider}"`)
    if (seen.has(source.provider)) throw new Error(`llm-pi-ai: duplicate provider profile "${source.provider}"`)
    if (source.apiKey !== undefined && source.apiKey.trim().length === 0) {
      throw new Error(`llm-pi-ai: provider "${source.provider}" has an empty apiKey; omit it to use ambient authentication`)
    }
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${source.provider}" has an empty baseURL`)
    }
    seen.add(source.provider)
    return {
      ...source,
      ...source.headers === undefined ? {} : { headers: { ...source.headers } },
      ...source.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...source.thinkingBudgets } },
    }
  })
}
