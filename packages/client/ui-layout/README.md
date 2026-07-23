# @deepseek-ai/dsh-client-ui-layout

Shell plugin: three-column AppFrame (drag handles, concession chain) + ctx.layout viewing-state service (nav, panel widths, persist); defines the sidebar/conversation/details/conversation.empty slots. A closed sidebar retains a 56px control rail while details closes to zero width; collapse/expand animates the grid tracks on the deepsuite sider curve. Contract: api-contracts v3 §5.

Slot declarations use the composed-props entry form (`owner` share, no full `props`): the exported OwnerShare contracts are `SidebarOwnerProps` / `ConvOwnerProps` / `DetailsOwnerProps` / `EmptyOwnerProps` — registrants reference them via `OwnerOf<'sidebar' | ...>` and compose their own injected share locally. No entry declares `children` (declaring it requires the registered component to carry the slots face — reserved for future business slots): delegation authority is the component-side whitelist, i.e. AppFrame's `ScopedSlots<FrameSlotKey>` face over sidebar/conversation/details/conversation.empty. Since the root-slot rework the frame itself registers into 'root' and renders those child slots at its own render sites; the shell only renders 'root'.

The export surface is the cross-package contract only: the AppFrame trio (+ `AppFrameProps`) consumed by the web shell's assembly, `LayoutService` with its store shapes (`NavState`/`PanelState`/`ViewId`), and the OwnerShare contracts. The concession-chain solver (`computeColumns`) and its geometry constants are package-internal; tests import them from `/src`.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Details open/width state is global** — it does not follow the session (arbitrated for P-I); the per-session keyed upgrade slot is reserved.
- **Concession-chain auto-close derives a zero width without touching the persisted open flag** — the panel restores itself when the window widens; consumers must not read `details.open` as the rendered truth.
- **Scroll anchoring during squeeze reflow is not implemented** — deferred with the virtualized-list project.
