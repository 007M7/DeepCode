/**
 * Configuration schema and provider-profile validation for the pi-ai adapter.
 * Profiles are a dict keyed by provider route, so the composition base and a
 * user-settings layer merge per provider and the route set is structural.
 *
 * @module dsh-llm-pi-ai/config
 */

import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import type { CacheRetention, ModelThinkingLevel, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'
import z from 'schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Configuration for one pi-ai provider route; the `providers` dict key IS the route. */
export interface PiAiProviderProfile {
  /** Literal provider credential; prefer {@link apiKeyEnv}. With both absent pi-ai uses its provider-native ambient discovery. */
  apiKey?: string
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
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
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

/** Validated profile with its route stamped and every adapter-owned default resolved. */
export interface ResolvedPiAiProviderProfile extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy'> {
  /** pi-ai provider catalog name and Harness route key (the configuration dict key). */
  provider: string
  /** Validated credential reference, when one is configured. */
  apiKeyEnv?: CredentialRef
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
}

/** Plugin configuration: the provider routes this instance owns. */
export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers?: Record<string, PiAiProviderProfile>
}

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

const profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
  headers: z.dict(z.string()),
  reasoning: z.union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  providers: z.dict(profile).default({}),
})

/**
 * Validate profiles against the installed pi-ai catalog and return a detached
 * route-keyed map suitable for per-request reads. This is the one explicit
 * resolve step, so an omitted dict resolves to the empty (dormant) route set
 * here rather than through a hidden fallback.
 * @param providers - configured provider profiles keyed by route.
 * @returns validated profiles in configuration order.
 */
export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
): Map<string, ResolvedPiAiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const supported = new Set<string>(getBuiltinProviders())
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    const legacy = source as PiAiProviderProfile & {
      provider?: unknown
      maxRetries?: unknown
      maxRetryDelayMs?: unknown
    }
    if ('provider' in legacy) {
      throw new Error('llm-pi-ai: the profile "provider" field moved to the providers dict key')
    }
    if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
      throw new Error('llm-pi-ai: maxRetries and maxRetryDelayMs were removed; compose agent recovery with dsh-llm-retry')
    }
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (!supported.has(provider)) throw new Error(`llm-pi-ai: unknown pi-ai provider "${provider}"`)
    if (source.apiKey !== undefined && source.apiKey.trim().length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty apiKey; omit it to use ambient authentication`)
    }
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const { apiKeyEnv, retryPolicy, ...rest } = source
    resolved.set(provider, {
      ...rest,
      provider,
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
    })
  }
  return resolved
}
