# @deepseek-ai/dsh-web-search-perplexity

A [Perplexity](https://perplexity.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Perplexity's OpenAI-compatible `POST /chat/completions` endpoint and maps the generated answer plus citations into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the key and it does not register a model-facing tool. Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`). The OpenAI-compatible wire shape is a provider-private detail — it does **not** make this provider depend on `ctx.llm`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$PERPLEXITY_API_KEY` | Perplexity API key. Empty/absent → provider `status()` reports `missing-credential`. |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; `/chat/completions` is appended. An unparseable value makes `status()` report `misconfigured`. |
| `model` | `sonar` | Search model name. |
| `maxTokens` | `1024` | Upper bound on generated answer tokens (`max_tokens`). Must be a positive integer. |
| `searchRecency` | (unset) | Recency window sent as `search_recency_filter`: `day`, `week`, `month`, or `year`. Unset sends no filter. |

```yaml
- id: web-search-perplexity
  name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKey: !!js process.env.PERPLEXITY_API_KEY
```

## Mapping

`content` ← `choices[0].message.content` (the generated answer). `sources[]` prefers the structured `search_results[]` (`url`, `title`, `snippet`, `publishedAt` ← `date`), falling back to the URL-only `citations[]` array only when `search_results` is absent — those sources carry just a `url`, which is why `title`/`snippet`/`publishedAt` are optional on the seam. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. Perplexity has no result-count control, so `maxResults` is enforced by the seam (truncating `sources[]` and setting `truncated`).
