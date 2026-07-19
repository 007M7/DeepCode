# @deepseek-ai/dsh-time-context

Opt-in durable context with the current zoned time and elapsed time sampled during model-request preparation. `dsh-agent-spine-demo` and shipped examples do not mount it. Decision record: [the durable time-context Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai  # optional IANA override; omit for the process zone
    refreshIntervalMs: 60000 # optional; omit or set to 0 for every eligible attempt
```

When `timeZone` is omitted, the plugin resolves the Node process's system zone once at plugin load. Node honors `TZ`; without that override, the host or container supplies the zone. An explicit `timeZone` must be an IANA identifier and is validated at plugin load.

`refreshIntervalMs` must be a non-negative safe integer. Omission or `0` appends on every pre-step attempt whose signal is not already aborted. A positive value appends only when the session has no earlier time-context injection, wall time moved backward, or at least that many milliseconds have elapsed since the latest injection.

## Timing semantics

The plugin prepends an `agent/pre-step` listener. When an injection is due, it appends one `context/message` through `agent.inject()` before `step/start` and ordinary automatic compaction, with source `{ kind: 'plugin', plugin: 'time-context' }`. A suppressed attempt appends nothing.

Positive-interval scheduling scans the raw durable session events for the latest `context/message` with that source, including a reading shadowed by compaction. The schedule therefore applies across turns and resumed processes without process-local cache state. It reduces append frequency and history growth but never removes an existing reading, and sessions schedule independently.

Step 1 measures from the latest preceding model-visible message, including the prompt that opened the turn. Later steps measure from the preceding time-context event in the same turn. Both baselines use durable session-event timestamps; backward wall-clock movement clamps elapsed time to zero. A missing first-step baseline, or a later step with no earlier same-turn reading because interval suppression skipped it, reports `unavailable`.

A time reading records a request-preparation attempt, not a committed step or transmitted request. Because the listener runs first, its append may remain when a later pre-step listener cancels or fails the attempt; the log is append-only and the plugin performs no rollback.

The time reading stays in derived conversation history until a later compaction shadows it. Request headers contain no time-context state. Request reconstruction uses the complete durable surface prefix at each `step/start`, so transmitted requests need not map one-to-one to readings: a failed preparation can leave an extra reading, while interval suppression can let a request reuse existing history without adding one.

## Model Experience

### Preparation-time temporal context

#### What the model sees

On each preparation attempt that injects, one source-tagged context message containing the two lines below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; durations use compact whole-second units. Positive intervals can leave an attempted step without a new reading.

##### First step

```markdown
Time sampled while preparing turn <turn>, step 1: <timestamp>
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

##### Later steps

```markdown
Time sampled while preparing turn <turn>, step <step>: <timestamp>
Elapsed since the preceding step context: <duration-or-unavailable>.
```

#### Token effect

Each injected two-line message accumulates until compaction shadows it. A positive interval reduces additions; omission or `0` adds one for every eligible preparation attempt.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Whole-second display** — timestamps and durations omit sub-second precision even though durable event times retain milliseconds.
- **Session-event baseline** — elapsed time starts from durable append timestamps, not a client transport's original send timestamp.
- **Process-local default zone** — omission uses the Node process's `TZ`, host, or container zone captured at plugin load, not a remote user's zone; configure an explicit IANA zone when those differ.
- **History cost between compactions** — omission or `0` retains one reading for every eligible preparation attempt, including attempts later cancelled or failed; a positive interval reduces but does not eliminate this cost.
