# @deepseek-ai/dsh-web-search-deepseek

A [DeepSeek](https://deepseek.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls DeepSeek's **Anthropic-compatible Messages API** (`POST {baseURL}/messages`) with the native `web_search_20250305` server tool enabled, and maps the structured `web_search_tool_result` blocks DeepSeek returns into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`). The Anthropic wire shape is a provider-private detail — it does **not** make this provider depend on `ctx.llm`.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| Auxiliary DeepSeek search request | A separate DeepSeek model receives the search query and native `web_search` server-tool definition. This request is not part of the conversation model's context. | Separate provider input and output tokens are incurred for each search; `maxTokens` caps generated output and `maxUses` caps native search uses. |
| Conversation tool result, indirectly | Through `dsh-tool-web`, the conversation model sees deduplicated URLs, titles, dates, and citation snippets from structured search blocks; provider prose is not trusted as an answer. | Zero direct conversation tokens from registration. Result tokens scale with returned sources and snippets, then the seam enforces the requested source bound. |

## How it differs from a dedicated search endpoint

Exa and Perplexity expose dedicated search endpoints; DeepSeek does not. Instead this provider issues a **full Messages model call** carrying the `web_search` server tool, so one search costs a complete model turn in latency and tokens — heavier than a pure retrieval endpoint. DeepSeek runs the search server-side and returns **structured** `web_search_tool_result` blocks; the provider parses those blocks and **never scrapes URLs out of model prose**.

**Strict mode**: if the response carries no `web_search_tool_result` block (native search did not trigger), the provider throws `WebError` `WEB_PROVIDER_ERROR` rather than degrading to prose-scraping — honest and debuggable.

It reuses `$DEEPSEEK_API_KEY` (no new secret) but **not** `$DEEPSEEK_BASE_URL`: the search endpoint is the Anthropic-compatible base (`https://api.deepseek.com/anthropic/v1`), distinct from the chat-completions base (`https://api.deepseek.com`) the LLM adapter uses.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$DEEPSEEK_API_KEY` | DeepSeek API key. Empty/absent → provider `status()` reports `missing-credential`. Sent as both `x-api-key` and `Authorization: Bearer` (official vs Anthropic-compatible proxy). |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Anthropic-compatible endpoint base; `/messages` is appended. Use a separate env var such as `$DEEPSEEK_SEARCH_BASE_URL` when overriding it; do not reuse `$DEEPSEEK_BASE_URL`, which belongs to the chat-completions LLM adapter. An unparseable value makes `status()` report `misconfigured`. |
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

DeepSeek returns no provider-generated answer surface this provider trusts as `content`, so `content` is omitted. `sources[]` is built from the `web_search_result` items inside `web_search_tool_result` blocks: `url` ← `url`, `title` ← `title`, `publishedAt` ← `page_age`. The per-source `snippet` lives separately in a `text` block's `citations[]` (a `cited_text` keyed by `url`), so the provider joins the two — a result with no citation excerpt simply has no `snippet`. Results are deduped by `url` (a `maxUses > 1` request can surface the same URL across searches). DeepSeek's `web_search` has no result-count knob (only `maxUses`), so `maxResults` is enforced by the seam (truncating `sources[]` and setting `truncated`). Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`.
