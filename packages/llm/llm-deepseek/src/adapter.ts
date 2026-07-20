/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** One optional model entry advertised by the hand-written adapter. */
export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
}

/** Constructor options for {@link DeepSeekAdapter}; the plugin's `apply` resolves them from Config + environment. */
export interface DeepSeekAdapterOptions {
  /** Bearer token sent in the `authorization` header on every request. */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults?: RequestDefaults
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models?: readonly DeepSeekCatalogModel[]
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * Abort: `options.signal` is handed to fetch — both the initial request and
 * the body stream reject on abort, which surfaces to the loop as a rejected
 * step (the loop already contains step errors).
 */
export class DeepSeekAdapter extends LlmAdapter {
  constructor(private readonly options: DeepSeekAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve((this.options.models ?? []).map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...model.description === undefined ? {} : { description: model.description },
    })))
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, this.options.defaults ?? {})
    // Prepared outside the try so the NETWORK label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
    }

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        ...options.signal ? { signal: options.signal } : {},
      })
    } catch (error: unknown) {
      // An aborted request rethrows its original rejection (the signal's abort
      // reason) so the loop classifies it as cancellation, not a provider failure.
      if (options.signal?.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy) in a bare `TypeError: fetch failed` whose actionable detail
      // lives on `cause`. Wrapping with the endpoint and chaining the cause
      // lets `errorChain` render the full diagnosis at every reporting seam.
      throw new LlmError(
        `DeepSeek API request to ${this.options.baseURL} failed`,
        'NETWORK',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError))
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body))
  }
}
