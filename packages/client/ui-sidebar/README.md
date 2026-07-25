# @deepseek-ai/dsh-client-ui-sidebar

Sidebar plugin: real Host Workspaces in stable Host order, each containing its `sessionIds` in Workspace order with `parentId` nesting; Sessions outside every Workspace appear in a trailing `Ungrouped` section. Search, state dots, and collapse into the layout-owned 56px rail are presentation-local. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

New Session starts the runtime's page-local frontend Session Intent; a real Workspace's "+" starts one targeted to that Workspace. The Workspace header "+" opens ui-workspace's shared picker, whose selection also targets a frontend Session. A Workspace Intent does not appear in the sidebar.

`SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared `sidebar.workspace` child slot, and injected `startSession`, `open`, and sidebar-toggle callbacks. There is no plugin store: `deriveGroups` consumes object-layer snapshots and component-local expansion/search state.

The `/client` export surface is the plugin body (`apply`/`inject`) plus the contract types only — SidebarRoot, the row components, and the tree derivation are internal (the slot registration closes over them; tests import src paths directly).

## Model Experience

None, as the sidebar renders the browser session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **State dots have two live data states (running/none)** — the done/error/amber sources arrive with P-II approvals and notifications; the four-color primitive is already wired.
- **Group-by menu ships by-workspace only** — Update/Status grouping strategies are drawn without specs and deferred.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
