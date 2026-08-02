# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

Web subagent feature owner: contributes the lazily expandable catalog tree to `conversation.session.header.actions`, reason-specific read-only replacements to the conversation composer chain, and the existing `@` reference source to `ctx.slash`.

The header action reads `subagentsByParent` and session summaries through the standard `useSessions` hook. After a non-empty direct catalog arrives, its trigger counts the complete subagent-only descendant lineage, stops at ordinary forks, and shows ongoing activity when any counted descendant is running. The compact tree remains direct-catalog authoritative: continuable and one-shot rows display mode plus `running`/`inactive` activity, an optional log-backed title, and session-summary activity time; an unlabeled one-shot row falls back to its session id, while corrupt, unsupported, or unavailable rows remain readable but disabled. Each healthy row's `hasChildren` hint determines disclosure before interaction, so known leaves never show an arrow; expanding a branch immediately reserves one disabled loading row per known direct descendant, then lazily replaces them with that child's authoritative catalog. Every visible branch is reported to the runtime so membership frames cause a debounced refresh only where the tree is being consumed. Selecting any depth calls `SessionsService.openSubagent()` with the row's exact `{parentSessionId, childSessionId, mode}` address. Component-local state owns tree visibility, expanded branches, and keyboard focus. ArrowRight/ArrowLeft expand and collapse branches; ArrowUp/ArrowDown, Home, End, and Escape navigate or close the tree; closing returns focus to the trigger. Styling uses tokens only.

A one-shot child always elects a read-only composer that identifies the transcript as a completed execution record. A continuable child does so only when its exact parent is unavailable, with copy explaining the recovery path. A continuable child with a live parent keeps the ordinary input chrome, whose Session routes through `subagent.prompt`; running input remains Send because every follow-up joins the child's FIFO inbox, and addressed sessions never expose Stop. This package never receives host context or calls a model-facing tool. The catalog and composer behavior are specified by the [Web subagent conversations Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md).

Subagent-origin Session rows are omitted from the ordinary sidebar, so the parent header catalog is their navigation entry point. Ordinary forks remain in the sidebar.

The `@` source remains deliberately separate and inert. Candidates are zero-RPC running children from `ctx.sessions.list`; picking one inserts literal `@label ` text, and the codec projects `@label`. It has no command-adjudication hooks and does not resolve labels into continuation addresses.

## Model Experience

### Subagent label text in the user prompt

#### What the model sees

Only the legacy `@` reference source affects model input: a picked candidate reaches the ordinary user message as literal `@label`, without a dedicated block or host-side resolution. Catalog browsing, child navigation, and persisted transcript viewing add no prompt section; accepted continuation content becomes a normal FIFO user message through the host subagent adapter.

#### Token effect

Conditional and append-only: the literal `@label` or a human follow-up adds tokens only to its new user message. Catalog and transcript operations add zero model tokens.

#### KV Cache effect

Append-only. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

- **The catalog has coarse activity only** — it cannot show durable outcome, elapsed time, Activation identity, or an authority-safe cancel button.
- **`@` references remain display-title text** — duplicate or renamed labels are ambiguous, so they intentionally do not acquire continuation semantics.
