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

export interface DeepSeekAdapterOptions {
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults?: RequestDefaults
}

/** Map an HTTP status to a stable LlmError code. */
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

    // TODO(http): deliberately raw `fetch` for the hand-rolled SSE body.
    // `@cordisjs/plugin-http` (ctx.http) would give proxy/intercept/timeout
    // uniformity AND can stream (`responseType: 'stream'` yields the same
    // ReadableStream<Uint8Array> parseSse consumes), but adopting it today
    // costs a hard `undici` dependency (it does `require('undici')` with no
    // globalThis.fetch fallback) plus an unconditional `@cordisjs/fetch-file`
    // import (pulling file-type + mime-types) for a file:// path we never hit.
    // Revisit when a second adapter wants shared proxy/intercept config.
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
        // Paranoid by design: `code` and the HTTP status are ALREADY captured
        // above (and passed to LlmError below), so the only thing this `try`
        // can add is a richer provider-supplied message. A malformed, empty,
        // or non-JSON error body is a normal thing for gateways/proxies to
        // return on a 5xx/429 — swallowing the parse failure keeps the usable
        // status-line message instead of letting a JSON.parse throw mask the
        // real HTTP error. Nothing else reaches this catch: response.json()
        // is the sole statement, and any non-parse failure (e.g. body already
        // consumed) is equally non-actionable here.
      }
      throw new LlmError(message, code, response.status)
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body))
  }
}
