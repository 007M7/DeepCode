# @deepseek-ai/dsh-client-ui-layout

Shell plugin: three-column AppFrame (drag handles, concession chain) + ctx.layout viewing-state service (nav, panel widths, persist); defines the sidebar/conversation/details/conversation.empty slots. Contract: api-contracts v3 §5.

Slot declarations use the composed-props entry form (`owner` share, no full `props`): the exported OwnerShare contracts are `SidebarOwnerProps` / `ConvOwnerProps` / `DetailsOwnerProps` / `EmptyOwnerProps` — registrants reference them via `OwnerOf<'sidebar' | ...>` and compose their own injected share locally. The `conversation` entry authorizes `conversation.empty` delegation through `children`.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Details open/width state is global** — it does not follow the session (arbitrated for P-I); the per-session keyed upgrade slot is reserved.
- **Concession-chain auto-close derives a zero width without touching the persisted open flag** — the panel restores itself when the window widens; consumers must not read `details.open` as the rendered truth.
- **Scroll anchoring during squeeze reflow is not implemented** — deferred with the virtualized-list project.
