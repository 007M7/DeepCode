# @deepseek-ai/dsh-time-context

English | [中文](README.zh.md)

Opt-in durable context with the current zoned time, Session and request-zone authority, and elapsed time sampled during model-request preparation. Default compositions do not mount it; the opt-in Schedule Web overlay does. Decision record: [the durable time-context Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai  # optional fallback for headerless Sessions; omit for the process zone
    refreshIntervalMs: 60000 # optional; omit or set to 0 for every eligible attempt
```

When a Session has `SessionHeader.timeZone`, that immutable IANA zone formats its readings. A headerless Session instead uses the configured fallback; when `timeZone` is omitted, the plugin resolves the Node process's system zone once at plugin load. Node honors `TZ`; without that override, the host or container supplies the fallback. An explicit `timeZone` is validated at plugin load but does not override a Session-owned zone.

`refreshIntervalMs` must be a non-negative safe integer. Omission or `0` adds context to every eligible request preparation whose final pre-step decision contains input and whose signal is not already aborted. A positive value adds it only when the session has no earlier time-context injection, wall time moved backward, or at least that many milliseconds have elapsed since the latest injection.

## Timing semantics

The plugin opens a narrow authority envelope in `system-prompt/assemble` and closes it around `agent/pre-step`. It captures already-claimed input, and each user steering message admitted during asynchronous assembly is followed synchronously by a superseding same-step authority. AgentLoop includes the envelope's non-authority messages in the downstream pre-step proposal; after downstream edits, discards, or filtering settle, time-context derives the final authority from that decision.

An entering step records its downstream messages followed by exactly one final time-context `UserMessage` after `step/start`. Its source is `{ kind: 'plugin', plugin: 'time-context', authority }`, where `authority` identifies the proposed turn and step, the Session zone as `resolved` or `unavailable`, and the current request's client zones as `resolved`, `mixed`, or `missing`. An empty downstream decision consumes the envelope without opening a step or request.

If preparation exits before `step/start`, AgentLoop removes the envelope before closing the turn. It may settle an appendable final authority inside that failed turn, but an append failure drops the authority instead of leaving it pending. Cancellation cannot generate another authority after it wins; plugin disposal removes pending authorities and an in-flight listener contributes nothing after disposal. Steering and unrelated inbox work retain their ordinary cancellation policy, and no authority for an old turn or step can leak into a later request.

Positive-interval scheduling scans the raw durable session events for the latest `user/message` with that source, including a reading shadowed by compaction. The schedule therefore applies across turns and resumed processes without process-local cache state. It reduces append frequency and history growth but never removes an existing reading, and sessions schedule independently.

Step 1 measures from the latest durable model-visible message before the current proposal; the prompt entering that same step has not been appended yet. Later steps measure from the preceding time-context event in the same turn. Both baselines use durable session-event timestamps; backward wall-clock movement clamps elapsed time to zero. A missing first-step baseline, or a later step with no earlier same-turn reading because interval suppression skipped it, reports `unavailable`.

A time reading records request preparation, not a completed step or transmitted request. A later request-preparation failure can therefore leave the reading in history, and a no-step failure can settle an already-sampled authority inside its failed turn.

The separately published `./invariant` companion strictly decodes each plugin-attributed authority and checks it against the open turn, next pre-step position, elapsed baseline, and durable event time. Its rendered timestamp must parse and cannot postdate the event; process suspension between sampling and append does not invalidate the reading.

The time reading stays in derived conversation history until a later compaction shadows it. Request headers contain no time-context state. Request reconstruction uses the complete durable surface prefix after each `step/start`, so transmitted requests need not map one-to-one to readings: request preparation can fail after step entry, while interval suppression can let a request reuse existing history without adding one.

## Model Experience

### Preparation-time temporal context

#### What the model sees

On each preparation attempt that injects, one source-tagged context message contains the four lines below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; durations use compact whole-second units. The Session line reports the immutable Session zone or `unavailable`, and the client line reports one resolved zone, a sorted mixed set, or `missing`. Positive intervals can leave an attempted step without a new reading.

##### First step

```markdown
Time sampled while preparing turn <turn>, step 1: <timestamp>
Session time zone: <iana-zone-or-unavailable>.
Client time zone for this request: <iana-zone-or-mixed-set-or-missing>.
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

##### Later steps

```markdown
Time sampled while preparing turn <turn>, step <step>: <timestamp>
Session time zone: <iana-zone-or-unavailable>.
Client time zone for this request: <iana-zone-or-mixed-set-or-missing>.
Elapsed since the preceding step context: <duration-or-unavailable>.
```

#### Token effect

Each injected four-line message accumulates until compaction shadows it. A positive interval reduces additions; omission or `0` adds one for every eligible preparation attempt.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Whole-second display** — timestamps and durations omit sub-second precision even though durable event times retain milliseconds.
- **Session-event baseline** — elapsed time starts from durable append timestamps, not a client transport's original send timestamp.
- **Headerless fallback zone** — a Session without `SessionHeader.timeZone` renders through the configured or process fallback but reports Session authority as `unavailable`; consumers that require unambiguous local-time interpretation must request an explicit zone.
- **Immutable Session zone** — a Session zone does not change when another browser resumes it. The per-request client authority reports disagreement instead of silently changing the displayed default.
- **History cost between compactions** — omission or `0` retains one reading for every eligible preparation attempt, including attempts later cancelled or failed; a positive interval reduces but does not eliminate this cost.
