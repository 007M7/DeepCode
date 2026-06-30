# RFC: Subagent lifecycle enrichment — agentType + lastAssistantMessage (observe-only)

Status: implemented (accepted 2026-06-30)

<!-- XXX: legacy ADR/RFC body format, not yet normalized to a unified RFC template. -->

## Context

The hooks subsystem ([interception seams RFC](2026-06-30-interception-seams.md)) lets a plugin observe and gate the agent at lifecycle points. Claude Code and Codex both expose **SubagentStart / SubagentStop** hooks, and CC's carry a `subagent_type` (which named subagent kind ran) and the subagent's final message. The harness already emits `subagent/start` and `subagent/end` lifecycle events ([the subagent capability-seam](2026-06-21-subagent-capability-seam.md)), but their payloads were minimal (`provider`, `id`, and on end `stopReason`) — not enough for a hooks bridge to report which KIND of subagent ran, or WHAT it produced, without separately reaching for the live run.

This RFC enriches those two payloads. It is deliberately **observe-only**: no control-flow change, no waterfall, no `start()` restructure. A run-affecting subagent-stop decision (continuation, injection that changes the run) is a separate, larger redesign and stays out of scope.

## Decision

Add two pieces of information to the subagent lifecycle surface:

1. **`agentType` — a caller-supplied subagent-kind label**, the harness analogue of CC's `subagent_type`. It is optional on `SubagentStartRequest`, carried VERBATIM onto both `subagent/start` (`SubagentRunInfo`) and `subagent/end` (`SubagentRunEndInfo`). The seam never interprets it. The model-facing `dsh-tool-subagent` tool threads it from a new optional `Config.agentType`, so a deployment that exposes multiple subagent kinds (one tool load per kind) labels each. Absent when the caller does not distinguish kinds (the spread omits the key — `exactOptionalPropertyTypes`-correct).

2. **`lastAssistantMessage` — the child's final output**, added to `SubagentRunEndInfo`. On the settle path it is `SubagentResult.output` (so an observer sees WHAT the subagent produced without holding the run). On the REJECT path (an infrastructure fault where no `SubagentResult` was produced — the seam only knows `stopReason: 'error'`) it is absent.

Both events stay plain **`emit`s**. `subagent/end` fires from a detached `.then` on `run.result` and awaits no listener, so it is genuinely observe-only by construction — a `subagent/start` listener can still reach the live child via `ctx.agents.get(info.id)` and `inject()` into it; a `subagent/end` listener can only observe (the run has settled). Per-listener containment (already in place) keeps one bad subscriber from stranding a live run or surfacing as an unhandled rejection on the detached settle hook.

## Why observe-only, and what is deferred

A control-flow `subagent/end` (an awaited waterfall returning a stop/continue decision, like the other interception seams) would require: reshaping `subagent/end` from emit to waterfall, restructuring `SubagentService.start` to await listeners before settling, and implementing the `resume` capability in the in-process provider so a "continue" can actually re-run the child. That belongs to the background/steering subagent redesign the [capability-seam RFC](2026-06-21-subagent-capability-seam.md) already defers (the same redesign that unifies long-running-tool handling across subagents and bash). This RFC ships the observe-only enrichment a hooks bridge needs today; `FIXME(subagent-continuation)` / `TODO` anchors mark where the control-flow version would land if and when that redesign happens.

## Consequences

A hooks bridge (or a native plugin) can now translate SubagentStart/SubagentStop faithfully: it reports `agentType`, matches its hook config on it, and forwards the child's `lastAssistantMessage` to a SubagentStop handler — all by subscribing to the existing emits, no new control-flow surface. The vocabulary addition is documented in [docs/core-data-structures/subagent.md](../../../core-data-structures/subagent.md) (the `SubagentStartRequest` type-equiv block + the events prose) and the two subagent READMEs; the catalog is regenerated. No production behavior changes — the events fire exactly as before, with two more (optional) fields on their payloads — so no snapshot or e2e change is needed.
