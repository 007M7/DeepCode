# @deepseek-ai/dsh-client-runtime

Client cordis boot and React-free object services: SlotsService wraps SlotCore and supplies renderer data sources; SessionsService owns Session objects, list/scope/history state, and page-local Session Intent state; WorkspacesService depends on SessionsService and owns Workspace objects, list/actions, page-local Workspace Intent state, default-target derivation, and the cross-object New Session flow. The runtime fans the shared Host stream into both managers. Contract: api-contracts v3 §4.

## Workspace and Session lists

Workspace and Session lists have independent monotone `pending` → `ready` baseline phases and separate refresh activity/error state. Incremental frames arriving during a list request replay over its response. The first successful baseline establishes Host order; later refreshes update rows and membership without changing the relative order of identities already shown. Workspace recency is derived only after both baselines are ready and never changes Workspace list order.

SlotsService gives the renderer separate bare observables for `useSessions` and `useWorkspaces`; web-react creates the hooks. Workspace business state does not enter `SessionListState` or an entry store.

## Session creation failures

`SessionsService.create` accepts an optional caller-preallocated SessionId. It throws `SessionCreateError` on failure: `requestedSessionId` remains available after transport uncertainty, while `publishedSessionId` is set when `workspace-attach-failed` proves the Host published a real Session before attachment failed. For the New Session flow, the frontend Session object owns its retained prompt and advances it through attachment and send; a partially published Session keeps the same object and prompt while it appears as Ungrouped.

## Session title projection

`SessionManager` retains the latest validated `session/title` control snapshot independently of list and session-instance arrival. Newer event seqs replace older snapshots, title timestamps contribute to list recency, and a subscription baseline discards any retained title beyond its `lastSeq` before the optional folded title arrives. Explicit session removal also clears the retained title. The client-facing `SessionSummary.title` is therefore only the actual durable title; `displayTitle` is always present and falls back through the cwd basename and session id. A cold persisted session keeps that fallback until opening or resuming it causes the host to fold and project its log-backed title.

## Session model selection

Each resident `Session` owns a `modelSelection` snapshot containing the current provider/model target, provider-grouped directory, provider-local failures, and the `idle`/`loading`/`ready`/`selecting`/`error` state. History establishes or refreshes the current target, opening a selector refreshes the directory, and selection failures preserve the last target and usable groups. Directory and selection operations share a monotonically increasing generation so an older response cannot overwrite a newer selection. A reconnect rebuild restores the target reported by the Host without replacing unchanged selection substructure.

## Model Experience

None, as the session object layer selects the provider/model route used by a later Host request but adds no model-visible content.

#### KV Cache effect

Changing the target can change or invalidate provider-side cache reuse; this package does not alter the prompt prefix itself.

## Known Limitations and Deferred Work

- **`loader.unload` is a stub (throws not-implemented)** — the full chain (fiber dispose → registration cascade → style removal) lands with the HMR project.
- **Scope teardown is stage-driven, single-occupant today** — the staged session follows `list.current` exactly (staging is the open signal: the event window opens ⟺ the session is on stage); a removed-while-staged session's scope survives frozen until the stage moves on, not until true observer count reaches zero. Resolution (`cell()`/`binding()`/`scope()`) is pure addressing, render-safe. The staged state can widen to a multi-pane list when concurrent panes land.
- **Value imports of this package from plugin bundles must use the `/client` subpath** — the bare package name is not in the loader externals table and inlines a second module instance, whose private scope-tag Symbol never matches (the empty-state P0 postmortem).
