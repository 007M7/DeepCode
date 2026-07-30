# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

Web subagent feature owner: contributes the lazily expandable catalog tree to `conversation.session.header.actions`, the unavailable-parent replacement to the conversation composer chain, and the existing `@` reference source to `ctx.slash`.

The header action reads `subagentsByParent` and session summaries through the standard `useSessions` hook. After a non-empty catalog arrives it shows the healthy direct-child count and a compact tree in service order. Each healthy row combines its durable label, `running`/`inactive` activity (rendered as `正在处理`/`已完成`), optional log-backed title, and session-summary activity time; corrupt, unsupported, or unavailable rows remain readable but disabled. Expanding a row lazily opens that child's direct catalog and reports every visible branch to the runtime so membership frames cause a debounced refresh only where the tree is being consumed. Selecting any depth calls `SessionsService.openSubagent()` with the row's exact `{parentSessionId, childSessionId}` address. Component-local state owns tree visibility, expanded branches, and keyboard focus. ArrowRight/ArrowLeft expand and collapse branches; ArrowUp/ArrowDown, Home, End, and Escape navigate or close the tree; closing returns focus to the trigger. Styling uses tokens only.

An addressed child with no exact live parent elects the read-only composer entry and explains the recovery path. A child with a live parent keeps the ordinary input chrome, whose Session routes through `subagent.prompt`; this package never receives host context or calls a model-facing tool. The catalog and composer behavior are specified by the [Web subagent conversations Agent Note](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md).

Subagent-origin Session rows are omitted from the ordinary sidebar, so the parent header catalog is their navigation entry point. Ordinary forks remain in the sidebar.

The `@` source remains deliberately separate and inert. Candidates are zero-RPC running children from `ctx.sessions.list`; picking one inserts literal `@label ` text, and the codec projects `@label`. It has no command-adjudication hooks and does not resolve labels into continuation addresses.

## Model Experience

### Subagent label text in the user prompt

#### What the model sees

Only the legacy `@` reference source affects model input: a picked candidate reaches the ordinary user message as literal `@label`, without a dedicated block or host-side resolution. Catalog browsing, child navigation, persisted transcript viewing, and human continuation UI add no prompt section; continuation content becomes a normal user-role event through the host subagent adapter.

#### Token effect

Conditional and append-only: the literal `@label` or a human follow-up adds tokens only to its new user message. Catalog and transcript operations add zero model tokens.

#### KV Cache effect

Append-only. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

- **The catalog has coarse liveness only** — it cannot show durable outcome, elapsed time, exact Activation state, or a correct cancel button.
- **`@` references remain display-title text** — duplicate or renamed labels are ambiguous, so they intentionally do not acquire continuation semantics.
