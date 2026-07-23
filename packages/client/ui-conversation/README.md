# @deepseek-ai/dsh-client-ui-conversation

Conversation domain: skeleton (header/tabs/composer/empty state), chat view (grouped step-summary flow, streaming tail isolation), ctx.toolviews named registry with bash samples, minimal details panel, scope-addressed ConversationService. Contract: api-contracts v3 §7 plus the slot terminal design (store seat / props shares).

Per-session UI state (selection, composer draft, active view) lives in the declared chat store (`stores.ts` `createChatStore`): apply constructs one handle and passes it to both the conversation and details registrations, so the two session slots share one instance per session (selection written by conversation, read by details) and the framework owns instance lifecycle and draft persistence. Components are pure — the framework standard kit (`useSession`/`sessionId`/`useSessions`) and the store faces (`useStore`/`actions`) arrive automatically from the registration declaration; the inject factories contribute plain data and callbacks only (send/stop choreography, view registry read face, startSession chain).

`src/client/` is organized for the future package split: `contract/` is the sole inter-domain shared face (`slots.ts` composed slot props, `views.ts` view ring, `toolview.ts` tool ring, `tool-call-model.ts`); the `skeleton/`, `chat/`, and `toolviews/` domain directories import contract files and never each other; `apply.ts` is the only assembly point allowed to import all three domains. The `/client` export surface is the contract only — `apply`/`inject`, the two service classes, and the `contract/` type families; implementation components (skeleton, chat rows) and the store factory stay internal and reach the page exclusively through apply's slot registrations (tests take them via the `./src/*` subpath).

## Model Experience

None, as the conversation UI renders session history and streams in the browser; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The stats line has no duration segment** — assistant `usage` carries token accounting only; elapsed-time needs a host data source.
- **Details panel is the minimal form** — selected call args/result raw display; the Input/Output/Metadata switch, Prev/Next stepping, and See-in-trajectory deep link are deferred.
- **Assistant footer extensions (IconActions row, per-message paging) are reserved slots** — drawn in the design, not implemented.
- **The sparkle icon for the others tool row is a hand-drawn approximation** — the design glyph's vector geometry is not exportable locally; promotion into ui-primitives waits on an exact export.
- **Approval/question cards are display-only placeholders** — web-side answering (composer takeover panel) is the P-II approvals project.
- **Module-level toolview caches are single-bundle state** — the inject cache and registry maps must reach cross-bundle consumers through the package export surface and loader module table, never by a second bundle copy.
