# RFC 005: Runtime validation at the model boundary, error taxonomy, dev-mode invariants

Status: partially implemented — part 1 (arg validation) → [ADR 0011](../adr/0011-runtime-arg-validation.md); part 3 (dev invariants) → [ADR 0012](../adr/0012-dev-invariants-over-deep-readonly.md); part 2 (error taxonomy) in progress

## Problem

Three gaps where compile-time guarantees stop:

1. Tool args are model-generated JSON — `defineTool`'s `InferArgs<S>` claim is only as true as the model's output. Today a malformed call reaches `execute` untyped-in-practice.
2. Tool errors flatten to a text block; name/code/stack are lost, so future sandbox/retry plugins can't distinguish ENOENT from EACCES, and the model gets less actionable feedback than it could.
3. Loop ordering invariants (seq monotonicity, step/turn event nesting, turn-number continuity) are asserted only where tests look.

## Proposal

1. **Schema validation in defineTool**: before `execute`, validate parsed args against the SchemaSpec (the converter already encodes the structure — a small interpreter walks it: presence of required keys, primitive type checks, enum membership, recursion into objects/arrays). On mismatch, return an `isError` ToolExecutionResult describing the violation — the model can self-correct. Raw-registered tools (MCP) keep validating their own input.
2. **Structured error taxonomy**: per-package error classes extending a common `HarnessError` (name, `code`, `cause` chaining). `ToolExecutionResult` gains optional `error: { name, code }` alongside the model-facing text. The loop's `errorData` consumes it; session `error` events carry the code. This also properly fixes the non-Error-throw message degradation found in review.
3. **Dev-mode invariants**: a `dsh-invariants` debug plugin (everything is a plugin — it's just listeners) asserting, when enabled: session seq strictly increases; `step/start` precedes its chunks; `turn/start`/`turn/end` pair and nest; tool/call has a matching tool/result; status transitions are legal. Enabled in tests and the demo; off in production. Doubles as executable documentation of the event contract. _(As implemented, the tool rule is one-directional — a `tool/result` requires a prior `tool/call`, but NOT the converse: a throwing `tools/execute` waterfall ends a step with no result. See [ADR 0012](../adr/0012-dev-invariants-over-deep-readonly.md).)_

## Plan

2 first (taxonomy is a dependency of 1's error shape), then 1, then 3. Property tests (RFC 001) then close the loop: generated args ↔ validator ↔ InferArgs agreement.

## Risks

Validator/InferArgs drift — covered by the RFC 001 composition property. Validation cost per call is negligible next to a model call.
