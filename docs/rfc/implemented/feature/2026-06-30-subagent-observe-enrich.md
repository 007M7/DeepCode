# RFC: Subagent lifecycle enrichment — lastAssistantMessage (observe-only)

Status: implemented

## Problem

The hooks subsystem ([interception seams RFC](2026-06-30-interception-seams.md)) lets a plugin observe and gate the agent at lifecycle points. Claude Code and Codex both expose **SubagentStart / SubagentStop** hooks, and CC's carry the subagent's final message. The harness already emits `subagent/start` and `subagent/end` lifecycle events ([the subagent capability-seam](2026-06-21-subagent-capability-seam.md)), but their payloads were minimal (`provider`, `id`, and on end `stopReason`) — not enough for a hooks bridge to report WHAT a subagent produced without separately reaching for the live run.

This RFC enriches the end payload. It is deliberately **observe-only**: no control-flow change, no waterfall, no `start()` restructure. A run-affecting subagent-stop decision (continuation, injection that changes the run) is a separate, larger redesign and stays out of scope.

## Decision

**Add `lastAssistantMessage` — the child's final output — to `SubagentRunEndInfo`.** On the settle path it is a DEEP CLONE of `SubagentResult.output` (so an observer sees WHAT the subagent produced without holding the run). On the REJECT path (an infrastructure fault where no `SubagentResult` was produced — the seam only knows `stopReason: 'error'`) it is absent. The clone is load-bearing for observe-only: the `subagent/end` emit fires from a detached `.then` registered *before* `start()` returns, i.e. before the caller's own `await run.result` continuation — handing listeners the same array reference would let a mutating listener corrupt the caller's `SubagentResult.output`. `structuredClone` makes the event a read-only view (a regression test mutates the event's array and asserts the caller's result is untouched); a clone failure is contained (logged, the event still fires without `lastAssistantMessage`) rather than becoming an unhandled rejection on the detached `.then`.

Both events stay plain **`emit`s**. `subagent/end` fires from a detached `.then` on `run.result` and awaits no listener, so it is genuinely observe-only by construction — a `subagent/start` listener can still reach the live child via `ctx.agents.get(info.id)` and `inject()` into it; a `subagent/end` listener can only observe (the run has settled). Per-listener containment (already in place) keeps one bad subscriber from stranding a live run or surfacing as an unhandled rejection on the detached settle hook.

## Alternatives considered

**An `agentType` subagent-kind label** (the harness analogue of CC's `subagent_type`) on the request + both lifecycle payloads — an earlier draft shipped it; dropped in review because it is a Claude-Code concept that does not fit our own seam (nothing here interprets it, and the only consumer was a CC-dialect bridge). The CC bridge instead feeds Claude Code's own default matcher value `"general-purpose"` for its SubagentStart/Stop `agent_type` matcher, so this RFC ships ONE enrichment: `lastAssistantMessage`.

**A control-flow `subagent/end`** — deferred; see below.

## Why observe-only, and what is deferred

A control-flow `subagent/end` (an awaited waterfall returning a stop/continue decision, like the other interception seams) would require: reshaping `subagent/end` from emit to waterfall, restructuring `SubagentService.start` to await listeners before settling, and implementing the `resume` capability in the in-process provider so a "continue" can actually re-run the child. That belongs to the background/steering subagent redesign the [capability-seam RFC](2026-06-21-subagent-capability-seam.md) already defers (the same redesign that unifies long-running-tool handling across subagents and bash). This RFC ships the observe-only enrichment a hooks bridge needs today; `FIXME(subagent-continuation)` / `TODO` anchors mark where the control-flow version would land if and when that redesign happens.

## Consequences

A hooks bridge (or a native plugin) can now forward the child's `lastAssistantMessage` to a SubagentStop handler by subscribing to the existing emits — no new control-flow surface. The vocabulary addition is documented in [docs/core-data-structures/subagent.md](../../../core-data-structures/subagent.md) (the events prose) and the two subagent READMEs; the catalog is regenerated. No production behavior changes — the events fire exactly as before, with one more (optional) field on the end payload — so no snapshot or e2e change is needed.
