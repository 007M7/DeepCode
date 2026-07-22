# @deepseek-ai/dsh-client-ui-sidebar

Sidebar plugin: session multi-level tree (cwd grouping + parentId nesting), search, by-workspace grouping, state dots, three creation entries. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

`src/client/contract/slots.ts` is the single-domain contract file: `SidebarRootInjected` (the registrant's own injected share — plain service callbacks: onOpen/onCreate/onToggleSidebar) and `SidebarRootComponentProps = PropsRuntime<'sidebar'> & SidebarRootInjected` (owner `{collapsed,width}` plus the standard `useSessions` hook, resolved off ui-layout's SlotMap declaration, never re-stated). `apply` registers SidebarRoot cast-free against that composition; the inject factory closes over the plugin's own ctx.

There is no plugin store: rows derive in the component (`useMemo` over the `useSessions` snapshot + local expansion/search state) through the pure `deriveRows` in `tree.ts`.

The `/client` export surface is the plugin body (`apply`/`inject`) plus the contract types only — SidebarRoot, the row components, and the tree derivation are internal (the slot registration closes over them; tests import src paths directly).

## Model Experience

None, as the sidebar renders the browser session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **State dots have two live data states (running/none)** — the done/error/amber sources arrive with P-II approvals and notifications; the four-color primitive is already wired.
- **Group-by menu ships by-workspace only** — Update/Status grouping strategies are drawn without specs and deferred.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
