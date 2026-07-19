/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import {
  getModels,
  streamSimple,
} from '@earendil-works/pi-ai'
import type {
  Api,
  KnownProvider,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** Constructor options for {@link PiAiAdapter}. */
export interface PiAiAdapterOptions {
  /** Validated provider profiles this adapter instance owns. */
  profiles: readonly PiAiProviderProfile[]
}

/**
 * Resolve a catalog model dynamically and apply only the configured endpoint
 * override, preserving the catalog's API/capability/compatibility metadata.
 */
function resolveModel(profile: PiAiProviderProfile, modelId: string): Model<Api> {
  const model = getModels(profile.provider as KnownProvider).find(candidate => candidate.id === modelId) as Model<Api> | undefined
  if (model === undefined) {
    throw new LlmError(`pi-ai provider "${profile.provider}" has no catalog model "${modelId}"`, 'UNKNOWN_MODEL')
  }
  return profile.baseURL === undefined ? model : { ...model, baseUrl: profile.baseURL }
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(profile: PiAiProviderProfile): SimpleStreamOptions {
  return {
    ...profile.apiKey === undefined ? {} : { apiKey: profile.apiKey },
    ...profile.reasoning === undefined ? {} : { reasoning: profile.reasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    ...profile.maxRetries === undefined ? {} : { maxRetries: profile.maxRetries },
    ...profile.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: profile.maxRetryDelayMs },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

/**
 * pi-ai-backed multi-provider adapter. Model descriptors are resolved for each
 * request, so models need not be registered during the Cordis lifecycle.
 */
export class PiAiAdapter extends LlmAdapter {
  private readonly profiles: ReadonlyMap<string, PiAiProviderProfile>

  constructor(options: PiAiAdapterOptions) {
    super()
    this.profiles = new Map(options.profiles.map(profile => [profile.provider, profile]))
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.profiles.get(provider)
    if (profile === undefined) {
      return Promise.reject(new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER'))
    }
    return Promise.resolve(getModels(profile.provider as KnownProvider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
    })))
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const profile = this.profiles.get(options.provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${options.provider}"`, 'NO_ADAPTER')
    }
    const model = resolveModel(profile, options.model)

    // Pi-ai has no iterator-return cancellation hook. Chain an internal signal
    // and abort it when this generator exits so early consumers stop the HTTP stream.
    const controller = new AbortController()
    const onCallerAbort = (): void => { controller.abort(options.signal?.reason) }
    if (options.signal?.aborted) controller.abort(options.signal.reason)
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      const events = streamSimple(model, toPiContext(options), {
        ...profileOptions(profile),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: controller.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      yield* toStreamChunks(events, model.contextWindow)
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort)
      controller.abort('consumer stopped streaming')
    }
  }
}
