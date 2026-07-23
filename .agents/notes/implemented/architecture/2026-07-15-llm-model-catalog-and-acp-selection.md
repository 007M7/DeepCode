# Agent Note: Advisory LLM catalogs and per-session ACP model selection

Status: implemented

English | [中文](2026-07-15-llm-model-catalog-and-acp-selection.zh.md)

> The catalog decision remains current. Per-session ACP model selection is superseded by [ACP as an automation-only protocol](../simplification/2026-07-23-acp-automation-only-protocol.md).

## Problem

Provider-routed adapters let every request choose `provider + model`, but `LlmService` exposed only routing and streaming. A UI could not discover which providers were registered or which models an adapter was prepared to recommend. ACP clients therefore received no `model` session config option, so Zed, JetBrains, and VS Code integrations had no model list even though the request seam already supported runtime switching.

Model discovery cannot become request validation. The hand-written DeepSeek adapter deliberately forwards arbitrary model ids to a public or private endpoint, while pi-ai has a finite installed catalog that is authoritative for its own request resolution. Treating one shared catalog as a whitelist would remove the private-endpoint behavior that provider routing was designed to preserve.

ACP selection must also preserve the provider dimension. The same model id may appear under multiple routes, and switching a global adapter or agent template would leak one editor session's choice into every other session. Prompt variables and request routing must change together; a selection that lands during asynchronous prompt assembly cannot make `{{model}}` name one model while the request reaches another.

## Decision

### Provider-neutral advisory discovery

`LlmAdapter` gains `providerInfo(provider)` and asynchronous `listModels(provider)` methods. Their provider-neutral results are `LlmProviderInfo { id, name }` and `LlmModelInfo { provider, id, name, description? }`. The defaults preserve existing adapter behavior by naming a provider after its route and advertising no models.

`LlmService.listProviders()` returns detached metadata in registration order. `LlmService.listModels(provider)` delegates to the route owner, validates non-empty ids and names, rejects a mismatched provider or duplicate model id with `INVALID_CATALOG`, and returns detached values. Unknown providers still fail with `NO_ADAPTER`. Provider metadata is validated atomically during `registerAdapter()` so a malformed display record cannot leave a partial registration.

Catalog membership is advisory. It drives selectors and diagnostics but never changes `stream()` routing and never rejects an otherwise valid request. Provider ownership remains exclusive and lifecycle-bound; model ids remain request-time adapter input.

`dsh-llm-pi-ai` maps the configured provider's installed `getModels(provider)` entries into the neutral catalog. Its existing request-time catalog lookup remains authoritative and still rejects unknown models with `UNKNOWN_MODEL`. `dsh-llm-deepseek` accepts an optional `models` config containing display entries, defaulting to `deepseek-v4-flash` and `deepseek-v4-pro`. An explicit list replaces those defaults and an empty list disables discovery. The entries improve selector UX for known public or private models, while every unlisted model id continues to pass through unchanged.

### ACP transport boundary

The ACP automation transport is not a catalog consumer. Its deployment config supplies one optional provider/model target for newly created agents, and it advertises no model selector or configuration-option interface. TUI, Web, SDK hosts, and other human-facing consumers may use the advisory catalog through their own interaction contracts.

## Alternatives considered

**Make catalogs mandatory whitelists.** This conflicts with the hand-written adapter's arbitrary model pass-through and private deployments. The selected adapter already owns authoritative request validation.

## Consequences

- Any adapter can expose a dynamic model list without leaking provider-library types into the core seam.
- Catalog consumers must treat absence as “not advertised,” never “invalid request.”
- pi-ai adapters expose their installed provider catalogs; hand-written DeepSeek deployments list known choices explicitly and retain arbitrary model support.
- Human-facing catalog consumers own their selection interaction. ACP uses its fixed deployment target and does not widen the protocol with model discovery.
- A catalog read can be asynchronous, and every caller receives detached values.

## Testing

Unit coverage validates catalog detachment and malformed metadata plus pi-ai and DeepSeek catalog projection. ACP transport tests validate fixed provider/model forwarding independently of catalog discovery.
