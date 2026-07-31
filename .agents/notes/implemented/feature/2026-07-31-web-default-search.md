# Agent Note: Default Web search and fetch in the Web/headless composition

Status: implemented

English | [中文](2026-07-31-web-default-search.zh.md)

## Problem

The harness had a complete Web capability family—provider registry, DeepSeek/Exa/Perplexity search providers, local fetch, stable model tools, and structured result presentation—but the shipped `dsh web` composition mounted none of it. The model could not discover current information or follow a source URL unless a deployment supplied a custom overlay. Merely mounting the existing DeepSeek provider would not complete the WebUI path: the Models page stores `DEEPSEEK_API_KEY` through `ctx.credentials`, while the search provider froze only the process environment at plugin load, so a key entered or rotated in the running UI would not reach search.

## Decision

`apps/cli/config/web.cordis.yml` explicitly mounts `dsh-web` with `searchProvider: deepseek-official` and `fetchProvider: local-http`, `dsh-web-search-deepseek`, `dsh-web-fetch-local`, and `dsh-tool-web`. The shared overlay makes `web_search` and `web_fetch` defaults for both browser and headless sessions; the TUI composition remains unchanged. Explicit provider ids keep selection independent of registration order and leave personal or `--config` overlays able to replace or disable the rows.

DeepSeek search uses the same `DEEPSEEK_API_KEY` credential reference as the official conversation adapter. The provider resolves that reference inside every search through the optional `ctx.credentials` service; only a composition without the seam falls back to the launching process environment, and a non-empty literal `apiKey` remains the programmatic last resort. A stored or rotated Web Models key therefore reaches the next search without restarting or retaining the value on the provider. Because `WebSearchProvider.available()` is synchronous, it treats an installed resolver as locally usable and missing dynamic credentials fail the operation with the provider-specific `WEB_PROVIDER_CREDENTIAL_MISSING` code while the stable tool schema stays registered.

Search keeps its endpoint distinct from chat completions: `DEEPSEEK_SEARCH_BASE_URL` overrides the Anthropic-compatible base, while `DEEPSEEK_BASE_URL` continues to configure conversation requests. Each `web_search` performs an auxiliary DeepSeek Messages call with the native search server tool. `web_fetch` uses the existing anonymous local HTTP(S) provider so a search result can be retrieved without another vendor account.

The default mount does not create a Web-specific permission policy. These tools execute outside the bash/filesystem sandbox and approval presets, following `dsh-tool-web`'s existing contract. The shipped deployment already defaults to `danger-full-access`; a future restricted-network product stance must add a `tools/pre-execute` policy or capability-specific network confinement rather than implying that filesystem access mode governs Web calls.

## Alternatives considered

**Mount only `dsh-tool-web`.** Rejected because stable schemas without registered providers would make every default call fail; enablement and backend availability are deliberately separate, but a shipped default must supply its intended implementations.

**Read `$DSH_HOME/.env` from `cordis.yml` or hoist it into `process.env`.** Rejected because the credential provider owns that document, environment values are read-only overrides, and hoisting would make stored keys unrotatable while bypassing the audited secret boundary.

**Freeze `process.env.DEEPSEEK_API_KEY` at provider load.** Rejected because the Web Models page writes through `ctx.credentials`; the product's documented first-run path must make the next operation work without a restart.

**Mount Web tools in `base.cordis.yml`.** Rejected because that would also change the TUI deployment. The browser and headless entries already share `web.cordis.yml`; they gain the capability together while TUI remains an explicit later decision.

**Enable search without fetch.** Rejected because search snippets are discovery context, not page bodies, and the stable search guidance directs the model to fetch a relevant result before relying on its full content.

## Consequences

Web/headless model requests carry the `web_search` and `web_fetch` schemas plus their fixed prompt guidance in native mode; Code Mode exposes the same capabilities beneath `run_code`. Search adds a complete auxiliary model call and may use the native server tool multiple times, while fetch adds anonymous outbound HTTP(S) access subject to the local provider's redirect, size, timeout, and content-type rules. The Web snapshot lane boots the shipped tree, drives a replayed `web_search` call through the real DeepSeek provider against a local Messages fixture, asserts the durable structured result, and pins the settled browser presentation. Provider tests pin missing, stored, and rotated credential behavior plus literal and ambient compatibility.
