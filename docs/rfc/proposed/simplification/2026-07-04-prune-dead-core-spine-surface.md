# RFC: Prune dead core-spine surface — `SurfaceManager.invalidate()`, the loop-internal exports, `ToolExecutionResult.callId`

Status: proposed

## Problem

Three pieces of public spine surface share one defect class: their only possible role is to be ignored, or their trigger is unreachable.

1. **`SurfaceManager.invalidate()`** (`packages/core/session/src/surface.ts`). Its documented trigger — "the log has been replaced wholesale (e.g. after Session seed)" — is structurally unreachable: seeding happens inside the `Session` constructor, `_surface` is created lazily on first access, and the log reference is never reassigned afterward, so no constructed `SurfaceManager` ever observes a wholesale replacement. Sole caller: its own unit test. A rollback primitive protecting a scenario the implementation cannot produce.
2. **The `runLoop`, `Inbox`, and `InboxMessage` exports** (`packages/core/agent-loop/src/index.ts`). `runLoop` has zero importers anywhere; `Inbox`/`InboxMessage` are imported only by the package's own inbox spec (switchable to the source module). The exports contradict the package's own docs — the inbox module doc says the public surface is `Agent.send()`/`Agent.steer()` — and the [architecture dependency rule](../../../architecture.md): nothing programs against `dsh-agent-loop`; a replacement loop is a different bundle built on `dsh-agent`, not a consumer of this package's internals. `ReactLoopAgent` stays exported (cross-package tests construct it by package name).
3. **`ToolExecutionResult.callId`** (`packages/core/tools/src/index.ts`; the *input* `ToolExecution.callId` stays). Zero readers. The loop deliberately ignores it and documents it as a footgun — the correlation id must be the loop's own `call.id`, because a `tools/execute` waterfall listener returning a mismatched id would otherwise orphan the call↔result pairing — and a regression test exists solely to prove the field is ignored. So every waterfall short-circuiter must fabricate a field whose only power is to be a bug if trusted; the ACP bridge correlates via the session event's `data.callId`, never via the execution result.

## Proposal

Delete the method and its test; delete the three export lines and their `packages/core/agent-loop/README.md` rows, pointing the inbox spec at the source module; drop the result field from the type, the registry's construction sites, and `toolErrorResult`, along with the loop's ignore-comment and the proves-ignored regression test — the hazard they guard disappears with the field.

Sequencing: the in-flight surface-cache work (tool-pairing balance caching) neither uses nor touches `invalidate`, so that removal lands after or alongside it mechanically. The `callId` removal waits for the in-flight interception-seams work that splits `tools/execute` into pre/post phases and currently carries the field verbatim — the argument transfers unchanged (post-execute listeners receive the execution object alongside the result), so the removal targets whichever seam shape is on master when implemented.

## Why not keep them?

A future consumer that swaps a session's log in place would want a reset primitive — it re-adds `invalidate` with itself. A replacement-loop author might want to reuse the inbox or the driver — the architecture already answers that a replacement loop is a different bundle. An isolated result-logging listener might want self-contained correlation on the result — the execution object is in scope at every listener, and a field that exists only to be ignored is worse than absent: it invites exactly the orphaned-pairing bug the loop comment warns about.

## Acceptance criteria

- The three surfaces appear only in this RFC; the agent-loop README lists only the consumed public surface; the inbox spec imports the source module.
- The tools/execute contract tests pass with the shrunk result type; no waterfall test fabricates a `callId` on a result.

## Risks

All three are compile-visible removals with no runtime behavior change on any shipped path. The `callId` change lands on whatever execute-seam shape is current, as noted under sequencing.
