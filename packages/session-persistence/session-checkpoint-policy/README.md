# dsh-session-checkpoint-policy

Semantic durability policy for persisted agents. It checkpoints the event-sourced session before a model adapter receives a request, before a top-level tool body may produce an external side effect, and after a step has recorded its complete assistant message and ordered tool results. The final `turn/end` checkpoint remains owned by `dsh-agent-loop`.

## Plugin (namespace: `session-checkpoint-policy`)

This zero-config function plugin consumes `ctx.sessions`, `ctx.llm`, `ctx.tools`, and the presence of `ctx.sessionPersistence`. Load it beside one persistence backend:

```yaml
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
```

Persistence and checkpoint scheduling are intentionally separate Cordis plugins. A persistence backend makes each requested `session/flush` durable; this policy chooses the request, tool-dispatch, and completed-step checkpoints. Loading a backend without this policy is valid and retains checkpoints requested by the loop, including final `turn/end`, but crash recovery may lose the rest of an in-flight turn. First-party persisted apps and runtimes mount both plugins explicitly; a specialized deployment may deliberately omit or replace the policy.

The policy wraps `llm/stream` lazily, so the downstream stream is not constructed until the live session's buffered request events are durable. It wraps `tools/execute` after pre-execute policy and guards; a top-level tool body runs only after its recorded call is durable. If cancellation lands while that flush is pending, the wrapper returns the canonical `ABORTED_BEFORE_DISPATCH` result without entering the tool body. Nested tool dispatches reuse the outer model-visible call's checkpoint. `agent/post-step` persists the complete response/result batch before continuation work.

The loop records its assistant message and ordered tool results before dispatching `agent/post-step`, so the policy always captures that core batch. An event appended by another `agent/post-step` listener is captured at this checkpoint only when that listener is registered before the policy; Cordis registration order is the explicit composition rule for such extensions.

Checkpoint rejection is fail-closed at the model and tool boundaries: neither the adapter nor the top-level tool body runs. A post-step rejection fails the turn before another request starts. Concurrent tool checkpoints share the session store's serialized persistence drain and cannot duplicate sequence numbers.

## Model Experience

### Interrupted calls

#### What the model sees

The plugin adds no prompt or tool schema. A hard crash after a tool checkpoint but before its result leaves a durable unmatched call; session recovery supplies the model-visible `TOOL_OUTCOME_UNKNOWN` result owned by `dsh-session`. The message permits retry for read-only or idempotent work and requires state verification or user confirmation for calls that may have side effects.

#### Token effect

Successful checkpoints add no tokens and do not change the request. Recovery adds one short tool-result message to balance the interrupted transcript.

#### KV Cache effect

The repair result is appended after the reusable prefix, so it does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- The policy durably records execution intent, not generic exactly-once effects. Side-effecting tools should forward `exec.callId` as an idempotency key when their provider supports one.
- Streaming `assistant/chunk` events have no per-chunk checkpoint. They reach storage with the next semantic checkpoint, so a hard crash may lose the current partial response.
- A persisted call without a result cannot prove whether its external effect completed. Recovery therefore records an unknown outcome instead of retrying automatically.
