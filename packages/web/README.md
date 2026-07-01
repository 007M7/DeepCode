# web/ - web capability family

The web access capability seam: an abstract web interface, search/fetch provider implementations, and the model-facing web tools. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `web/` | Abstract web seam (search/fetch provider registries + selection + vocabulary + `WebError`) | `ctx.web` |
| `web-search-exa/` | Exa-backed `WebSearchProvider` | (registers on `ctx.web`) |
| `web-search-perplexity/` | Perplexity-backed `WebSearchProvider` | (registers on `ctx.web`) |
| `web-search-deepseek/` | DeepSeek-backed `WebSearchProvider` using native `web_search` through the Anthropic-compatible API | (registers on `ctx.web`) |
| `web-fetch-local/` | Anonymous public HTTP(S) `WebFetchProvider` | (registers on `ctx.web`) |
| `tool-web/` | Model-facing `web_search`/`web_fetch` tool schemas | (registers on `ctx.tools`) |

The interface lives at `web/web/`. Unlike bash/fs, the seam spans **two capabilities** (search and fetch) with potentially multiple providers each: `ctx.web` is one web-access middle layer with one provider-selection policy, one abort/error vocabulary, and one product-facing "how this harness reaches the web" config surface. Providers register **capabilities**, not tools; `tool-web` is the only owner of model-facing names, schemas, prompt guidance, and presentation. A search provider swap does not change how the model asks for a query, and a fetch implementation swap does not change how the model asks for a URL.

See the [web capability seam RFC](../../docs/rfc/implemented/architecture/2026-06-24-web-capability-seam.md) for the design rationale, including why search and fetch are deliberately one seam and why `web_fetch`'s SSRF protection is deferred.
