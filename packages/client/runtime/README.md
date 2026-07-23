# @deepseek-ai/dsh-client-runtime

Client cordis boot + core services: SlotsService (Service wrapper over SlotCore + 'slots/changed' bridge), SessionsService (list store projection, scope tree, bindings, ancestry), the Session object layer (exported as a type; instances are owned and handed out by SessionsService — the manager/paging internals stay package-internal, tests reach them via src), ClientLoader (`./loader` subpath, statically held by the shell). Contract: api-contracts v3 §4.

## Model Experience

None, as the client runtime hosts browser-side services and the session object layer; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`loader.unload` is a stub (throws not-implemented)** — the full chain (fiber dispose → registration cascade → style removal) lands with the HMR project.
- **Scope teardown is stage-driven, single-occupant today** — the staged session follows `list.current` exactly (staging is the open signal: the event window opens ⟺ the session is on stage); a removed-while-staged session's scope survives frozen until the stage moves on, not until true observer count reaches zero. Resolution (`cell()`/`binding()`/`scope()`) is pure addressing, render-safe. The staged state can widen to a multi-pane list when concurrent panes land.
- **Value imports of this package from plugin bundles must use the `/client` subpath** — the bare package name is not in the loader externals table and inlines a second module instance, whose private scope-tag Symbol never matches (the empty-state P0 postmortem).
- **`SessionSummary.title` is a display projection** — the wire summary carries no title yet; the cwd basename stands in, then the raw id.
