# @deepseek-ai/dsh-time-context

English | [中文](README.zh.md)

Opt-in durable context with the current zoned time, immutable Session zone, request-bound browser zones, and elapsed time sampled during model-request preparation. Default compositions do not mount it; the opt-in Schedule Web overlay does. Decision record: [the durable time-context Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-durable-per-step-time-context.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai  # optional fallback for headerless Sessions; omit for the process zone
    refreshIntervalMs: 60000 # optional; omit or set to 0 for every non-empty entered request batch
```

When a Session has `SessionHeader.timeZone`, that immutable IANA zone formats its readings. A headerless Session instead uses the configured fallback; when `timeZone` is omitted, the plugin resolves the Node process's system zone once at plugin load. Node honors `TZ`; without that override, the host or container supplies the fallback. An explicit `timeZone` is validated at plugin load but does not override a Session-owned zone.

`refreshIntervalMs` must be a non-negative safe integer. Omission or `0` adds context to every non-empty entered request batch whose signal is not already aborted. A positive value adds it only when the session has no earlier time-context injection, wall time moved backward, or at least that many milliseconds have elapsed since the latest injection.

## Timing semantics

The plugin prepends an `agent/pre-step` listener and delegates first. When the downstream decision enters a non-empty message batch, time-context derives client zones from those final messages plus user-rpc messages already entered in the open turn, then appends one reading to that decision. Schedule later derives the same facts directly from the immutable Session header and those durable user-rpc sources; the reading is not a second machine authority.

An entering non-empty batch records its downstream messages followed by exactly one time-context `UserMessage` after `step/start`. Its source is the exact snapshot marker `{ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: <same rendered text> }] }`; the invariant companion and Schedule consumer both fail closed if that shape or text equality drifts. The Session header and original user-rpc sources remain the only machine-readable zone owners. A decision rewritten to empty never gains a reading: it opens no initial step, and an empty tool continuation may still enter a later step using existing history.

Reject, cancellation, and listener failure before `step/start` add no reading. A plugin disposal that wins while the listener awaits downstream work also prevents the in-flight listener from contributing. Steering inserted after AgentLoop has claimed the current batch retains ordinary next-step ownership and receives fresh context when that later step enters; time-context adds no inbox state or AgentLoop lifecycle path.

Positive-interval scheduling scans the raw durable session events for the latest `user/message` with that source, including a reading shadowed by compaction. The schedule therefore applies across turns and resumed processes without process-local cache state. It reduces append frequency and history growth but never removes an existing reading, and sessions schedule independently.

Step 1 measures from the latest durable model-visible message before the current proposal; the prompt entering that same step has not been appended yet. Later steps measure from the preceding time-context event in the same turn. Both baselines use durable session-event timestamps; backward wall-clock movement clamps elapsed time to zero. A missing first-step baseline, or a later step with no earlier same-turn reading because interval suppression skipped it, reports `unavailable`.

A time reading records an entered request step, not a completed or successfully transmitted request. A later request-preparation failure can therefore leave the reading in history, while a failure before `step/start` cannot.

The separately published `./invariant` companion checks the simple plugin source, open turn and step, elapsed baseline, and durable event time. It also re-derives Session and client zones from the Session header and current turn's original user-rpc messages, so duplicated source authority or mismatched rendered policy fails. The rendered timestamp must parse and cannot postdate the event; process suspension between sampling and append does not invalidate the reading.

The time reading stays in derived conversation history until a later compaction shadows it. Request headers contain no time-context state. Request reconstruction uses the complete durable surface prefix after each `step/start`, so transmitted requests need not map one-to-one to readings: request preparation can fail after step entry, while an empty continuation or interval suppression can let a request reuse existing history without adding one.

## Model Experience

### Preparation-time temporal context

#### What the model sees

On each non-empty entered batch that injects, one source-tagged context message contains the four lines below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; durations use compact whole-second units. The Session line reports the immutable Session zone or `unavailable`, and the client line reports one resolved zone, a sorted mixed set, or `missing`. An empty continuation or positive interval can let an entered step reuse prior history without a new reading.

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

Each injected four-line message accumulates until compaction shadows it. A positive interval reduces additions; omission or `0` adds one for every non-empty entered request batch.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Whole-second display** — timestamps and durations omit sub-second precision even though durable event times retain milliseconds.
- **Session-event baseline** — elapsed time starts from durable append timestamps, not a client transport's original send timestamp.
- **Headerless fallback zone** — a Session without `SessionHeader.timeZone` renders through the configured or process fallback but reports its Session zone as `unavailable`; consumers that require unambiguous local-time interpretation must request an explicit zone.
- **Immutable Session zone** — a Session zone does not change when another browser resumes it. The request-bound browser sources expose disagreement instead of silently changing the displayed default.
- **History cost between compactions** — omission or `0` retains one reading for every non-empty entered request batch, including batches whose later request preparation fails; empty continuations reuse prior history, while a positive interval reduces but does not eliminate this cost.
