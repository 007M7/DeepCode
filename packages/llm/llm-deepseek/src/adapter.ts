/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.ts'
import type { RequestDefaults } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError } from './types.ts'

/** Constructor options for {@link DeepSeekAdapter}; the plugin's `apply` resolves them from Config + environment. */
export interface DeepSeekAdapterOptions {
  /** Bearer token sent in the `authorization` header on every request. */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults?: RequestDefaults
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @returns `AUTH` (401/403), `RATE_LIMIT` (429), `INVALID_REQUEST` (400), `SERVER` (5xx), or `HTTP_<status>` for anything else.
 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
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

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, this.options.defaults ?? {})

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    const response = await fetch(`${this.options.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...attributionHeaders(),
      },
      body: JSON.stringify(body),
      ...options.signal ? { signal: options.signal } : {},
    })

    if (!response.ok) {
      const code = httpErrorCode(response.status)
      let message = `DeepSeek API error (HTTP ${response.status})`
      try {
        const parsed = await response.json() as WireError
        if (parsed.error?.message) message = parsed.error.message
      } catch {
        // Only swallow error-body parsing: status and code are already captured,
        // so malformed gateway JSON must not mask the actionable HTTP failure.
      }
      throw new LlmError(message, code, response.status)
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body))
  }
}
