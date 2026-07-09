# RFC: Background subagent tasks

Status: implemented

## Problem

The subagent seam ([the seam RFC](2026-06-21-subagent-capability-seam.md)) exposes `start() -> SubagentRun`, and the model-facing `dsh-tool-subagent` consumer collected that run synchronously only: the parent turn blocked until the child returned one final result. That shape is simple and transport-neutral, but it makes slow delegation expensive for the parent. A model that wants two independent investigations must either run them serially or hold the parent step open for the entire child duration.

The harness already had one background-task precedent in bash: task ids, owner checks, output polling, stop, completion notifications, and prompt guidance. Subagents need the same user-facing habit, but not by copying bash's process-output semantics: a subagent does not expose an incremental stdout stream, and its child session remains the home for internal steps. The parent needs to start a child, keep working, later wait for or read the final answer, and stop the task when it is no longer relevant. An earlier draft of this RFC answered by cloning the bash protocol under subagent names (`subagent_wait`, `subagent_output`, `subagent_stop`) and reshaping `dsh-tool-subagent` into a multi-tool plugin so the clones would not collide across instances; [the background task runtime RFC](../architecture/2026-06-20-generic-long-running-tool-runtime.md) dissolved that duplication by extracting the registry and the control tools once, and this feature rides it.

The design also has two lifecycle constraints that the synchronous path does not face. First, a background subagent can outlive the tool call that started it, so the tool-call abort signal must not stay wired to the child after the id is returned. Second, a completion notice can only be injected into a live owner agent: once an ACP session closes or an agent handle is disposed, `agent.inject()` cannot append to that session. The feature must therefore define whether background subagents survive owner disposal.

## Decision

Each `dsh-tool-subagent` instance may expose `run_in_background?: boolean`, gated per instance by its defaulted `enableRunInBackground` config flag (default `true`; a disabled instance omits the parameter from its schema — the producer-opt-in shape [the runtime RFC](../architecture/2026-06-20-generic-long-running-tool-runtime.md) pins: the producer's config owns the schema, `ctx.tasks` only provides runtime registration). The plugin keeps its one-instance-per-provider shape — provider selection stays deployment config (`subagent` on `spawn`, `subagent_fork` on `fork`, …), and there are no subagent-specific companion tools to collide: collection, listing, and cancellation are the generic `task_output`/`task_list`/`task_kill` tools from `@deepseek-ai/dsh-tool-tasks`.

A foreground call keeps the synchronous semantics: it waits for `run.result`, returns final text on `completed`, maps non-clean terminal stop reasons to an errored tool result, and disposes the run in `finally`.

A background call validates that a parent agent exists, checks an already-aborted tool signal before starting, starts the provider run through `ctx.subagents`, registers the run with `ctx.tasks`, and returns `started background subagent task <task_id>`. After the id is returned the tool-call signal is NOT connected to `run.cancel()` — the parent step may finish while the child continues; cancellation belongs to `task_kill` and the owner-cleanup path. A registration that throws (the no-control-surface fence) does not orphan the child: the producer cancels the run, awaits its `done` (which settles only after `run.dispose()`), and rethrows — the model never learns an id for work that is not actually tracked. `ctx.tasks.register()` supplies the runtime guarantees this feature needs and this RFC does not implement: kind-prefixed branded task ids, owner-scoped access (the parent agent is the owner; another session's agent cannot read or kill the task), the loud no-control-surface failure, completion-notice injection, and the generic prompt guidance.

The registration maps the seam vocabulary onto the runtime's:

- `kind: 'subagent'`, `label`: the model's `description` argument, `owner`: the parent agent.
- `cancel`: `run.cancel(reason)` — the runtime forwards `task_kill`'s optional logged `reason`; the task shows as `stopping` until settlement.
- `done` (`settleRun`): awaits `run.result`, then awaits `run.dispose()` (child quiescence — `done` must not settle before the child agent/session is released), then maps the stop reason (`runOutcome`): `completed` → `completed` with the final text as `output`; `aborted` → `killed`; `error`, `max-tokens`, `refusal`, and unknown merge-extensible reasons → `failed` with the reason as `detail`. A rejected `run.result` (infrastructure fault) still disposes and settles `failed`.
- No `readOutput`: a subagent task is final-output-only. While it runs, `task_output` returns only the status line; once terminal it returns the final text (or failure detail) idempotently. The child session remains the detailed trace; v1 deliberately exposes no incremental transcript cursor.

## Lifecycle

The background task is scoped to the owner session, not durable across session closure. The runtime's awaited owner-cleanup path (the `AgentRegistry.onCleanup` seam, owned by [the runtime RFC](../architecture/2026-06-20-generic-long-running-tool-runtime.md)) cancels the owner's running tasks on agent disposal and awaits each task's `done` before `AgentHandle.dispose()` resolves; because this registration's `done` settles only after `run.dispose()`, owner disposal reaches child quiescence without leaking child agents or sessions. `agent/disposed` alone is not the mechanism — the registry emits it synchronously without awaiting listener work, which is exactly why the awaited seam exists. Completion notices are best-effort by the runtime's rule: a live owner gets the injected notice; a disposed owner drops it without throwing.

## Model guidance

The background-task habit (track ids, do not finish while a relevant task runs, collect with `task_output`, kill what stopped mattering) is the generic `dsh-tool-tasks` prompt section — one habit for bash and subagents alike, which is the point of the shared runtime. `dsh-tool-subagent` adds only the wording on its own tool: the description and the `run_in_background` parameter say the call returns a task id immediately and the final answer is collected with `task_output` (with `wait: true` when genuinely blocked on it). Runtime enforcement remains owner authorization and the awaited owner-cleanup path, not the prompt.

## Alternatives considered

### Why not subagent-specific `subagent_wait`/`subagent_output`/`subagent_stop` tools?

The earlier draft of this RFC. The clones duplicate the bash protocol, teach the model a second collect/stop habit, and force a structural reshape of `dsh-tool-subagent` (one multi-tool instance instead of one instance per provider) purely so the companion tools register once. The generic runtime provides the same operations kind-agnostically, keeps this plugin's shape untouched, and its `attachSurface` fence covers the half-loaded deployment failure the reshape was defending against. The reshape was dropped with the clones.

### Why not let background subagents survive owner session closure?

Survival after owner closure requires durable task state, child-session recovery, a way to surface late results into a reopened session, and policy for tasks whose owning client never returns. The agent runtime unregisters disposed agents, and `agent.inject()` intentionally rejects disposed targets. Scoping tasks to the owner and cleaning up through the awaited path makes the v1 lifecycle explicit and avoids orphaned child agents; a durable job system is the runtime RFC's named future direction, not this feature.

### Why not skip owner checks because ACP sessions are isolated?

ACP sessions isolate their logs and agents, but services such as `ctx.agents`, `ctx.tools`, and `ctx.tasks` are shared within the runtime, and task ids are global, predictable resource handles. The runtime enforces the owner fence for every task kind; this RFC merely notes that subagent tasks inherit it.

### Why not expose incremental subagent transcript output?

The child session is already the trace for internal reasoning, tool calls, and intermediate messages. Streaming that transcript into the parent would blur the parent/child log boundary that makes in-process and ACP providers equivalent. The first background surface returns status and final output only; richer observation belongs to UI/session tooling or a separate observation RFC.

## Testing

Unit coverage pins the stop-reason → outcome mapping (`runOutcome`, including unknown merge-extensible reasons), `settleRun`'s dispose-before-report on both result paths, the detached-signal contract (a pre-aborted signal refuses to start; a returned id is never wired to the tool signal), background settlement collected through the real `task_output`/`task_kill` tools, the no-orphan rollback when `register()` throws, per-instance schema gating (`enableRunInBackground: false` omits the parameter and the background wording), and the loud failure when the tasks runtime is absent. Snapshot coverage pins the changed `subagent`/`subagent_fork` schemas through the pinned-header fixture; recording a live background-delegation transcript requires a `DEEPSEEK_API_KEY` re-record and remains named follow-up work.

## Consequences

Slow delegation no longer holds the parent step open: the model fans out background children, keeps working, and collects with the same three control tools it already uses for bash — no new habit, no schema clones, and `dsh-tool-subagent`'s per-provider shape survived unchanged. The feature's usability depends on the tasks pair being loaded; the runtime's `register()` fence turns a missing control surface into a loud, actionable error rather than a silent dead end, and the `dsh-agent-core` bundle ships the pair so every stock deployment has it.

The prompt guidance reduces abandoned tasks but cannot force a model to collect every background result. Runtime cleanup through the awaited owner-disposal path is the hard stop; a future planner or guard could enforce "no final answer with relevant running tasks" more strongly if the prompt proves insufficient. A background child outliving its starting tool call means a misbehaving child consumes tokens until collected, killed, or owner-disposed; `task_list` keeps it visible, and setting `enableRunInBackground: false` per instance keeps a deployment's delegation strictly synchronous.
