# RFC: Prune dead core-spine surface — `SurfaceManager.invalidate()`, the loop-internal exports, `ToolExecutionResult.callId`

Status: proposed

## Problem

Three pieces of public spine surface share one defect class: their only possible role is to be ignored, or their trigger is unreachable.

1. **`SurfaceManager.invalidate()`** (`packages/core/session/src/surface.ts`). Its documented trigger — "the log has been replaced wholesale (e.g. after Session seed)" — is structurally unreachable: seeding happens inside the `Session` constructor, `_surface` is created lazily on first access, and the log reference is never reassigned afterward, so no constructed `SurfaceManager` ever observes a wholesale replacement. Sole caller: its own unit test. A rollback primitive protecting a scenario the implementation cannot produce.
2. **The `runLoop`, `Inbox`, and `InboxMessage` exports** (`packages/core/agent-loop/src/index.ts`). `runLoop` has no importer outside the package — the only callers are the package's own internals (the agent constructs its loop with it), so the public re-export has zero consumers; `Inbox`/`InboxMessage` likewise reach outside code only through the package's own inbox spec (switchable to the source module). The exports contradict the package's own docs — the inbox module doc says the public surface is `Agent.send()`/`Agent.steer()` — and the [architecture dependency rule](../../../architecture.md): nothing programs against `dsh-agent-loop`; a replacement loop is a different bundle built on `dsh-agent`, not a consumer of this package's internals. `ReactLoopAgent` stays exported (cross-package tests construct it by package name).
3. **`ToolExecutionResult.callId`** (`packages/core/tools/src/index.ts`; the input `ToolExecution.callId` stays). Zero consumers read it. A `tools/execute` wrapper may construct or replace a result, but the registry rejects any `callId` that differs from the immutable execution identity and rebuilds later outcomes from protected snapshots; `tools/post-execute` receives that same execution beside the result, and the observe-only `tools/result` notification receives both as immutable values. The loop independently correlates with its model call's `call.id`, while ACP correlates through the session event's `data.callId`. The result field is therefore a compulsory copy of information already present at every extension point, plus validation and regression tests whose only job is to prove the copy cannot disagree.

## Proposal

Delete the method and its test; delete the three export lines and their `packages/core/agent-loop/README.md` rows, pointing the inbox spec at the source module; drop the result field from the type, the registry's construction sites (deny, dispatch, `toolErrorResult`, post-execute snapshots), its around-wrapper mismatch validation, the loop's ignore-comment, and the tests that prove the duplicate id cannot matter. The result's consumed `additionalContext` ferry and the execution object's authoritative `callId` stay untouched. Update the `ToolExecutionResult` paste in [tools.md](../../../core-data-structures/tools.md) (and its `scripts/type-equiv.manifest.json` row) and the result-shape row in `packages/core/tools/README.md`; for the `invalidate()` removal, amend the [session-surface RFC](../../implemented/architecture/2026-06-18-session-surface.md)'s full-rebuild-after-wholesale-replacement sentence per [implemented/AGENTS.md](../../implemented/AGENTS.md).

Sequencing: the surface-cache work (tool-pairing balance caching) neither uses nor touches `invalidate`, so that removal can land after or alongside it mechanically. The full execution pipeline carries the immutable execution object through pre-policy, guards, around-dispatch wrappers, post-policy, and final result observation; nothing needs the result to repeat its id.

## Alternatives considered

### Why not keep them?

A future consumer that swaps a session's log in place would want a reset primitive — it re-adds `invalidate` with itself. A replacement-loop author might want to reuse the inbox or the driver — the architecture already answers that a replacement loop is a different bundle. An isolated result-logging listener might want self-contained correlation on the result — the execution object is in scope at every listener, and a field that exists only to be ignored is worse than absent: it invites exactly the orphaned-pairing bug the loop comment warns about.

## Acceptance criteria

- `invalidate()` and the result `callId` appear only in this RFC; `runLoop`/`Inbox`/`InboxMessage` remain package-internal only — no re-export from the package index and no outside-package importer; the agent-loop README lists only the consumed public surface; the inbox spec imports the source module.
- The complete tool-pipeline contract tests pass with the shrunk result type; the around-wrapper mismatch test, mutation-guard id assertions, and proves-ignored loop test disappear with the duplicate field.

## Risks

All three are compile-visible removals with no runtime behavior change on any shipped path.
