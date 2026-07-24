# Agent-loop test migration guide (naive-machine contract)

The loop was rewritten in the naive-agent shape. `packages/core/agent-loop/src/agent.ts`
is the single source of truth — read it before migrating a spec. Key changes:

## Event seams (old → new)

| Old seam | Replacement |
|---|---|
| `agent/pre-step` (serial, before step/start) | `agent/step` (serial, before EVERY request derives; same position) |
| `agent/post-step` (serial, after tools, before step/end) | REMOVED — use `agent/step` of the next step, or `agent/idle` after the turn |
| `agent/session-prefix` (waterfall, request-only prefix) | REMOVED — requests carry no unlogged prefix; durable context via `agent.inject()` at `agent/session-start` |
| `agent/step-result` (waterfall, rewrite assistant msg) | REMOVED — the assembled message is recorded as-is |
| `agent/request-error` (waterfall, retry/fail decision) | REMOVED — observe `agent/idle` with `reason.kind === 'error'`, repair, then `agent.retry()` |
| `agent/turn-continuation` (waterfall, ContinuationDecision) | `agent/continue` (waterfall of `boolean`; handler `(agent, turn, signal, next)`) |
| `agent/turn-stop` (serial, terminal stop) | REMOVED — `agent/continue` returning `false` stops the turn |
| `agent/request` `(agent, turn, step, config, signal, next)` | `(agent, turn, step, signal, next)` — the config comes only from `await next()` |
| `agent/prompt-submit` | unchanged |

New emit: `agent/idle (agent, turn, reason: IdleReason)` fires once per closed turn
(after turn/end + flush, with `busy` already false, so listeners may synchronously
`retry()`/`send()`). `IdleReason = completed | aborted | { kind: 'error', error, failure? }`.

## Verb semantics

- `send()` — unchanged (queued FIFO, one turn each).
- `steer()` while running — enters the outbox; taken whole at the next step
  boundary. A turn failure leaves untaken steering staged without waking the
  agent; `retry()` or a later prompt takes it.
- `inject()` while the machine is busy — enters the outbox (a `context/message`
  appears at the NEXT step boundary, not immediately). While idle — writes a
  one-shot turn (`turn/start(injection)` + `context/message` + `turn/end`) and
  requests a flush. Enclosure is decided by `busy`, NOT by scanning the log for
  an open turn.
- `retry()` — NEW verb: re-opens a turn on the current log with trigger
  `{ kind: 'retry' }`. Throws while busy ("cannot retry while busy") and after
  disposal. Legal from a synchronous `agent/idle` listener.
- `cancel()` — unchanged surface. No more "pre-run cancelled" bookkeeping:
  clearing the queue before a run starts simply means no run starts.

## Machine shape (timing-sensitive tests)

- `kick()` runs SYNCHRONOUSLY from `send()` when idle: status flips to
  `running` inside the `send()` call. There is no parked driver loop, no
  waitForQueued, no microtask collection window.
- One `run()` = one turn. After `turn/end`, it emits `agent/idle`, then either
  starts the next waking queued prompt or flips status to `idle`. Residual
  outbox input does not wake the agent. Status stays `running` continuously
  across queued turns.
- `step/end` is appended INSIDE the step (after tools + the in-step outbox
  drain), before `agent/continue` runs. The old `post-step → step/end`
  window no longer exists.
- Request messages = `session.deriveMessages()` snapshot taken right before
  `step/start` — no `messagePrefix`. `request/header` events no longer carry
  a `messagePrefix` field.
- Provider/model config waterfall (`agent/request`) runs INSIDE the step
  (after step/start), seeded from agent options (first request) or the folded
  logged header (later requests).
- The assembled assistant message is recorded verbatim (with replayState when
  present); there is no rewrite path and no "content-less anchor on rejection".
- A model failure (thrown by the adapter or a failure finish chunk) closes the
  turn: balanced step/end + turn/end `{ kind:'error', step, failure }` +
  `agent/error` emit + `agent/idle` `{ kind:'error', error, failure }`.
  There are no in-turn recovery steps.
- Cancellation classification: signal reason `user`/`parent` → turn/end
  `aborted`; disposal → `disposed`. IdleReason for both is `aborted`.
- A blocked prompt (`prompt-submit` → block) records `prompt/blocked`, closes
  a zero-step turn `rejected` in turn/end, and emits `agent/idle`
  `{ kind: 'completed' }` (rejection is a policy outcome, not an error).
- Accept-validation error message is now
  "agent message content and source must be losslessly JSON-serializable".
- `dispose()` (the prepared disposer / factory teardown) returns `undefined`
  when the machine is not busy — do not `.resolves` it unconditionally; use
  `await Promise.resolve(dispose())`.

## What to do with tests of removed seams

- Rewrite the scenario against the nearest new seam when the protected
  behavior still exists (e.g. turn-stop tests → `agent/continue` returning
  false; request-error retry tests → `agent/idle` + `retry()` flows).
- Delete tests whose subject no longer exists at all (session-prefix
  reconstruction, step-result rewrite provenance, post-step ordering windows,
  pre-run-cancel bookkeeping). Do not keep zombie tests alive by weakening
  their assertions.
- Keep the durable-log invariants strong: balanced turn/step boundaries,
  ordered tool call/result pairs, header change tracking — those still hold.
