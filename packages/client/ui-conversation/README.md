# @deepseek-ai/dsh-client-ui-conversation

Conversation domain: skeleton (header/tabs/composer/empty state), chat view (grouped step-summary flow, streaming tail isolation), ctx.toolviews named registry with bash samples, minimal details panel, scope-addressed ConversationService. Contract: api-contracts v3 §7.

`src/client/` is organized for the future package split: `contract/` is the sole inter-domain shared face (`slots.ts` composed slot props, `views.ts` view ring, `toolview.ts` tool ring, `tool-call-model.ts`); the `skeleton/`, `chat/`, and `toolviews/` domain directories import contract files and never each other; `apply.ts` is the only assembly point allowed to import all three domains.

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
