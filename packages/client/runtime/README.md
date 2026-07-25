# @deepseek-ai/dsh-client-runtime

Client cordis boot + core services: SlotsService (Service wrapper over SlotCore + 'slots/changed' bridge), SessionsService (list store projection, scope tree, bindings, ancestry), the Session object layer (exported as a type; instances are owned and handed out by SessionsService — the manager/paging internals stay package-internal, tests reach them via src), ClientLoader (`./loader` subpath, statically held by the shell). Contract: api-contracts v3 §4.

## Session title projection

`SessionManager` retains the latest validated `session/title` control snapshot independently of list and session-instance arrival. Newer event seqs replace older snapshots, title timestamps contribute to list recency, and a subscription baseline discards any retained title beyond its `lastSeq` before the optional folded title arrives. Explicit session removal also clears the retained title. The client-facing `SessionSummary.title` is therefore only the actual durable title; `displayTitle` is always present and falls back through the cwd basename and session id. A cold persisted session keeps that fallback until opening or resuming it causes the host to fold and project its log-backed title.

## Model Experience

None, as the client runtime hosts browser-side services and the session object layer; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`loader.unload` is a stub (throws not-implemented)** — the full chain (fiber dispose → registration cascade → style removal) lands with the HMR project.
- **Scope teardown is stage-driven, single-occupant today** — the staged session follows `list.current` exactly (staging is the open signal: the event window opens ⟺ the session is on stage); a removed-while-staged session's scope survives frozen until the stage moves on, not until true observer count reaches zero. Resolution (`cell()`/`binding()`/`scope()`) is pure addressing, render-safe. The staged state can widen to a multi-pane list when concurrent panes land.
- **Value imports of this package from plugin bundles must use the `/client` subpath** — the bare package name is not in the loader externals table and inlines a second module instance, whose private scope-tag Symbol never matches (the empty-state P0 postmortem).
