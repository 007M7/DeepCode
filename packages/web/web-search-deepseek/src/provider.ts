/**
 * `DeepSeekSearchProvider`: a `WebSearchProvider` backed by DeepSeek's
 * Anthropic-compatible Messages API with the native `web_search_20250305` server
 * tool enabled.
 *
 * Unlike a dedicated search endpoint (Exa's `POST /search`, Perplexity's
 * `/chat/completions`), this issues a FULL Messages model call carrying a server
 * tool, so a search costs a complete model turn in latency and tokens. In return
 * DeepSeek runs the search server-side and returns STRUCTURED
 * `web_search_tool_result` blocks — this provider parses those blocks and never
 * scrapes URLs out of model prose. Strict mode: if the response carries no
 * `web_search_tool_result` block (native search did not trigger), it throws
 * `WEB_PROVIDER_ERROR` rather than degrading to prose-scraping.
 *
 * Network requests use platform-native `fetch` (Node 24), mirroring
 * `@deepseek-ai/dsh-llm-deepseek`'s adapter — not a cordis HTTP-client service.
 * The Anthropic wire shape is a provider-private detail and does NOT make this
 * provider depend on `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-web-search-deepseek/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebProviderStatus,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  AnthropicError,
  AnthropicResponse,
  ContentBlock,
  TextBlock,
  WebSearchToolResultBlock,
} from './types.ts'

/** Stable id this provider registers under. */
export const DEEPSEEK_PROVIDER_ID = 'deepseek'

/**
 * Default endpoint: DeepSeek's Anthropic-compatible surface, `/v1` included
 * (`/messages` is appended). This is NOT the chat-completions base
 * (`https://api.deepseek.com`) `@deepseek-ai/dsh-llm-deepseek` uses, so this
 * provider does NOT reuse `$DEEPSEEK_BASE_URL` — only the API key is shared.
 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1'

/** Default Anthropic-format model name (aligned with the repo's DeepSeek model vocabulary). */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash'

/** Default `anthropic-version` header value. */
export const DEEPSEEK_DEFAULT_API_VERSION = '2023-06-01'

/** Default upper bound on generated tokens for the Messages request. */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 4096

/** Default maximum `web_search` server-tool uses per request. */
export const DEEPSEEK_DEFAULT_MAX_USES = 5

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

export interface DeepSeekSearchProviderOptions {
  /** DeepSeek API key. Empty/absent → `status()` reports `missing-credential`. */
  apiKey: string
  /** Endpoint base; `/messages` is appended. */
  baseURL: string
  /** Anthropic-format model name. */
  model: string
  /** `anthropic-version` header value. */
  apiVersion: string
  /** Upper bound on generated tokens for the Messages request. */
  maxTokens: number
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: number
}

/**
 * Build a `url → cited_text` map from every `text` block's `citations[]`. This
 * is the snippet surface: Anthropic `web_search_result` items carry
 * `url`/`title`/`page_age` but typically NO inline snippet — the excerpt lives
 * in a separate `text` block's citation, keyed by `url` (first occurrence wins).
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * Map a DeepSeek Anthropic Messages response to a normalized search result.
 * Walks `web_search_tool_result` blocks for citeable `web_search_result` items,
 * joins each to its citation excerpt as `snippet`, and dedupes by `url` (a
 * `max_uses > 1` request can surface the same URL across searches). The seam
 * owns the final `maxResults` truncation, so `truncated` is always `false` here.
 *
 * Throws `WEB_PROVIDER_ERROR` (strict mode) when no `web_search_tool_result`
 * block is present — native search did not trigger, and prose-scraping is not a
 * fallback.
 */
export function mapAnthropicResponse(query: string, response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { providerId: DEEPSEEK_PROVIDER_ID, query, sources, truncated: false }
}

/** The DeepSeek-backed search provider. */
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly id = DEEPSEEK_PROVIDER_ID

  constructor(private readonly options: DeepSeekSearchProviderOptions) {}

  status(): WebProviderStatus {
    if (this.options.apiKey.length === 0) return { available: false, reason: 'missing-credential' }
    if (!URL.canParse(this.options.baseURL)) return { available: false, reason: 'misconfigured' }
    if (!isPositiveInteger(this.options.maxTokens) || !isPositiveInteger(this.options.maxUses)) return { available: false, reason: 'misconfigured' }
    return { available: true }
  }

  async search(request: WebSearchRequest, exec?: { readonly signal?: AbortSignal }): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/messages`, {
        method: 'POST',
        headers: {
          // Official DeepSeek expects `x-api-key`; an Anthropic-compatible proxy
          // may expect `Authorization: Bearer` — send both so either resolves.
          'x-api-key': this.options.apiKey,
          'authorization': `Bearer ${this.options.apiKey}`,
          'anthropic-version': this.options.apiVersion,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
          }],
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: this.options.maxUses }],
        }),
        ...exec?.signal ? { signal: exec.signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DeepSeek search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DeepSeek search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `DeepSeek API error (HTTP ${status})`
      try {
        const parsed = await response.json() as AnthropicError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('DeepSeek search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as AnthropicResponse
      return mapAnthropicResponse(request.query, payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DeepSeek search aborted', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebError) throw error
      throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for DeepSeek request limits that can be sent to the Messages API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
