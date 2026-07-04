# RFC: Prune dead core-spine surface — `SurfaceManager.invalidate()`, the loop-internal exports, `ToolExecutionResult.callId`

Status: proposed

## Problem

Three pieces of public spine surface share one defect class: their only possible role is to be ignored, or their trigger is unreachable.

1. **`SurfaceManager.invalidate()`** (`packages/core/session/src/surface.ts`). Its documented trigger — "the log has been replaced wholesale (e.g. after Session seed)" — is structurally unreachable: seeding happens inside the `Session` constructor, `_surface` is created lazily on first access, and the log reference is never reassigned afterward, so no constructed `SurfaceManager` ever observes a wholesale replacement. Sole caller: its own unit test. A rollback primitive protecting a scenario the implementation cannot produce.
2. **The `runLoop`, `Inbox`, and `InboxMessage` exports** (`packages/core/agent-loop/src/index.ts`). `runLoop` has no importer outside the package — the only callers are the package's own internals (the agent constructs its loop with it), so the public re-export has zero consumers; `Inbox`/`InboxMessage` likewise reach outside code only through the package's own inbox spec (switchable to the source module). The exports contradict the package's own docs — the inbox module doc says the public surface is `Agent.send()`/`Agent.steer()` — and the [architecture dependency rule](../../../architecture.md): nothing programs against `dsh-agent-loop`; a replacement loop is a different bundle built on `dsh-agent`, not a consumer of this package's internals. `ReactLoopAgent` stays exported (cross-package tests construct it by package name).
3. **`ToolExecutionResult.callId`** (`packages/core/tools/src/index.ts`; the *input* `ToolExecution.callId` stays). Zero readers — and no listener can even construct a result: `tools/pre-execute`/`tools/post-execute` listeners return Decisions, the registry builds every result itself and always sets `callId` to the input `exec.callId`, and the post-execute dispatch snapshots the outcome before the waterfall precisely so a listener mutating the shared result reference cannot corrupt the id. The loop independently ignores `result.callId` in favor of its own `call.id`, and two regression tests exist solely to prove the field cannot matter (the loop's ignores-result-callId test and the registry's mutation guard). A field that is by construction a copy of its input, defended by snapshot machinery, and pinned by tests proving it is ignored is pure liability surface; the ACP bridge correlates via the session event's `data.callId`, never via the execution result.

## Proposal

Delete the method and its test; delete the three export lines and their `packages/core/agent-loop/README.md` rows, pointing the inbox spec at the source module; drop the result field from the type, the registry's construction sites (the deny result, the dispatch result, `toolErrorResult`, and the post-execute snapshot's `callId` leg), the loop's ignore-comment, the proves-ignored regression test, and the mutation guard's `callId` assertions — the hazard they all pin disappears with the field, while the result's `additionalContext` ferry (a consumed post-execute channel) stays untouched. Update the `ToolExecutionResult` paste in [tools.md](../../../core-data-structures/tools.md) (and its `scripts/type-equiv.manifest.json` row) and the result-shape row in `packages/core/tools/README.md`; for the `invalidate()` removal, amend the [session-surface RFC](../../implemented/architecture/2026-06-18-session-surface.md)'s full-rebuild-after-wholesale-replacement sentence per [implemented/AGENTS.md](../../implemented/AGENTS.md).

Sequencing: the in-flight surface-cache work (tool-pairing balance caching) neither uses nor touches `invalidate`, so that removal lands after or alongside it mechanically. The execute pipeline is `tools/pre-execute` → dispatch → `tools/post-execute`, and post-execute listeners receive the execution object alongside the result — nothing needs the result's own id.

## Why not keep them?

A future consumer that swaps a session's log in place would want a reset primitive — it re-adds `invalidate` with itself. A replacement-loop author might want to reuse the inbox or the driver — the architecture already answers that a replacement loop is a different bundle. An isolated result-logging listener might want self-contained correlation on the result — the execution object is in scope at every listener, and a field that exists only to be ignored is worse than absent: it invites exactly the orphaned-pairing bug the loop comment warns about.

## Acceptance criteria

- `invalidate()` and the result `callId` appear only in this RFC; `runLoop`/`Inbox`/`InboxMessage` remain package-internal only — no re-export from the package index and no outside-package importer; the agent-loop README lists only the consumed public surface; the inbox spec imports the source module.
- The pre-/post-execute pipeline contract tests pass with the shrunk result type; the mutation-guard and proves-ignored tests shed their `callId` legs with the hazard they pin.

## Risks

All three are compile-visible removals with no runtime behavior change on any shipped path.
