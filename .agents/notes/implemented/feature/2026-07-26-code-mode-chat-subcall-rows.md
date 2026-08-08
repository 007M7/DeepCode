# Agent Note: Code Mode chat rendering — sub-calls as native rows under the parent

Status: implemented

English | [中文](2026-07-26-code-mode-chat-subcall-rows.zh.md)

> Scope: how the web chat view renders a `run_code` turn — the client-side half of the Code Mode UI stack, built on the [host foundation](2026-07-26-code-dispatch-ui-foundation.md) (full-content `tool/code-dispatch`, the required `description` parameter). The [toolview dissolution](../architecture/2026-07-23-toolview-dissolution.md) owns the slot model this rides on.

## Problem

With Code Mode enabled, the chat view showed one opaque `run_code` row: raw program text as the summary, sub-calls invisible everywhere. The settled product requirement is the opposite: each sub-call must render *identically* to a native tool call — same row components, same custom registrations, same details panel — while the transcript stays honest about the fact that the model made ONE call.

## Decision

**Sub-calls are `ToolResultNode`s indexed off the surface flow, rendered through the same keyed slot as native rows, nested always-visible under their parent.**

- **Data layer**: `Session.applyEventSideEffects` folds each in-window `tool/code-dispatch` into `ConversationSnapshot.codeDispatches: ReadonlyMap<parentCallId, readonly CodeSubCall[]>`, where `CodeSubCall` IS `ToolResultNode` (the sub-call id as `callId`, the logged args JSON-stringified into `call.argsRaw`, the full logged `content`/`isError`). Live mux frames and history replay build the identical index (`rebuildDerivedFromWindow` clears and re-derives; copy-on-write per-parent arrays keep snapshot references memo-stable). Sub-calls never join `nodes` — the surface flow remains exactly the model-visible turn structure. The event is narrowed structurally at the wire-consumer boundary (dsh-tools' host types cannot enter the client program — the host/client `Context` merges collide), the same posture as every cross-wire payload.
- **Render layer**: `ChatView` passes each parent and its indexed children through the whole-Tool `'conversation.chat.tool'` seat. ui-tool's `ToolCallTree` renders the parent followed by a `[data-subcalls]` nest, and every atomic call dispatches through the same `'tool.call.toolview'` keyed slot with `entryKey = Tool name` and the same `GenericToolCard` fallback. A keyed registration therefore takes over child and top-level calls without registration changes. Running parents (`runningCalls`) receive their accumulated dispatches through the same owner payload, so child rows stream in during the run.
- **`run_code` presentation**: a new `code` row variant (classifier `run_code → code`, `Code` title, `IconCodeOutline16`) summarizes with the model-authored `description` and expands to the program itself (monospace on the markdown code-block fill) rather than the args JSON envelope.
- **Details panel**: `materialFor` falls through nodes → runningCalls → the dispatch index, so a selected sub-callId resolves to full args and complete output through the identical rendering path as a native settled call.

## Alternatives considered

**Sub-calls flat in the surface flow (fold them into `nodes`).** Rejected: misrepresents the transcript — the model made one call; nesting under the parent preserves the code↔calls association and keeps the fold's model-visible-order invariant untouched.

**Hidden until the parent row expands.** Rejected by product decision: the sub-calls ARE the story of a Code Mode turn; hiding them re-creates the opacity this feature removes. The parent's expand toggle reveals only the program.

**A dedicated sub-call row component.** Rejected: the whole point is identity with native rows; a parallel component would drift. The nest wrapper (indent + left edge) is the only sub-call-specific chrome.

## Consequences

Custom toolview registrations apply to sub-calls for free — and deliberately: there is no per-registration opt-out short of the component reading its own context, which no current consumer needs. Selection highlighting reaches nested rows through the same `selectedCallId` channel (group membership tests both levels). Trajectory/waterfall still render `run_code` as a single row — their sub-call spans are deferred to the PR that adds dispatch timing (start/end events), without which a waterfall span would be a lie. Fixture turn 64 (`?fixture`) plus the `code-mode-round` browser e2e (recorded real round, keyless replay) pin the full surface; the jsdom suites pin the slot dispatch, error states, details resolution, and index reference stability.
