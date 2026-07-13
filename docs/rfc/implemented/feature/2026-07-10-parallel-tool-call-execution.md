# RFC: Parallel tool-call execution by per-call safety

Status: implemented

## Problem

The loop accepts an assistant message containing multiple `tool-call` blocks. Serial execution makes independent reads, web requests, and subagent delegations pay the sum of their wall-clock latency even though the model and adapters already represent sibling tool calls in one response.

Concurrency cannot live in the model-facing JSON schema. `ctx.tools.schemas()` exposes only `name`, `description`, and `parameters`; scheduling is a host contract. The loop needs an internal per-call safety decision and must use it without hardcoding tool names.

The hard constraint is replay. The session log remains the source of truth: the assistant message contains the model's calls in order, each started call has a `tool/call` audit event before its body runs, each model-facing result is a `tool/result`, and derived history sees results in the original call order. Live ACP and stdio surfaces may show several pending calls before the first result; that progress interleaving is not part of the model-history guarantee.

## Decision

`ToolDefinition` carries an optional host-only classifier:

```text
export interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ToolExecuteReturn>
  isConcurrencySafe?(args: unknown): boolean
}
```

`isConcurrencySafe` is synchronous, pure classification metadata. It may inspect parsed call arguments; `defineTool()` schema-validates those arguments before the typed callback runs, while hand-rolled definitions receive the raw parsed value. The callback performs no I/O and receives no live `Agent` or mutable `ToolExecution`. `defineTool()` validates arguments softly for `isConcurrencySafe`, matching the display-only `presentCall`/`presentResult` pattern: invalid args return `false`, and the ordinary `ToolArgsError` is produced only if the tool executes.

The registry exposes the scheduling decision as a plain method:

```text
export type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }
```

```text
class ToolRegistry {
  executionMode(exec: ToolExecutionInput): ToolExecutionMode
}
```

`ctx.tools.executionMode(exec)` looks up the registered tool and calls `tool.isConcurrencySafe?.(exec.arguments)`. Unknown tools, missing declarations, malformed typed args, and thrown safety checks all resolve to `{ kind: 'exclusive' }`. The method is not a Cordis waterfall; it is the future insertion point if hook, MCP, or provider policy needs to downgrade a tool's baseline decision. The object-tagged union leaves room for future resource grouping, for example `{ kind: 'exclusive', group: 'session:...' }`.

A parallel-safe declaration is a contract. The tool body must not mutate the parent agent's session or other parent-owned async state during `execute`; parent-session writes such as `exec.agent.session.append(...)`, `agent.inject(...)`, or other tool-owned parent events belong to exclusive tools unless the mutation moves behind the loop's ordered result path. The only parent-step outputs a parallel-safe call may produce are its returned content, `meta`, structured error, and `additionalContext` carried through the ordered post-execute path. The narrow exception is a synchronous, side-effect-only recorder whose updates are commutative or fail closed for concurrent calls by the same session. `fs/observed` is the worked example: `read` emits it synchronously after a successful read, `dsh-fs-policy` records `WeakMap<session, target, version>` state synchronously, and write/edit remain exclusive barriers that re-check versions before mutating; a stale observation can only make the provider CAS reject with `FS_STALE_VERSION`.

## Scheduling

The loop waits for the model stream to finish and logs one authoritative `assistant/message` before scheduling tools. Streaming tool execution is out of scope.

For each assistant step, `packages/core/agent-loop/src/tool-calls.ts` parses each call's raw JSON arguments exactly once, creates one distinct `ToolExecution` object per call, asks `ctx.tools.executionMode(exec)`, and partitions calls into ordered groups. A group is either one exclusive call or a run of consecutive parallel calls. `loop.ts` calls the helper so the turn/step lifecycle remains readable.

Parallelism is per agent. `AgentOptions.maxParallelToolCalls` is a positive integer, defaults to `DEFAULT_MAX_PARALLEL_TOOL_CALLS` (`10`), and is accepted through the config-created agent path. Setting it to `1` preserves serial execution for that agent. Both the TypeScript `AgentOptions` vocabulary and the `AgentLoop.Config` schemastery object validate the cap, so invalid `cordis.yml` values fail during config validation.

Within a parallel group, execution uses a rolling pool: start calls in model order up to `maxParallelToolCalls`, and whenever one call settles, start the next unstarted call until the group is exhausted. A group larger than the cap is not truncated; the cap limits simultaneous in-flight calls only.

Only the dispatch/body stage runs concurrently. Generic middleware that can shape ordering-sensitive state remains ordered: `tools/pre-execute` and `tools/post-execute` run in model call order. `@deepseek-ai/dsh-tools` exposes the symbol-keyed internal `TOOL_REGISTRY_SCHEDULER` view so `dsh-agent-loop` can split prepare, dispatch, and finalize without adding named staged service methods to `ctx.tools`; ordinary callers still use the one-call `execute(exec)` API. `tools/execute` around-dispatch listeners run with the dispatch they wrap, so wrappers must be reentrant across distinct `ToolExecution` objects. The shipped timeout policy is per-call: every call owns its mutable `exec` and deadline.

Each started call appends its own `tool/call` immediately before its pre-execute gate and body can run. `tool/call` events remain in model order relative to started calls, but their log positions may interleave with sibling results: a later call's `tool/call` can appear before or after an earlier call's `tool/result` as the rolling pool replenishes. That is safe because `tool/call` is log-only; derived model history reads the assistant's `tool-call` blocks and the ordered `tool/result` events, pairing by `callId`. Settled dispatches are stored in model-order slots, and a commit cursor appends `tool/result` only while the next slot is ready. `additionalContext` is collected from those same slots and injected in model call order after normal completion of every started tool result in the step.

If the parent signal is already aborted before a group starts, the group is not started and no `tool/call` audit records are appended for it. If the signal aborts while a parallel group is running, the pool stops replenishing, waits for only the already-started calls to settle, records their results in order, drops buffered `additionalContext`, and then raises the abort error so the existing `runTurn` catch path owns `turn/end` reason selection. This keeps every started call paired while avoiding audit records for calls that never began.

Code Mode remains outside native scheduling. In `mode: 'code'`, the wire exposes only `run_code`, so the model emits one native tool call and the loop-level scheduler has nothing to parallelize. `run_code` stays exclusive, and its in-program dispatch queue remains serialized. In `mode: 'both'`, native sibling tool calls can form parallel groups normally, while calls made inside one `run_code` execution still follow Code Mode's own queue.

## Tool declarations

The shipped declarations are conservative:

- `web_search`, `web_fetch`, filesystem `read`, and `subagent` return `true`.
- Filesystem `write`, filesystem `edit`, `todo_write`, `bash`, `bash_output`, `bash_kill`, `workflow`, `ask_user_question`, and Cordis mutation tools stay exclusive by omitting `isConcurrencySafe`.
- Bash stays exclusive until a bash-owned read-only classifier exists; the loop never infers shell safety.

Subagent providers do not get an extra opt-in field. `SubagentProvider.start()` is part of the provider contract and must be safe to call concurrently for independent runs. A provider backed by a limited resource may queue internally, apply its own capacity limit, or return a typed failure for the affected run, but it must not require the parent agent loop to serialize every `subagent` tool call. Built-in spawn, fork, and ACP runs own a child session or process; fork seeds only the parent's completed-turn prefix, so concurrent forks inside the parent's open step all see the same stable prefix.

Exclusive tools naturally form ordering barriers. A step such as `[read A, write A, read A]` becomes three ordered groups because `write` is exclusive, so the scheduler does not introduce a read/write race inside one assistant step.

The subagent tool remains synchronous. Multiple subagent tool calls in one assistant message can run concurrently, but each tool result is still the child final answer. Background spawning plus later collection would be a separate tool vocabulary.

## Testing

Unit tests cover the classifier (`ToolDefinition.isConcurrencySafe`, `defineTool()` soft validation, `ToolRegistry.executionMode`, and schema projection), the loop scheduler (grouping, exclusive barriers, rolling-pool replenishment, `maxParallelToolCalls: 1`, distinct `ToolExecution` objects, ordered pre/post middleware, ordered `tool/result`, concrete `tool/call`/`tool/result` interleaving, ordered `additionalContext`, and abort/drop-context cases), and first-party safe declarations for filesystem read, web tools, and subagent.

Snapshot coverage pins the transcript-facing ACP behavior for a multi-call step: several pending tool-call updates may precede model-ordered result updates. Code Mode tests and docs pin that `run_code` remains exclusive and that in-program dispatch stays serialized. No real-API e2e is required for this decision because scheduling is deterministic loop behavior with mocked tools and replayable snapshots, not provider-specific behavior.

## Alternatives considered

**Keep serial execution.** This keeps the loop simple and avoids new abort ordering cases, but it leaves obvious latency on the table for independent reads, web calls, and subagent delegations. The model and adapters already represent multiple tool calls in one assistant message, so serial execution is a host limitation rather than a protocol limitation.

**Codex-style tool-level `supportsParallelToolCalls`.** A tool-level boolean is smaller, but it cannot express that the same tool is safe for some inputs and unsafe for others. Bash is the key example: a read-only command classifier can make `pwd` or `ls` parallel-safe without making `rm` or a long-lived background-task operation parallel-safe.

**Parallelize the complete `ctx.tools.execute()` pipeline.** This preserves the existing one-call API in the loop, but it also runs `tools/pre-execute` and `tools/post-execute` concurrently. The shipped repeat-tool guard and hook bridges can carry ordering-sensitive state, so the shipped design keeps pre/post ordered and overlaps only dispatch/body work.

**Expose a public staged API such as `prepare` / `dispatch` / `finalize`.** That names too much implementation surface before another consumer exists. The loop needs staged behavior, but `ToolRegistry` factors it through a symbol-keyed internal view while keeping `execute(exec)` as the public one-call API for ordinary callers.

**Add a `tools/execution-mode` waterfall.** A Cordis seam would let hook bridges, provider policies, or MCP server metadata downgrade a tool's declaration. It is not needed for the conservative declaration set: raw and undeclared tools default exclusive, pre/post middleware stays ordered, and a non-reentrant around-dispatch wrapper can serialize internally. The `executionMode(exec)` method remains the insertion point if a real deployment needs policy-driven downgrades.

**Start tools while the model is still streaming.** Claude Code has a streaming executor path, but this repo's log reconstruction and surface-pairing contracts make that a larger design. This decision waits for the assistant message to be assembled, so the log records one authoritative assistant message before scheduling tools.

**Use fixed windows inside one parallel group.** Fixed windows would start `maxParallelToolCalls` calls, wait for all of them to settle, then start the next window. The rolling pool wins because slot-based result storage and a model-order commit cursor preserve the transcript contract without sacrificing avoidable latency.

**Expose concurrency in the model-facing schema.** The model does not need a scheduler flag to request multiple calls; it already can emit multiple `tool-call` blocks. Sending host-only concurrency metadata would bloat requests and mix execution policy into the schema whose job is only argument shape and tool-choice guidance.

## Consequences

Parallel execution can expose latent shared-state bugs in tools that declare themselves safe too broadly. The default is exclusive, the shipped declarations are conservative, and input-sensitive tools such as bash stay exclusive until their owning package proves a narrower classifier.

An around-dispatch plugin can also violate the contract even when the tool itself is safe. The scheduler limits that risk to `tools/execute`; shipped wrappers are per-call, and third-party wrappers with shared mutable state must serialize internally.

Parallel groups change abort timing: a sibling call may have started in a case where the serial loop would not have reached it yet. The pool makes this explicit by logging only started calls, stopping replenishment on abort, draining those calls to results, and preventing later calls from starting.

Concurrent subagents can compete for model quota, filesystem state, or external process resources. The provider contract requires concurrent `start()` safety, not unlimited capacity, and tool guidance still tells the model to parallelize only independent tasks with non-overlapping write scopes.

The result-order rule can delay a fast result behind a slow sibling in the same group. That preserves the model transcript and replay contract. ACP and stdio still expose immediate pending-call progress, but completion updates stay model-ordered.
