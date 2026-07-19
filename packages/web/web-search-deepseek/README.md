# @deepseek-ai/dsh-web-search-deepseek

A [DeepSeek](https://deepseek.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls DeepSeek's **Anthropic-compatible Messages API** (`POST {baseURL}/messages`) with the native `web_search_20250305` server tool enabled, and maps the structured `web_search_tool_result` blocks DeepSeek returns into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`). The Anthropic wire shape is a provider-private detail — it does **not** make this provider depend on `ctx.llm`.

## How it differs from a dedicated search endpoint

Exa and Perplexity expose dedicated search endpoints; DeepSeek does not. Instead this provider issues a **full Messages model call** carrying the `web_search` server tool, so one search costs a complete model turn in latency and tokens — heavier than a pure retrieval endpoint. DeepSeek runs the search server-side and returns **structured** `web_search_tool_result` blocks; the provider parses those blocks and **never scrapes URLs out of model prose**.

**Strict mode**: if the response carries no `web_search_tool_result` block (native search did not trigger), the provider throws `WebError` `WEB_PROVIDER_ERROR` rather than degrading to prose-scraping — honest and debuggable.

It reuses `$DEEPSEEK_API_KEY` (no new secret) but **not** `$DEEPSEEK_BASE_URL`: the search endpoint is the Anthropic-compatible base (`https://api.deepseek.com/anthropic/v1`), distinct from the chat-completions base (`https://api.deepseek.com`) the LLM adapter uses.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$DEEPSEEK_API_KEY` | DeepSeek API key. Empty/absent makes the provider unavailable. Sent as both `x-api-key` and `Authorization: Bearer` (official vs Anthropic-compatible proxy). |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic-compatible endpoint base; `/messages` is appended. Use a separate env var such as `$DEEPSEEK_SEARCH_BASE_URL` when overriding it; do not reuse `$DEEPSEEK_BASE_URL`, which belongs to the chat-completions LLM adapter. An unparseable value makes the provider unavailable. |
| `model` | `deepseek-v4-flash` | Anthropic-format model name. |
| `apiVersion` | `2023-06-01` | `anthropic-version` header value. |
| `maxTokens` | `4096` | Positive-integer upper bound on generated tokens for the Messages request. |
| `maxUses` | `5` | Positive-integer maximum `web_search` server-tool uses per request. |

```yaml
- id: web-search-deepseek
  name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
    baseURL: !!js process.env.DEEPSEEK_SEARCH_BASE_URL
```

## Mapping

DeepSeek returns no provider-generated answer surface this provider trusts as `content`, so `content` is omitted. `sources[]` comes from `web_search_result` items inside `web_search_tool_result` blocks: `url` ← `url`, `title` ← `title`, and `publishedAt` ← `page_age`. Snippets live separately as URL-keyed `cited_text` entries in a text block's `citations[]`; the provider joins them, leaving `snippet` absent when no excerpt exists.

Results are deduplicated by URL because one request may surface the same page across searches. DeepSeek exposes `maxUses`, not a result-count knob, so the seam enforces `maxResults` by truncating `sources[]` and setting `truncated`.

Provider failures become `WEB_PROVIDER_ERROR`; caller cancellation becomes `WEB_ABORTED`.

## Model Experience

### Auxiliary DeepSeek search request

#### What the model sees

A separate DeepSeek model receives exactly `Perform a web search for the query: <query>` as its user text and one native `web_search` server-tool definition. This request is not part of the conversation model's context.

#### Token effect

Separate provider input and output tokens are incurred for each search; `maxTokens` caps generated output and `maxUses` caps native search uses.

#### KV Cache effect

Independent of the conversation request cache. The auxiliary instruction and native tool definition can form a stable prefix, but each changed query or model route prevents reuse from its first difference.

### Conversation tool result, indirectly

#### What the model sees

Through [`dsh-tool-web`](../tool-web/README.md), the conversation model sees deduplicated URLs, titles, dates, and citation snippets from structured search blocks; provider prose is not trusted as an answer. This provider's exact failures are `DeepSeek search aborted`, `DeepSeek search request failed: <error>`, `DeepSeek returned no web_search_tool_result blocks; the request may not have triggered native web search`, and `DeepSeek returned an unprocessable response body: <error>`; HTTP failures preserve the provider message. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with returned sources and snippets, then the seam enforces the requested source bound.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **One search costs a full Messages model turn** — latency plus generated tokens, with up to `maxUses` server-side searches; DeepSeek exposes no dedicated retrieval endpoint.
- **Over-returned sources still cost tokens** — with no result-count knob on the wire, `maxResults` is enforced only post-hoc by seam truncation.
- **Uncited results carry no `snippet`** — a source gains one only when a `text` block citation (`cited_text`) matches its URL.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
