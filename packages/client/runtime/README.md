# @deepseek-ai/dsh-client-runtime

English | [中文](README.zh.md)

Client cordis boot and React-free object services: SlotsService wraps SlotCore and supplies renderer data sources; SessionsService owns Session objects, list/scope/history state; WorkspacesService depends on SessionsService and owns Workspace objects, list/actions, default-target derivation, and the New Session blank-reuse entry (`connectWorkspace`). The runtime fans the shared Host stream into both managers. Client sessions are always Host-born (Session+Agent+cwd in one `session.create`); the client holds no pre-entity session state — a session's Agent scope (the client mirror of host dsh-scope, keyed by the shared agent/session id) is born when its row enters the list mirror and dies with the prune. Contract: api-contracts v3 §4. `ConversationSnapshot` carries `todos` — the session's current todo projection: taken from the tail history page's full-log value (host-computed, independent of the page window), preserved across an older-page prepend, and overwritten by each live `todo/write` (last write wins). A tail response that omits the field means the log holds no `todo/write`, so the list resets to empty — a plan the log never kept (a write lost to a host crash) disappears on the next open or resync.

## Workspace and Session lists

Workspace and Session lists have independent monotone `pending` → `ready` baseline phases and separate refresh activity/error state. Incremental upsert/removal frames and unary mutation echoes arriving during a list request replay over its response. The first successful baseline establishes Host order; later refreshes update rows and membership without changing the relative order of identities already shown. Removed Workspace ids retain process-local tombstones so late changed frames cannot resurrect them; reconnect still takes `workspace.list` as the baseline. Workspace recency is derived only after both baselines are ready and never changes Workspace list order.

`WorkspacesService.delete(workspaceId)` removes the registration from the client projection after the successful unary response; the matching `host/workspace-removed` frame is idempotent and synchronizes other tabs. Session state and the current Session selection are independent, so accounted Sessions immediately project under Ungrouped after their Workspace disappears.

SlotsService gives the renderer separate bare observables for `useSessions` and `useWorkspaces`; web-react creates the hooks. Workspace business state does not enter `SessionListState` or an entry store.

## New Session and the blank mirror

`WorkspacesService.connectWorkspace(workspaceId)` resolves the session a New Session flow lands in: it reuses the workspace's existing blank session from the list mirror (`blank && cwd == workspace.path`) or calls `session.create({workspaceId})`, returning the session id for the caller to open. `SessionSummary.blank` mirrors the host's derived empty-log bit and only ever lowers on the client: seeded by `session.list` / the `host/session-added` frame, flipped false by the first ACCEPTED local `prompt()` (on the RPC success response — acceptance proves the user message is in the host log; a rejected first prompt keeps the session blank and reusable) and by any `running: true` status frame, re-aligned by every list re-pull. List surfaces hide blank rows; the store carries every row. `SessionsService.create` accepts an optional caller-preallocated SessionId and throws `SessionCreateError` (carrying `requestedSessionId`) on failure.

## Code Mode sub-dispatch index

`ConversationSnapshot.codeDispatches` groups a `run_code` call's sub-dispatches under their parent callId, in start order, using the native call-block shapes: a `tool/code-dispatch-start` event lands the `RunningToolCall` form (rows derive the running ring from the shape) and its `tool/code-dispatch` settlement replaces it in place with the `ToolResultNode` form, `callTime` carrying the paired start's time. A settle whose start fell outside the replay window appends directly with `callTime: null` (duration unknown — never a fabricated zero). Live mux frames and history replay build the identical index; sub-calls never join the surface `nodes` flow; per-parent array and map references are memo-stable across unrelated snapshot swaps.

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
- **Scope teardown is stage-driven, single-occupant today** — the staged session follows `list.current` exactly (staging is the open signal: the event window opens ⟺ the session is on stage); a removed-while-staged session's scope survives frozen until the stage moves on, not until true observer count reaches zero. Resolution (`binding()`/`scope()`) is pure addressing, render-safe; the render layer reads the current bundle through the `currentProvideInfo` observable. The staged state can widen to a multi-pane list when concurrent panes land.
- **Value imports of this package from plugin bundles must use the `/client` subpath** — the bare package name is not in the loader externals table and inlines a second module instance, whose private scope-tag Symbol never matches (the empty-state P0 postmortem).
