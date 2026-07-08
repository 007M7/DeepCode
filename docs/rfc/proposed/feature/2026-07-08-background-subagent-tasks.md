# RFC: Background subagent tasks

Status: proposed

## Problem

The subagent seam ([the seam RFC](../../implemented/feature/2026-06-21-subagent-capability-seam.md)) exposes `start() -> SubagentRun`, and the model-facing `dsh-tool-subagent` consumer collects that run synchronously: the parent turn blocks until the child returns one final result. That shape is simple and transport-neutral, but it makes slow delegation expensive for the parent. A model that wants two independent investigations must either run them serially or hold the parent step open for the entire child duration.

The harness already has one background-task precedent in bash. Bash has task ids, owner-token checks, output polling, stop, completion notifications, and prompt guidance. Subagents need the same user-facing habit, but not by copying bash's process-output semantics: a subagent does not expose an incremental stdout stream, and its child session remains the home for internal steps. The parent needs to start a child, keep working, later wait for or read the final answer, and stop the task when it is no longer relevant.

The design also has two lifecycle constraints that the synchronous cut does not face. First, a background subagent can outlive the tool call that started it, so the tool-call abort signal must not stay wired to the child after the id is returned. Second, a completion notice can only be injected into a live owner agent: once an ACP session closes or an agent handle is disposed, `agent.inject()` cannot append to that session. The feature must therefore define whether background subagents survive owner disposal.

## Proposal

Add a background mode to the existing model-facing subagent tools and add three companion tools: `subagent_wait`, `subagent_output`, and `subagent_stop`. The background task registry lives in `@deepseek-ai/dsh-subagent`, keyed by branded task ids and owner tokens, while `@deepseek-ai/dsh-tool-subagent` owns the model-facing schemas, text rendering, completion notice injection, and prompt guidance.

`dsh-tool-subagent` becomes a single multi-tool consumer plugin instead of one plugin instance per provider. Its config maps model-facing tool names to provider names, so one plugin instance can register `subagent`, `subagent_fork`, and any deployment-specific aliases such as `subagent_acp`, plus the shared background control tools. Providers remain named implementations on `ctx.subagents`: `spawn`, `fork`, `acp`, or future backends. This keeps provider implementation and model-facing exposure separate while avoiding a failure mode where one `subagent` tool exposes `run_in_background` but the companion wait/output/stop tools were never loaded.

The background task is scoped to the owner session, not durable across session closure. A background subagent starts only from a model-driven call with `exec.agent`; the service stores the caller's `session.header.id` as the owner token. `subagent_output`, `subagent_wait`, and `subagent_stop` compare that stored token with the caller's session id and reject cross-session access. When the owner agent is disposed, an awaited owner-cleanup path cancels any running background subagent tasks for that owner and waits for their settlement/dispose before the owner handle reports quiescence. Completion notices are best-effort: if the owner agent is still registered, `dsh-tool-subagent` injects a short `context/message`; if the owner is gone, no notice is written.

## Tool surface

Each configured delegation tool may expose `run_in_background?: boolean`. The deployment can disable background mode per tool; a disabled tool does not include the parameter in its schema. A foreground call keeps the synchronous semantics: it waits for `run.result`, returns final text on `completed`, maps non-clean terminal stop reasons to an errored tool result, and disposes the run in `finally`.

A background call validates that a parent agent exists, starts the provider run through `ctx.subagents`, registers a task, and returns `started background subagent task <task_id>`. It checks an already-aborted tool signal before starting, but after the id is returned it does not keep the tool-call signal connected to `run.cancel()`. The parent step may finish while the child continues.

`subagent_output` is a non-blocking status read for a background subagent task. While the task is `running` or `stopping`, it returns only a status line. Once terminal, it returns the final text output or error message plus the terminal status. Reading output is idempotent and does not consume the result; v1 deliberately exposes no incremental transcript cursor because the child session remains the detailed trace.

`subagent_wait` waits for a task to become terminal, bounded by a defaulted and capped timeout from `dsh-tool-subagent` config. A wait timeout returns `running` and leaves the child alive. Aborting the wait call cancels only the wait, not the background task.

`subagent_stop` requests cancellation of a running or stopping task and returns immediately. The task registry remains responsible for observing the run settle, recording the terminal state, and disposing the run. Calling stop on an already-terminal task reports that terminal state rather than failing.

## Runtime task model

`@deepseek-ai/dsh-subagent` adds a runtime-global task registry to `SubagentService`. Task ids and owner tokens are branded types. A task snapshot records the task id, provider name, child run id, owner token, status, started/finished timestamps, final output, and error message. The status vocabulary is `running`, `stopping`, and the existing terminal `SubagentStopReason` values (`completed`, `aborted`, `error`, `max-tokens`, `refusal`, plus merge-extensible provider values).

The registry owns task settlement. It attaches one continuation to `run.result`; on success it stores the final output and stop reason, on rejection it stores `error`, and in both cases it disposes the run and notifies task-done listeners. Listener failures are contained and logged so one consumer cannot starve cleanup.

The registry is runtime-global because `ctx.subagents` is a service shared by all live agents in the Cordis context. Session isolation is therefore explicit owner-token authorization, not an assumption about separate service instances. This mirrors the bash background-task fence: predictable ids are safe only when read/stop operations check the caller's owner token.

Owner disposal is a hard lifecycle boundary, but `agent/disposed` alone is not the cleanup mechanism. The current agent registry emits `agent/disposed` synchronously after removing the agent, and `AgentHandle.dispose()` does not await asynchronous listener work. This feature therefore also adds an awaited owner-cleanup seam: background task registration attaches an owner-scoped disposer that runs in the owning agent's disposal chain before that handle resolves. That disposer finds tasks owned by the agent's session id, requests cancellation, waits for each task's settlement path to record the terminal snapshot, and awaits `run.dispose()`. The existing `agent/disposed` event may still be used as a best-effort notification/fallback, but it must not be the path that promises child quiescence. The service does not attempt to persist unfinished task state, resume children, or inject into disposed sessions. A future durable job system can extend this boundary, but this feature intentionally keeps background subagents tied to live sessions.

## Model guidance

`dsh-tool-subagent` registers a system-prompt section that teaches the background-task habit:

- Keep track of every task id returned by a background subagent call.
- Do not produce a final answer while a relevant background subagent is still running.
- While waiting, continue independent exploration or use other tools when useful.
- Before summarizing or handing work back, call `subagent_wait` or `subagent_output` to collect finished tasks.
- Call `subagent_stop` for a background task that is no longer needed.
- End without collecting a task only when its result is irrelevant or the task was explicitly stopped.

This prompt guidance is not the enforcement boundary. Runtime enforcement is owner-token authorization and the awaited owner-cleanup path. The guidance keeps ordinary model behavior from accidentally abandoning relevant work while still allowing explicit stop or irrelevance.

## Relationship to generic long-running tools

The generic long-running tool runtime RFC ([Extract a generic long-running tool runtime](../../proposed/architecture/2026-06-20-generic-long-running-tool-runtime.md)) remains the larger direction for shared task ids, owner tokens, cancellation, completion notices, and presentation. Background subagents should not block on that extraction because subagents have a narrower result model than bash: no incremental stdout, no spill files, and no process exit markers. The implementation should keep the subagent registry small and shaped so it can later migrate into a generic runtime without changing the model-facing `run_in_background`, `subagent_wait`, `subagent_output`, and `subagent_stop` contract.

## Alternatives considered

### Why not keep one `dsh-tool-subagent` instance per provider?

The existing one-instance-per-provider shape makes aliasing simple, but companion tools become ambiguous. If each instance registers `subagent_wait`, duplicate tool names collide. If only one instance registers them, deployments can accidentally expose `run_in_background` without the tools required to collect or stop the task. A single multi-tool consumer config keeps provider selection in deployment config and makes the background control plane atomic.

### Why not put wait/output/stop in a separate plugin?

A separate plugin has the same half-loaded failure mode: `subagent` could advertise background mode while the control tools are absent. The control tools are part of the model-facing subagent contract, so they should be registered by the same consumer plugin that adds `run_in_background`.

### Why not let background subagents survive owner session closure?

Survival after owner closure requires durable task state, child-session recovery, a way to surface late results into a reopened session, and policy for tasks whose owning client never returns. The current agent runtime unregisters disposed agents, and `agent.inject()` intentionally rejects disposed targets. Tying background tasks to an awaited owner-cleanup path makes the v1 lifecycle explicit and avoids orphaned child agents.

### Why not skip owner-token checks because ACP sessions are isolated?

ACP sessions isolate their logs and agents, but services such as `ctx.agents`, `ctx.tools`, and `ctx.subagents` are shared within the runtime. A background-task id is a global resource handle. Without an owner check, another live session in the same runtime could guess or receive a task id and read or stop it.

### Why not expose incremental subagent transcript output?

The child session is already the trace for internal reasoning, tool calls, and intermediate messages. Streaming that transcript into the parent would blur the parent/child log boundary that makes in-process and ACP providers equivalent. The first background surface returns status and final output only; richer observation belongs to UI/session tooling or a separate observation RFC.

## Acceptance criteria

- A deployment config can expose `subagent` and `subagent_fork` from one `dsh-tool-subagent` instance while binding them to different providers.
- A configured delegation tool exposes `run_in_background` only when that tool enables background mode.
- A background call returns a task id immediately and the parent can continue using other tools before collecting the result.
- `subagent_output`, `subagent_wait`, and `subagent_stop` enforce owner-token access and reject cross-session task ids.
- A task that finishes while the owner agent is live injects a durable completion notice into the owner session; a task whose owner is disposed does not throw while trying to notify.
- Disposing the owner agent runs an awaited owner-cleanup path that cancels all of that owner's running background subagent tasks and reaches quiescence without leaking child agents; tests prove `agent/disposed` alone is not relied on for this guarantee.
- Snapshot coverage proves the changed tool schemas and the completion-notice path; unit coverage pins foreground compatibility, background settlement, timeout, stop, owner isolation, and owner-disposal cleanup.

## Risks

The multi-tool config reshapes how deployments expose provider aliases, so examples and generated tool catalogs must move together with the implementation. The pre-release policy allows this churn, but the migration must update every shipped config in one change.

The prompt guidance can reduce abandoned tasks but cannot force a model to collect every background result. Runtime cleanup through the awaited owner-disposal path is the hard stop; a future planner or guard could enforce "no final answer with relevant running tasks" more strongly if the prompt proves insufficient.

The task registry duplicates some concepts named by the generic long-running-tool RFC. Keeping the subagent registry final-output-only and service-local limits that duplication, but a later generic runtime extraction will still need a careful migration.
