# Agent Note: One selection rule keeps subagent output past an empty terminal message

Status: implemented

English | [中文](2026-08-10-subagent-empty-terminal-message-output.zh.md)

## Problem

The agent loop appends an EMPTY-content `assistant/message` when a `max-tokens` step assembled only tool-call blocks (`BlockAssembler.blocks()` drops truncated tool calls): the message exists solely to host usage. Three consumers each selected "the child's answer" with their own rule and all treated that usage host as the answer. The in-process driver's `readResult` and the continuable Activation's `subagent/end` capture took the LAST `assistant/message` unfiltered, and the SDK backend's observer let any `assistant/message` beat its streamed-text fallback. In a multi-step turn cut off at max-tokens, the final empty message therefore erased the real partial answer: `SubagentResult.output` came back `[]`, and the tool result, telemetry, and `subagent/end.lastAssistantMessage` all saw nothing. The in-process driver additionally had no streamed-text fallback at all, so a cancelled child whose only text lived in `assistant/chunk` events also reported `[]`.

## Decision

`dsh-subagent` owns one canonical selection rule in `src/assistant-output.ts`: the last NON-EMPTY assistant message wins; without one, the accumulated `text-delta` stream is the answer; empty-content messages never contribute. The rule has one implementation, the incremental `AssistantOutputFold` (`push(event)` for session-event transports, `pushText(text)` for chunk-only transports, `collect()` to select), and `finalAssistantOutput(events)` applies it to a complete event suffix (the in-process `readResult` and the Activation capture). The SDK backend folds notification events; the ACP backend, which surfaces no complete assistant messages, folds raw chunk text into the same streamed fallback. The contract is stated once at `SubagentResult.output` and mirrored by the subsystem reference; `subagent/end.lastAssistantMessage` selects by the same rule, and "no output" has one encoding on that edge — the field is absent, never an empty array, on both the one-shot and continuable lifecycle shapes. A `max-tokens` or `aborted` finish still reports its honest stop reason; only output selection changed.

The foreground delegation tool observes the same selection: a non-`completed` result stays an `isError` tool result, but its message appends the child's preserved partial text after the stop-reason headline, so the parent model sees the truncated answer instead of a bare failure.

The fake SDK runtime gained a `FAKE_EMPTY_MESSAGE` mode so the keyless backend test can script a usage-only terminal message, and the authored `subagent-max-tokens-partial` ACP snapshot scenario pins the assembled transcript: a scripted child streams text plus a tool call, is cut off by a tool-only max-tokens step (the empty usage-only message appears in its committed log), and the parent's tool result carries the partial answer.

## Alternatives considered

**Fix each consumer in place without a shared helper.** Rejected: the defect existed precisely because three hand-rolled selections drifted; observers of one run must agree on its answer, so the rule needs one implementation (the drafts that first proved the defect, PR #1140 and PR #1141, patched two of the three call sites separately and left the Activation capture inconsistent).

**Stop the loop from appending the empty message.** Rejected: the message is the usage host and the step's durable record ("model-visible ⟺ logged"); reshaping session events for a consumer-side selection bug would touch every replay and projection consumer.

**Treat empty-content messages as an error.** Rejected: the streamed text is the child's real partial answer, and the stop reason already tells the consumer the turn was cut short.

## Consequences

Multi-step children cut off at max-tokens report their earlier text; cancelled in-process children keep the text streamed before the abort; one-shot and continuable `subagent/end` edges agree with `SubagentResult.output`. A message whose content is non-empty but textless (for example reasoning-only) still wins over streamed text — the rule is about empty content, not text presence. A non-empty message also wins over text streamed AFTER it: a child cancelled while streaming a later step reports its earlier complete message, matching the SDK backend's documented contract, with the stop reason signalling the truncation. Regression tests in all three packages script the empty-terminal-message and cancel paths and fail under the previous selections.
