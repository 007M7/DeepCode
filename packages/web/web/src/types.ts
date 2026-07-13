/**
 * Vocabulary for the web capability seam (`ctx.web`): the search/fetch
 * request/result shapes providers produce and consumers format, provider
 * availability, direct cancellation control, and the typed error taxonomy.
 *
 * These types are shared by every provider backend
 * (`@deepseek-ai/dsh-web-search-exa`, `@deepseek-ai/dsh-web-search-perplexity`,
 * `@deepseek-ai/dsh-web-fetch-local`, and future backends) and by the
 * model-facing consumer (`@deepseek-ai/dsh-tool-web`). Search and fetch share no
 * request schema and no business logic, but they are deliberately one seam:
 * `ctx.web` is a single web-access middle layer with one provider-selection
 * policy, one abort/error vocabulary, and one product-facing configuration
 * point. The cost is the parallel `Search`/`Fetch` shapes below; that
 * parallelism is intentional.
 *
 * @module @deepseek-ai/dsh-web/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

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
 * What one fetch-capable backend is asked to retrieve. The request deliberately
 * omits timeout, format, prompt, and extraction controls: cancellation is a
 * direct execution argument, while presentation and higher-level LLM concerns
 * belong outside safe retrieval.
 */
export interface WebFetchRequest {
  readonly url: string
}

/**
 * Normalized fetch outcome. A successful network fetch of a non-2xx response is
 * a result, not an error: the status code is part of the fetched resource
 * state. {@link WebError} is reserved for failures to safely retrieve or
 * represent the resource.
 */
export interface WebFetchResult {
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
 * A search-capable backend. Registered with `ctx.web.registerSearchProvider`.
 * `id` is a stable string, unique within the search capability kind.
 */
export interface WebSearchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Run one search; honor `signal` for cancellation. */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/**
 * A fetch-capable backend. Registered with `ctx.web.registerFetchProvider`.
 * `id` is a stable string, unique within the fetch capability kind.
 */
export interface WebFetchProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /** Retrieve one URL; honor `signal` for cancellation. */
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

/**
 * Typed web error. Extends {@link HarnessError} so it carries a stable,
 * machine-routable `code` (a `string`, like every other seam's error) and
 * chains `cause`. `ToolRegistry.execute()` converts a thrown `WebError` into an
 * error tool result whose structured metadata exposes the code, so callers
 * (hooks, tests, UI) route on it.
 *
 * The `code` is an open `string`, NOT a closed union: a provider may raise its
 * own codes without editing this package, and a consumer must tolerate an
 * unknown code (a future provider will introduce ones this file never named).
 * The codes split by who owns them — seam-neutral codes any provider may see,
 * versus codes specific to a single implementation:
 *
 * Seam-neutral (raised by `WebService` selection and the shared contract):
 * - `WEB_PROVIDER_UNAVAILABLE`: no provider configured and none usable.
 * - `WEB_PROVIDER_CONFIGURED_MISSING`: a configured id is not registered.
 * - `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`: a configured id is registered but its
 *   `available()` returns false.
 * - `WEB_PROVIDER_AMBIGUOUS`: no id configured and multiple usable providers
 *   exist (selection refuses to pick by registration order).
 * - `WEB_DUPLICATE_PROVIDER`: a registration-time programming error — an id is
 *   already registered for that capability kind.
 * - `WEB_ABORTED`: the operation was aborted via its optional signal.
 * - `WEB_PROVIDER_ERROR`: catch-all for a provider's own failure surfaced
 *   through the seam, including network/transport failure (DNS, connection
 *   refused, TLS).
 *
 * Fetch-transport codes (owned by the `dsh-web-fetch-local` implementation; a
 * different fetch backend need not raise these and may raise its own):
 * - `WEB_INVALID_URL`: the fetch URL is malformed or not http(s).
 * - `WEB_BLOCKED_URL`: the fetch URL is rejected by policy (credentials in URL).
 * - `WEB_REDIRECT_BLOCKED`: a cross-origin redirect was refused.
 * - `WEB_FETCH_TOO_LARGE`: the response exceeded the byte/character cap.
 * - `WEB_FETCH_TIMEOUT`: the fetch exceeded its timeout.
 * - `WEB_UNSUPPORTED_CONTENT_TYPE`: the response content type cannot be decoded.
 */
export class WebError extends HarnessError {}
