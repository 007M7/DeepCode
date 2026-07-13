/**
 * Vocabulary for the web capability seam (`ctx.web`). Search and fetch deliberately share one
 * seam so provider selection, cancellation, errors, and product configuration have one owner,
 * while retaining separate request and result shapes.
 * @module @deepseek-ai/dsh-web/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Execution control threaded from the tool layer through the seam into a
 * provider's network requests, stream readers, and expensive decoding. It is
 * NOT business input: the first version carries only `signal` so `tool-web` can
 * propagate turn cancellation, tool timeout, and agent disposal. It deliberately
 * does NOT carry `ToolExecution`, which would make `dsh-web` depend on
 * `dsh-tools`.
 */
export interface WebExecContext {
  /** Abort signal a provider must honor for its network/decoding work. */
  readonly signal?: AbortSignal
}

/**
 * What one search-capable backend can return. The model-facing argument is just
 * a query; `maxResults` is a `dsh-tool-web`-layer bound passed through unchanged
 * and enforced on the way back by the seam (see {@link WebSearchResult}).
 */
export interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it. A provider whose API supports a
   * result-count control (Exa's `numResults`) should apply it at the request
   * layer as a cost/latency optimization; the seam enforces the bound
   * regardless.
   */
  readonly maxResults?: number
}

/**
 * Normalized search outcome. `content` is optional provider-generated answer
 * text or summary (Exa returns none; Perplexity returns a generated answer).
 * `sources[]` is the portable citation surface. `truncated` is set by the seam
 * when it cut `sources[]` down to `maxResults`.
 */
export interface WebSearchResult {
  /** Id of the provider that produced this result. */
  readonly providerId: string
  /** Echo of the query the provider answered. */
  readonly query: string
  /** Optional provider-generated answer text, search context, or summary. */
  readonly content?: string
  /** Citeable sources, already truncated to the request's `maxResults`. */
  readonly sources: readonly WebSearchSource[]
  /** True when the seam dropped sources to honor `maxResults`. */
  readonly truncated: boolean
}

/**
 * One citeable source. A source always has a URL; `title`, `snippet`, and
 * `publishedAt` are optional because not every provider returns them — forcing
 * adapters to invent them would make the seam lie (Perplexity citations may be
 * URL-only). `dsh-tool-web` renders `title ?? hostname(url)` for display.
 */
export interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string. */
  readonly publishedAt?: string
}

/**
 * What one fetch-capable backend is asked to retrieve. `timeoutMs` is an
 * optional positive hint the provider caps. The request deliberately omits
 * `format`, `prompt`, and extraction controls — those are presentation or
 * higher-level LLM concerns, not safe-retrieval inputs.
 */
export interface WebFetchRequest {
  readonly url: string
  readonly timeoutMs?: number
}

/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
export interface WebFetchResult {
  /** Id of the provider that produced this result. */
  readonly providerId: string
  /** The final URL after allowed redirects (the request URL is in the request). */
  readonly url: string
  /** HTTP status code of the fetched response. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: WebFetchBody
  /** True when the provider capped the decoded body. */
  readonly truncated: boolean
}

/**
 * The decoded body of a fetched resource. A CLOSED discriminated union owned by
 * `dsh-web`: the provider decodes the kind and `dsh-tool-web` renders it, so a
 * new kind is a coordinated change across known packages, not a plugin
 * extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`
 * so adding a kind breaks compilation at every consumer until handled. Each arm
 * stays its own object literal even where fields coincide today, leaving room
 * for arm-specific fields later (a `pdf` body's `pageCount`).
 */
export type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }

/**
 * Whether one concrete provider implementation is usable, by cheap local checks
 * only (credential presence, parseable endpoint config). A provider `status()`
 * must NOT make network calls. It is an input to execution-time selection, not
 * a health system: `WebService.search()`/`fetch()` read it to pick a usable
 * provider, and selection failure surfaces as the structured {@link WebError}
 * codes callers route on.
 */
export type WebProviderStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'missing-credential' | 'misconfigured' }

/**
 * A search-capable backend. Registered with `ctx.web.registerSearchProvider`.
 * `id` is a stable string, unique within the search capability kind.
 */
export interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  status(): WebProviderStatus
  /** Run one search; honor `exec.signal` for cancellation. */
  search(request: WebSearchRequest, exec?: WebExecContext): Promise<WebSearchResult>
}

/**
 * A fetch-capable backend. Registered with `ctx.web.registerFetchProvider`.
 * `id` is a stable string, unique within the fetch capability kind.
 */
export interface WebFetchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  status(): WebProviderStatus
  /** Retrieve one URL; honor `exec.signal` for cancellation. */
  fetch(request: WebFetchRequest, exec?: WebExecContext): Promise<WebFetchResult>
}

/**
 * Typed web error with a machine-routable, open-string `code` and chained `cause`.
 * Consumers must tolerate provider-specific codes. Shared codes cover unavailable,
 * missing, unusable, ambiguous, or duplicate providers, cancellation, and provider failure;
 * the local fetch provider additionally distinguishes invalid or blocked URLs, redirects,
 * size and timeout limits, and unsupported content types. Tool execution exposes the code in
 * structured error metadata.
 */
export class WebError extends HarnessError {}
