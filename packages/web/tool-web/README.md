# @deepseek-ai/dsh-tool-web

The model-facing web tool suite — `web_search` and `web_fetch` — over the [web capability seam](../web/README.md) (`ctx.web`). It owns model-facing concerns only: tool names, JSON schemas, snake_case argument names, prompt sections, the result-count bound, result formatting, HTML→markdown presentation, and `presentCall`. All web access goes through `ctx.web`; this package never imports a concrete provider.

Each tool is registered independently; a product that wants only one disables the other via config (`{ search: false }` / `{ fetch: false }`).

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `web_search` | `query` (string) | Discovery. Returns an optional answer plus source URLs. `max_results` is **not** model-facing — the tool sets the bound (the `searchMaxResults` config, default 8) and passes it to the seam. |
| `web_fetch` | `url` (string), `timeout_ms` (number, optional) | Retrieves a specific URL. HTML bodies are rendered to markdown-ish text; text bodies pass through. A non-2xx status is reported, not an error. |

## Config

| Key | Default | Meaning |
|---|---|---|
| `search` | `true` | Register `web_search`. |
| `fetch` | `true` | Register `web_fetch`. |
| `searchMaxResults` | `8` | Upper bound on sources returned by one `web_search` call (the seam truncates a longer provider list and flags it). |

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
```

## Stable registration

Tool registration follows product **enablement**, not backend availability. A tool stays visible even when its selected provider is missing, misconfigured, ambiguous, or temporarily unavailable; the seam resolves the provider at execution time and execution fails with a structured `WebError` (e.g. `WEB_PROVIDER_UNAVAILABLE`, `WEB_PROVIDER_AMBIGUOUS`), which `ToolRegistry.execute()` turns into an error tool result the model can read and hooks/UI can route on. This keeps the model schema stable without making plugin load order, credential state, or HMR timing part of the model-facing contract. To remove a web tool entirely, disable it here in config.

The tool never calls a provider's `status()` and never enumerates providers — its only execution path is `ctx.web.search()` / `ctx.web.fetch()`, and provider unavailability reaches it as the structured `WebError` codes selection throws at execution time. Provider selection stays entirely inside the seam, with one owner.
