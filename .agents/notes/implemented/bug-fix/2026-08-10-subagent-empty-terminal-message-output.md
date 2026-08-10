# Agent Note: One selection rule keeps subagent output past an empty terminal message

Status: implemented

English | [中文](2026-08-10-subagent-empty-terminal-message-output.zh.md)

## Problem

The agent loop appends an EMPTY-content `assistant/message` when a `max-tokens` step assembled only tool-call blocks (`BlockAssembler.blocks()` drops truncated tool calls): the message exists solely to host usage. Three consumers each selected "the child's answer" with their own rule and all treated that usage host as the answer. The in-process driver's `readResult` and the continuable Activation's `subagent/end` capture took the LAST `assistant/message` unfiltered, and the SDK backend's observer let any `assistant/message` beat its streamed-text fallback. In a multi-step turn cut off at max-tokens, the final empty message therefore erased the real partial answer: `SubagentResult.output` came back `[]`, and the tool result, telemetry, and `subagent/end.lastAssistantMessage` all saw nothing. The in-process driver additionally had no streamed-text fallback at all, so a cancelled child whose only text lived in `assistant/chunk` events also reported `[]`.

## Decision

`dsh-subagent` owns one canonical selection rule in `src/assistant-output.ts`: the last NON-EMPTY assistant message wins; without one, the accumulated `text-delta` stream is the answer; empty-content messages never contribute. `finalAssistantOutput(events)` applies the rule to an event suffix (the in-process `readResult` and the Activation capture), and `assistantMessageOutput(event)` is the same per-event predicate for the SDK backend's incremental fold. The contract is stated once at `SubagentResult.output` and mirrored by the subsystem reference; `subagent/end.lastAssistantMessage` declares it selects by the same rule. A `max-tokens` or `aborted` finish still reports its honest stop reason; only output selection changed.

The ACP backend accumulates chunks only and was never affected. The fake SDK runtime gained a `FAKE_EMPTY_MESSAGE` mode so the keyless backend test can script a usage-only terminal message.

## Alternatives considered

**Fix each consumer in place without a shared helper.** Rejected: the defect existed precisely because three hand-rolled selections drifted; observers of one run must agree on its answer, so the rule needs one implementation (the drafts that first proved the defect, PR #1140 and PR #1141, patched two of the three call sites separately and left the Activation capture inconsistent).

**Stop the loop from appending the empty message.** Rejected: the message is the usage host and the step's durable record ("model-visible ⟺ logged"); reshaping session events for a consumer-side selection bug would touch every replay and projection consumer.

**Treat empty-content messages as an error.** Rejected: the streamed text is the child's real partial answer, and the stop reason already tells the consumer the turn was cut short.

## Consequences

Multi-step children cut off at max-tokens report their earlier text; cancelled in-process children keep the text streamed before the abort; one-shot and continuable `subagent/end` edges agree with `SubagentResult.output`. A message whose content is non-empty but textless (for example reasoning-only) still wins over streamed text — the rule is about empty content, not text presence. Regression tests in all three packages script the empty-terminal-message and cancel paths and fail under the previous selections.
