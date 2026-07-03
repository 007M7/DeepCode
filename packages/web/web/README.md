# @deepseek-ai/dsh-web

The **web access seam**: an abstract `WebService` (`ctx.web`) defining WHAT web access the harness has — search the web, fetch a URL — over multiple providers, without binding the model contract to one vendor's API shape.

This package is the interface third of the web capability. Unlike bash/fs it spans two capabilities (search and fetch) on one seam, with potentially multiple providers each:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-web` (this) | the interface: the service, provider registries, selection policy, request/result vocabulary, the `WebError` taxonomy |
| `@deepseek-ai/dsh-web-search-exa` | a search implementation: Exa |
| `@deepseek-ai/dsh-web-search-perplexity` | a search implementation: Perplexity |
| `@deepseek-ai/dsh-web-fetch-local` | a fetch implementation: anonymous public HTTP(S) |
| `@deepseek-ai/dsh-tool-web` | the model-facing `web_search` / `web_fetch` tool schemas over `ctx.web` |

Search and fetch share no request schema and no business logic, but they are deliberately one seam: `ctx.web` is a single web-access middle layer with one provider-selection policy owner, one abort/error vocabulary, and one product-facing "how this harness reaches the web" config surface. The cost is the parallel `Search`/`Fetch` method pairs; that parallelism is intentional, not a missed extraction.

## Service API (`ctx.web`)

| Member | Semantics |
|---|---|
| `registerSearchProvider(provider)` / `registerFetchProvider(provider)` | Register a backend. Throws `WebError` `WEB_DUPLICATE_PROVIDER` on a duplicate id within that capability kind. Returns a disposer; emits `web/providers-change` on register and on dispose. Disposed with the calling fiber. |
| `searchStatus()` / `fetchStatus()` | Derived (never stored) `WebCapabilityStatus`: whether the capability has a selected usable provider, or the broad category it fails in. Diagnostics + execution-resolution input. |
| `search(request, exec?)` | Resolve the search provider and run one search. Enforces `request.maxResults` on the result (truncates `sources[]`, sets `truncated`). Throws `WebError` when the capability cannot run. |
| `fetch(request, exec?)` | Resolve the fetch provider and retrieve one URL. A non-2xx response is a result, not a throw. Throws `WebError` for failures to safely retrieve or represent the resource. |

Providers register **capabilities**, not tools. `dsh-tool-web` is the only owner of model-facing names, descriptions, prompt guidance, JSON schemas, and presentation.

## Selection

Selection never depends on registration, config, or HMR order. A capability has an explicit provider id (config `searchProvider`/`fetchProvider`, or env `$DSH_WEB_SEARCH_PROVIDER`/`$DSH_WEB_FETCH_PROVIDER` feeding the same fields), or auto-selects when exactly one usable provider is registered:

| Situation | `WebCapabilityStatus` | Execution |
|---|---|---|
| configured id registered and `status().available` | `available` for it | runs |
| configured id not registered | `configured-missing` | `WEB_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `configured-unavailable` | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| no id, exactly one registered usable provider | `available` for it | runs |
| no id, no usable provider | `none` | `WEB_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `ambiguous` | `WEB_PROVIDER_AMBIGUOUS` |

`WebCapabilityStatus` carries only `available` + a `reason` discriminant (plus the winning `providerId` on the available branch). The branchable per-reason detail lives in the thrown `WebError`, which is the surface callers route on — so the same fact never gets two homes that can disagree. A provider's own `status()` is a cheap local check (credential presence, parseable config) and **must not make network calls**; `dsh-tool-web` reads only the aggregated `searchStatus()`/`fetchStatus()`, never each provider's `status()` directly.

## Vocabulary

`WebSearchRequest` (`query`, `maxResults?`) → `WebSearchResult` (`providerId`, `query`, `content?`, `sources[]`, `truncated`); each `WebSearchSource` has a required `url` and optional `title`/`snippet`/`publishedAt` (Perplexity citations may be URL-only). `WebFetchRequest` (`url`, `timeoutMs?`) → `WebFetchResult` (`providerId`, final `url`, `statusCode`, `body`, `truncated`); `WebFetchBody` is a CLOSED discriminated union (`html` | `text`) owned here — consumers `switch` to exhaustiveness so a new kind breaks their compilation until handled. See `src/types.ts` for the full contracts and the `WebError` code taxonomy.
