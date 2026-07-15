# Web Access

The web access seam — a [capability seam](../rfc/implemented/architecture/2026-06-24-web-capability-seam.md) that spans **two capabilities** (search and fetch) on one `ctx.web` service, split across packages: interface ([dsh-web](../../packages/web/web), `ctx.web` + the provider registries), implementations ([dsh-web-search-exa](../../packages/web/web-search-exa), [dsh-web-search-perplexity](../../packages/web/web-search-perplexity), [dsh-web-search-deepseek](../../packages/web/web-search-deepseek), [dsh-web-fetch-local](../../packages/web/web-fetch-local)), and consumer ([dsh-tool-web](../../packages/web/tool-web), the `web_search`/`web_fetch` tool schemas). Web is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A search-provider swap does not change how the model asks for a query, and a fetch-implementation swap does not change how the model asks for a URL.

Source: [`packages/web/web/src/types.ts`](../../packages/web/web/src/types.ts)

## Why one seam for two capabilities

Search and fetch share no request schema and no business logic, but they are deliberately one `ctx.web` middle layer: one provider-selection policy owner, one abort/error vocabulary, one product-facing "how this harness reaches the web" config surface. The cost is the parallel `searchX`/`fetchX` method pairs on the service; that parallelism is intentional, not a missed extraction. Providers register **capabilities** (a `WebSearchProvider` or `WebFetchProvider`), not tools; the model-facing names, schemas, prompt guidance, and presentation all live in the single `dsh-tool-web` consumer.

## Search request and result

The model-facing tool argument is just a `query`; `maxResults` is a consumer-owned bound (`dsh-tool-web`'s `searchMaxResults` config, default `8`) passed through the seam and enforced on the way back — if a provider over-returns, the seam truncates `sources[]` and sets `truncated`.

```ts type-equiv
interface WebSearchRequest {
  readonly query: string
  /**
   * Upper bound on returned sources; the seam truncates to it. Omitted = no
   * bound. `dsh-tool-web` always sets it.
   */
  readonly maxResults?: number
}
```

```ts type-equiv
interface WebSearchResult {
  readonly content?: string
  readonly sources: readonly WebSearchSource[]
  readonly truncated: boolean
}
```

`content` is optional provider-generated answer text (Exa and DeepSeek return none; Perplexity returns a generated answer). `sources[]` is the portable citation surface. A source always has a `url`; `title`/`snippet`/`publishedAt` are optional because not every provider returns them — Perplexity citations may be URL-only, and forcing adapters to invent the rest would make the seam lie. `dsh-tool-web` renders `title ?? hostname(url)`.

```ts type-equiv
interface WebSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}
```

## Fetch request and result

```ts type-equiv
interface WebFetchRequest {
  readonly url: string
}
```

HTTP status is part of the fetched resource state, not automatically a failure: a successful network fetch of a `404`/`500` returns a `WebFetchResult` with the status code and a bounded decoded body. `url` is the final URL after allowed redirects. `WebError` is reserved for failures to safely retrieve or represent the resource.

```ts type-equiv
interface WebFetchResult {
  readonly url: string
  readonly statusCode: number
  readonly body: WebFetchBody
  readonly truncated: boolean
}
```

`WebFetchBody` is a **closed** discriminated union owned by `dsh-web` (not a merge-extensible map): the provider decodes the kind and `dsh-tool-web` renders it, so a new kind is a coordinated change across known packages, not a plugin extension. Consumers `switch` on `kind` ending in `default: assertNever(...)`, so adding a kind breaks compilation at every consumer until handled. Each arm stays its own object literal even where fields coincide today, leaving room for arm-specific fields later (a future `pdf` body's `pageCount`).

```ts type-equiv
type WebFetchBody =
  | { readonly kind: 'html'; readonly content: string }
  | { readonly kind: 'text'; readonly content: string }
```

## Provider availability

A provider's `available(): boolean` is a cheap LOCAL check (credential presence, parseable config) and **must not make network calls**. It is an input to execution-time selection, not a health system: `search()`/`fetch()` read it to pick a usable provider, and a selection failure surfaces as the structured `WebError` the caller routes on — which carries the branchable detail (the missing id or ambiguous candidate set) in its code and message.

Selection never depends on registration, config, or HMR order: a capability has an explicit provider id (config `searchProvider`/`fetchProvider`, or the matching env var feeding the same field), or auto-selects when exactly one usable provider is registered; multiple usable providers with no configured id is `WEB_PROVIDER_AMBIGUOUS`, not first-wins.

## Errors

`WebError extends HarnessError` ([core.md](core.md) error taxonomy) with a `code: string` (open, like every other seam's error — `LlmError`, `SubagentError`), not a closed union: a provider may raise its own codes without editing `dsh-web`, and consumers must tolerate an unknown code. The codes split by owner. Seam-neutral codes are raised by `WebService` selection and the shared contract: `WEB_PROVIDER_UNAVAILABLE`, `WEB_PROVIDER_CONFIGURED_MISSING`, `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, `WEB_PROVIDER_AMBIGUOUS`, `WEB_DUPLICATE_PROVIDER` (a registration-time programming error, the analogue of `LlmService`'s `DUPLICATE_ADAPTER`), `WEB_ABORTED`, and `WEB_PROVIDER_ERROR` (the catch-all for a provider's own failure surfaced through the seam, including network/transport failure — DNS, connection refused, TLS). Fetch-transport codes are owned by the `dsh-web-fetch-local` implementation and a different fetch backend need not raise them: `WEB_INVALID_URL`, `WEB_BLOCKED_URL`, `WEB_REDIRECT_BLOCKED`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_TIMEOUT`, `WEB_UNSUPPORTED_CONTENT_TYPE`.

## The service

`WebService` registers search and fetch providers, rejects duplicate ids with `WEB_DUPLICATE_PROVIDER`, and resolves providers at execution time with structured selection errors. The local fetch backend accepts only HTTP(S), rejects credentials, caps redirects, bytes, characters, and time, revalidates every same-origin redirect hop, and decodes the body; the tool owns presentation. Private-network blocking is deferred, so do not enable `web_fetch` where it can reach sensitive internal targets.
