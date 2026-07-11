# @deepseek-ai/dsh-subagent-inprocess

Shared run driver for the in-process [spawn](../subagent-spawn/README.md) and [fork](../subagent-fork/README.md) providers. It creates a child agent on the same Cordis application; the providers differ only in the optional session seed.

## `startInProcessRun(ctx, request, options)`

The driver snapshots mutable request data, checks delegation depth, and creates one run-owner fiber under the parent. Parent teardown, provider teardown, manual disposal, and cancellation during creation converge on that owner.

Child creation uses fresh IDs, lineage, an inherited or overridden model, and an unpublished setup callback for persona, tool restriction, and structured output. `run.started` resolves after the child is published. The result path sends one prompt, waits for idle, and derives output only from events after the seed boundary; a seeded parent answer cannot become the child's result.

`dispose()` awaits creation or rollback and then the child handle's quiescent disposal. `cancel()` records pre-publication cancellation and applies it when the child exists. A cancelled attempt with no completed turn reports `aborted`.

`InProcessRunOptions` is `{ seed?: SessionEvent[] }`: absent for spawn and the completed-turn prefix for fork.

## Structured output

`attachStructuredRuntime(childCtx, schema)` installs a child-scoped capture tool, prompt instruction, protection, result observer, guard, and terminal turn policy. The actual schema is registered only for that child.

A validated value is staged by immutable execution identity and committed only after the authoritative `tools/result` succeeds. Code Mode also waits for the enclosing `run_code` result. Once pending or committed, later tool calls are denied; after commit, `agent/turn-stop` prevents another model step. A child that finishes without a committed value reports an error.

## Depth

`depthOf(agent)` reads merge-extensible `AgentOptions.subagentDepth` (default `0`). `startInProcessRun` throws `SubagentDepthError` when the next depth exceeds `maxDepth`.

See [the agent-scope RFC](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md) for ownership and final-policy rationale.
