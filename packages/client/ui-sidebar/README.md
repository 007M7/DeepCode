# @deepseek-ai/dsh-client-ui-sidebar

Sidebar plugin: session multi-level tree (cwd grouping + parentId nesting), search, by-workspace grouping, state dots, three creation entries. Contract: api-contracts v3 §6.

`src/client/contract/slots.ts` is the single-domain contract file: `SidebarRootInjected` (the registrant's own injected share — tree hook, current-session hook, actions) and `SidebarRootComponentProps = OwnerOf<'sidebar'> & SidebarRootInjected` (the owner share referenced from ui-layout's slot declaration, never re-stated). `apply` registers SidebarRoot cast-free against that composition; the inject factory binds layout/sessions off `RootBinding<ClientContext>`.

## Model Experience

None, as the sidebar renders the browser session list; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **State dots have two live data states (running/none)** — the done/error/amber sources arrive with P-II approvals and notifications; the four-color primitive is already wired.
- **Group-by menu ships by-workspace only** — Update/Status grouping strategies are drawn without specs and deferred.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.
