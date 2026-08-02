# Agent Note: Reject ask_user_question from delegated subagents

Status: implemented

English | [中文](2026-08-01-ask-user-delegated-caller-guard.zh.md)

## Problem

A delegated subagent that calls the `ask_user_question` tool blocks indefinitely. The tool pauses for a human answer, but a child context has no human answerer, so no answer ever arrives and the subagent run hangs until it is cancelled externally.

## Decision

`UserInteractionService.ask()` rejects any request whose calling agent is a delegated subagent — `request.agent.session.header.delegationDepth > 0` — with a new `UserInteractionError` code `DELEGATED_CALLER` and the message `ask_user_question is unavailable to delegated subagents; delegate the question to the top-level agent`. The check runs at the top of `ask()`, after the aborted/empty guards and before intent validation, so no provider interaction happens for a rejected child. This mirrors the goal tools' top-level-only authority (`create_goal` rejects non-top-level agents with a direct-human-turn requirement).

## Alternatives considered

**Leave the child blocked until the parent forwards an answer.** Rejected: no answerer exists in the child context and no forwarding seam exists; the observed behavior is a permanent hang.

**Reject inside the tool (`dsh-tool-ask-user`) instead of the service.** Rejected: that consumer seam is bypassed by direct callers of `ctx.userInteraction.ask()`; the operation boundary that owns the decision is the service itself.

**Warn children off via the model-facing description.** Rejected: the rejection is already a loud, self-explanatory error, and a description edit would not stop the hang for a model that calls anyway.

## Consequences

Delegated subagent calls fail fast with a stable error instead of hanging; a child that needs a decision must delegate the question to the top-level agent. Programmatic askers without an agent and top-level agents (`delegationDepth` absent or 0) are unaffected and still reach the provider. The `DELEGATED_CALLER` code joins the documented `UserInteractionError` taxonomy in the package READMEs, and the model-facing description is unchanged.

## Testing

Two new unit tests exercise the guard: `user-interaction.spec.ts` asserts that `ask()` rejects with `DELEGATED_CALLER` and never calls the provider for a session created with `{ meta: { delegationDepth: 1 } }`, plus a positive control at `delegationDepth: 0`; `tool-ask-user.spec.ts` asserts that a tool call from a delegated agent surfaces the structured error and never reaches the provider. Both packages pass, as does the parent `packages/ui` scope, and the two touched `src` files hold 100% per-file coverage.
