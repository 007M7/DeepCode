# @deepseek-ai/dsh-subagent-control

The continuable-subagent control service (`ctx.subagentControl`): the one orchestration path that binds a durable child session to a series of disposable Task-backed activations. Model tools and human-facing adapters call the same contract; the low-level `ctx.subagents` seam stays collection-, Task-, and persistence-agnostic.

## Activation lifecycle

A continuable background subagent is a durable child session with a series of Task-backed activations. `startContinuable()` allocates the stable child session id before Task creation, snapshots the descriptor inputs (a non-JSON input throws with no Task), and registers the initial activation's Task; the provider publishes exactly that child id and appends the versioned `subagent/descriptor` event inside the child's first turn. Every activation — initial or resumed — creates a fresh Task whose settlement awaits the provider's durability-confirmed child result, disposes the run, and only then records the `TaskOutcome`: a terminal Task leaves the durable child session but no live child Agent. A provider rejection with `DURABILITY_FAILED` settles the Task as `failed` and copies the error message into `detail`, so `task_output` reports the failed checkpoint and resumability risk without exposing unconfirmed output.

`sendMessage(parent, childId, message, source)` owns steer-or-resume routing and requires the caller's `MessageSource`. A running activation preserves it through the run's strict `steer` capability and returns the existing Task id (`steered`); an absent activation starts a fresh Task that loads the persisted child, authorizes the recorded `parentSession` as the direct parent, folds the descriptor, and dispatches `SubagentService.resume()` with the same source (`started`). Either route projects the content to the model as a user-role message while retaining its source in the child log. Failure throws and means the message was not delivered: losing a strict-steering race with Task settlement never falls through to cold resume within the same call, and a live registry Agent outside the activation association is an ownership conflict rather than an adoption target.

Cancellation targets the whole activation. `task_kill` or owner disposal aborts the Task-owned signal; before publication the provider rejects only after its creation transaction rolled back to quiescence, afterwards the signal cancels the published run, and settlement records `killed` only once the activation is quiescent. Human input shares this path: an adapter submits child input through `sendMessage()` under the loaded parent, so parent and human messages that joined one turn share its result and cancellation outcome, and `TaskService.start()`'s control-surface requirement applies (load `@deepseek-ai/dsh-tool-tasks` or attach a surface).

The activation association is process-local routing state, installed before any persistence or provider await and removed after run disposal and Task terminal publication. It is not a durable catalog: restart recovers the child session, not in-flight Tasks or their notifications.

## Model Experience

### Task completion and output

#### What the model sees

None directly, as this package registers no tool and no prompt text; the model observes continuable children through `@deepseek-ai/dsh-tool-subagent`'s background acknowledgement, `@deepseek-ai/dsh-tool-subagent-control`'s `send_message` results, and the generic task surface, whose outputs this service produces.

#### Token effect

None beyond the consuming tools' own results.

#### KV Cache effect

None; this service appends nothing to any model-visible sequence.

## Known Limitations and Deferred Work

- **Concurrent stopped-child admission is not atomic across awaits** — the synchronous association install admits one activation per child in this process, but a caller bypassing the control service can still race it; the Agent registry's same-id collision is the final backstop, and the losing Task fails with its message not delivered.
- **The association coordinates only one runtime** — concurrent resume from multiple processes needs a persistence-level lease or compare-and-set, which no backend offers yet.
- **Task records are process-local** — restart recovers the durable child session, not an interrupted Task, its result, or its completion notice; durable Task recovery is a separate concern.
- **Human interaction requires the exact live parent Agent** — Task access is fenced by the owner session and owner disposal cancels its Tasks; standalone child conversations belong to the interactive-side-sessions proposal, not this Task-owned lifecycle.
- **ACP children remain one-shot** — `AcpProvider.resume` and per-child continuation advertisement are deferred until the remote-session descriptor contract is resolved.
