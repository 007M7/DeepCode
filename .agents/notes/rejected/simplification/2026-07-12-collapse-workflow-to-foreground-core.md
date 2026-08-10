# Agent Note: Collapse workflows to the exercised foreground core

Status: rejected — Workflow progress is an intentional observation surface; make it useful through a consumer instead of deleting it.

English | [中文](2026-07-12-collapse-workflow-to-foreground-core.zh.md)

## Problem

The workflow capability carries an observe-only lifecycle beside its execution handle. That surface can look removable because the script still completes without a UI listener, but it is the only provider-neutral source of the actual members that started, their exact labels and phases, and their paired outcomes.

The top-level `dsh-tool-workflow` consumer now uses those events to write four minimal `tool-workflow/*` facts into the calling parent Session, and `ui-workflow-run` rebuilds them into a durable Chat node. The consumer deliberately owns the projection because it alone holds the calling Agent, knows whether the tool execution is top-level, and can keep recording failure separate from workflow execution. `WorkflowRun.id` and `meta` therefore correlate live engine events with that exact durable record rather than duplicating presentation state.

Deleting the event vocabulary, member labels or phases, or run identity would remove the current replay and navigation result rather than merely simplify unused scaffolding. The rejected proposal below remains useful as the contraction to avoid; [durable workflow runs in Chat](../../implemented/feature/2026-08-10-durable-workflow-runs-in-chat.md) owns the present consumer and boundaries.

## Proposal

Keep the exercised core: `agent(prompt, { schema, model })`, `parallel`, `pipeline`, `args`, concurrency/agent caps, cancellation, bounded disposal, structured results, worker isolation, and foreground tool collection. Remove all `workflow/*` events and their event-only info/outcome types; remove `phase()`, `log()`, agent `label`/`phase`, phase declarations, `whenToUse`, and their worker messages/host observers; collapse workflow metadata to the name the tool actually uses; remove event-only run ids/meta snapshots and the synthesized agent-end ledger. Shrink `WorkflowRun` to `result`, `cancel()`, and `dispose()`; the tool renders the request-owned name. Remove `WorkflowStartRequest.signal` and the worker host's input-signal listener/disarm state, retaining the caller-owned bridge from its abort signal to `run.cancel()`. Make `WorkflowError` one fatal error class without a boolean mode or `isFatalWorkflowError()` helper.

Amend the implemented dynamic-workflow Agent Note and update the seam/tool/worker READMEs, tool schema, generated catalogs and package graph, worker type-equivalence records, unit tests, and workflow snapshot/header fixtures. Progress UI work, if commissioned, starts from a correlation contract that names the parent agent/session/tool call instead of reviving this protocol unchanged.

## Alternatives considered

**Move durable recording into the workflow engine.** The engine knows run and member lifecycle but does not own the calling parent Session or the top-level-versus-nested tool boundary. Giving it those facts would couple a provider seam to one consumer and make recording failure part of engine execution. The tool-owned projection adds the missing ownership without widening worker messages or the service contract.

## Acceptance criteria

- The workflow public contract contains only execution, cancellation, result, and disposal contracts with a production consumer.
- No workflow event, phase/log protocol message, run-id generator, progress-only metadata, host pairing ledger, or fatal-mode branch remains.
- The run handle has no id/meta echoes, and cancellation has one holder-owned channel after synchronous `start()` returns.
- Parallel/pipeline behavior, caps, cancellation quiescence, worker containment, structured output, and the model-facing workflow scenarios retain coverage.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This is a compile-visible contraction of the workflow DSL, event taxonomy, handle, and start request. Existing workflow calls that supply descriptive metadata, and scripts that use `phase`, `log`, or labels, must shrink; programmatic callers bridge their own abort source to the returned handle; and a future observer must add a better-correlated event contract. The execution semantics that make workflows useful do not change.
