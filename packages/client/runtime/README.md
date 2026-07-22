# @deepseek-ai/dsh-client-runtime

Client cordis boot + core services: SlotsService (Service wrapper over SlotCore + 'slots/changed' bridge), SessionsService (list store projection, scope tree, bindings, ancestry), Session object layer, ClientLoader (`./loader` subpath, statically held by the shell). Contract: api-contracts v3 §4.

## Session title projection

`SessionManager` retains the latest validated `session/title` control snapshot independently of list and session-instance arrival. Newer event seqs replace older snapshots, title timestamps contribute to list recency, and explicit session removal clears the retained title. The client-facing `SessionSummary.title` is therefore only the actual durable title; `displayTitle` is always present and falls back through the cwd basename and session id. A cold persisted session keeps that fallback until opening or resuming it causes the host to fold and project its log-backed title.

## Model Experience

None, as the client runtime hosts browser-side services and the session object layer; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`loader.unload` is a stub (throws not-implemented)** — the full chain (fiber dispose → registration cascade → style removal) lands with the HMR project.
- **Scope teardown is watch-approximated** — the most recently resolved binding stands in for "who is watching"; a removed-while-watched session's scope survives until the watch moves away, not until true observer count reaches zero.
- **Value imports of this package from plugin bundles must use the `/client` subpath** — the bare package name is not in the loader externals table and inlines a second module instance, whose private scope-tag Symbol never matches (the empty-state P0 postmortem).
