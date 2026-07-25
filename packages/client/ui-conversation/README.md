# @deepseek-ai/dsh-client-ui-conversation

Conversation domain: skeleton (header/tabs/composer/empty state), chat view (grouped step-summary flow, streaming tail isolation, stats line, per-tool row slot with a bash sample registrant), minimal details panel, scope-addressed ConversationService. Contract: api-contracts v3 §7 plus the slot terminal design (store seat / props shares).

The no-session hero renders the frontend Session Intent from the Session list projection, including its frontend Workspace Intent when no real Workspace exists. It declares `conversation.empty.workspace`, where ui-workspace registers the same picker used by the sidebar. WorkspacesService starts the cross-object flow; each Workspace or Session object owns its own materialization. The Session keeps its identity across publication and retains any prompt that still needs connection or delivery; ConversationRoot reads that `pendingPrompt` from `useSession` and edits or retries it through the scoped ConversationService.

The view ring IS a slot: the conversation registration declares the `'conversation.view'` list slot (session scope) in its `children` table, ConversationRoot renders the active entry through its renderSlot share (`only: <active id>`), and view tabs project from the ring ledger's registration options (`id`/`order`/`label`). The chat view is this package's own ring entry; other plugins (ui-trajectory) contribute tabs through plain `ctx.slots.register` — the former package-local view registry (`registerView`/`ViewEntry`/`ConversationViewMap` and the chrome attachment table) is retired, with per-view chrome dissolved into the view components themselves.

Generic tool rows classify the built-in bash, read, search, write, and edit names into dedicated visual variants. The filesystem variants render the edit icon and `Write · <path>` or `Edit · <path>` summary while retaining the shared row-to-details interaction.

Tool rows are slots too — the standalone tool ring (`ToolViewRegistry`/`ctx.toolviews`/outlet) is retired. The chat entry declares the keyed `'conversation.chat.toolview'` hole (session scope; the key space is runtime-open); its render site dispatches per row via `entryKey: toolName` with `GenericToolCard` as the call-site `fallback`. The owner payload is the uniform `ToolRowOwnerProps` (`callId`/`toolName`/`block`/`openDetails`) and `ToolRowProps` pre-composes it with the session standard kit. A registrant is a plain plugin: `ctx.slots.register({ name: 'conversation.chat.toolview', key: '<tool>', inject? }, Row)` with `inject: ['slots', 'conversation']` as the load-order seam (apply mounts ConversationService after the chat registration, so the service being present guarantees the slot is declared); session differentiation happens inside the component (`useSessions` reading `parentId` — the bash sample is the third-party-posture exemplar). Trajectory/waterfall toolview slots share this shape and land with their own render sites (RendersCheck rejects a declaration nobody renders).

Per-session UI state (selection, ordinary composer draft, active view) lives in the declared chat store (`stores.ts` `createChatStore`): apply constructs one handle and passes it to the conversation, chat-view, and details registrations, so the session slots share one instance per session (selection written by the chat view, read by details) and the framework owns instance lifecycle and draft persistence. The frontend Session Intent comes from the Session list projection; after publication, any retained prompt comes from that Session's conversation snapshot. Components are pure — the framework standard kit (`useSession`/`sessionId` when session-scoped, plus global `useSessions`/`useWorkspaces`) and the store faces (`useStore`/`actions`) arrive automatically from the registration declaration; inject factories contribute plain data and callbacks for runtime Session actions, send/stop, tabs, details, and paging.

`src/client/` is organized for the future package split: `contract/` is the sole inter-domain shared face (`slots.ts` slot declarations + composed slot props including the tool-row contract, `views.ts` shared primitives, `tool-call-model.ts`); the `skeleton/`, `chat/`, and `toolviews/` (sample registrants) domain directories import contract files and never each other; `apply.ts` is the only assembly point allowed to import all three domains. The `/client` export surface is the contract only — `apply`/`inject`, the two service classes, and the `contract/` type families; implementation components (skeleton, chat rows) and the store factory stay internal and reach the page exclusively through apply's slot registrations (tests take them via the `./src/*` subpath).

## Model Experience

None, as the conversation UI renders session history and streams in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The stats line has no duration segment** — assistant `usage` carries token accounting only; elapsed-time needs a host data source.
- **Details panel is the minimal form** — selected call args/result raw display; the Input/Output/Metadata switch, Prev/Next stepping, and See-in-trajectory deep link are deferred.
- **Assistant footer extensions (IconActions row, per-message paging) are reserved slots** — drawn in the design, not implemented.
- **The sparkle icon for the others tool row is a hand-drawn approximation** — the design glyph's vector geometry is not exportable locally; promotion into ui-primitives waits on an exact export.
- **Approval cards are display-only placeholders** — question requests answer through the composer chain (ui-question), while web-side approval answering is the P-II approvals project.
