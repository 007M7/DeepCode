# @deepseek-ai/dsh-goal

Event-sourced same-session goal state. The service retains one current completion objective in an agent's existing session while keeping permission to continue as process-local activation. The [goal-domain Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-persisted-same-session-goal-domain.md) owns the design rationale; the [goal type catalog](../../../docs/core-data-structures/goal.md) records the literal data shapes.

## Config

```yaml
- id: goal
  name: '@deepseek-ai/dsh-goal'
  config:
    defaultMaxGoalRounds: 256
```

`defaultMaxGoalRounds` must be a positive safe integer. `create()` materializes this deployment default internally before committing a goal; a request-level value overrides it.

## Service contract

`ctx.goals` accepts only the exact live `Agent` instance registered under its id. `get()` returns a detached `GoalView`; mutations use a `GoalRef { id, revision }` compare-and-set fence and reject stale refs. The service exposes create, edit, pause, resume, complete, block, and clear verbs through the generated [service catalog](../../../docs/cordis-catalog/services.md). Creation default resolution is internal. `disarm()` is the lifecycle-only exception: it removes process-local continuation authority without writing a revision or emitting a mutation.

At most one goal is current. Creation produces an active revision-one goal and arms it. A non-complete goal must be edited, transitioned, or cleared; a completed goal may be replaced by a globally fresh id. Edits retain phase, blocker reason, and activation. Pause, completion, blocking, and clear disarm activation. A block records a policy-owned lower-kebab-case code plus a normalized free-form explanation; provider limits, configured budgets, execution errors, and requests for human input all use this one durable phase rather than multiplying lifecycle states. Resume accepts a stopped phase or a disarmed active goal only while the configured round cap has remaining capacity; it clears any former blocker reason. An active armed goal rejects the redundant operation.

Every non-clear mutation appends a complete versioned snapshot through `agent.inject()`; clear appends a revisioned tombstone. The `context/message` content projected verbatim to the model, its `{ kind: 'goal' }` source, and its metadata must agree exactly. Replay rejects malformed shapes, source/content drift, discontinuous revisions, illegal lifecycle transitions, non-monotonic per-goal timestamps, and non-sequential goal rounds. Mutation timestamps clamp against the preceding goal update when wall time moves backward.

Injection may append immediately or wait in an active tool-batch FIFO. The service overlays accepted pending changes in memory and reconciles each exact payload when it enters the log, so consecutive model-tool mutations see their own latest revisions without treating an unlogged cache as durable state. Reentrant append observers see each accepted mutation exactly once, and incremental replay retains its cursor at the first corrupt event. `goal/changed` fires after the append or enqueue succeeds; listener failures are contained.

Activation is never persisted. A fresh cache and every `agent/session-start` edge disarm it even when replay finds an active durable phase. A continuation driver also calls `disarm()` before unload or after durability uncertainty. Session resume, fork, and driver replacement therefore retain the objective, phase, revisions, and admitted-round count without initiating work; a later explicit resume mutation must arm continuation.

The separately published `./invariant` companion maintains an independent fold of each attached session. It rejects malformed goal metadata, source or model-visible content drift, discontinuous revisions, illegal lifecycle transitions, timestamp regressions, and non-sequential admitted rounds before the candidate event enters the durable log.

## Extension points

Policy plugins call the service verbs and react to the scoped `goal/changed` event. A continuation consumer admits rounds as `user/message` events with `GoalMessageSource`; ordinary human turns never increment `roundsStarted`. Consumers use the `Agent` interface and events rather than importing `dsh-agent-loop`.

## Model Experience

### Goal-state mutation

#### What the model sees

Each mutation is one raw user-role context block. A snapshot is rendered as `<goal_state>{"goal":...,"roundsStarted":...,"createdAt":...,"updatedAt":...}</goal_state>`; a clear renders the tombstone id/revision and `clearedAt`. There is no hidden state summary outside the log. The descriptive XML delimiter follows this repository's existing `<workspace_context>` convention and [Anthropic's published XML-tag prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags); it is public model-experience prior art, not a claim about any provider's proprietary training corpus.

#### Token effect

Every retained mutation adds one full snapshot to derived history until compaction shadows it. Full snapshots make each record independently inspectable but repeat the objective and lifecycle fields.

#### KV Cache effect

Append-only within an epoch: each mutation follows the reusable request prefix and preceding history. Compaction may replace the derived-history suffix and move the reusable boundary.

## Known Limitations and Deferred Work

- **State, not scheduling** — this package does not decide when an armed goal continues, retry abnormal failures, or cancel an active turn; those policies belong to agent-seam consumers.
- **Round-count budget only** — `maxGoalRounds` does not meter tokens, currency, wall time, or provider quotas.
- **No independent evaluator** — the caller that records completion or blocking is authoritative; evaluator-backed certification is deferred to a separate policy layer.
- **One current goal** — parallel objectives and a separate goal database are intentionally absent; history remains available in the session log after replacement or clear.
- **Trusted in-process producers** — a plugin with direct `Session` access can append counterfeit goal metadata. Strict replay detects malformed or inconsistent records and leaves goal access failed at that record until the log is repaired; this is integrity detection, not plugin isolation.
