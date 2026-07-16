# @deepseek-ai/dsh-time-context

Opt-in durable context with the current zoned time and elapsed time at every model step. `dsh-agent-spine-demo` and shipped examples do not mount it. Decision record: [the durable time-context RFC](../../../docs/rfc/implemented/feature/2026-07-16-durable-per-step-time-context.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai  # optional IANA override; omit for the process zone
```

When `timeZone` is omitted, the plugin resolves the Node process's system zone once at plugin load. Node honors `TZ`; without that override, the host or container supplies the zone. An explicit `timeZone` must be an IANA identifier and is validated at plugin load.

## Timing semantics

The plugin prepends an `agent/pre-step` listener. Every non-aborted step appends one `context/message` through `agent.inject()` before `step/start` and ordinary automatic compaction, with source `{ kind: 'plugin', plugin: 'time-context' }`.

Step 1 measures from the latest preceding model-visible message, including the prompt that opened the turn. Later steps measure from the preceding time-context event. Both baselines use durable session-event timestamps; backward wall-clock movement clamps elapsed time to zero. A missing first-step baseline reports `unavailable`.

The time reading stays in derived conversation history until a later compaction shadows it. Request headers and header deltas contain no time-context state, so the durable message plus the matching `step/start` reconstruct each request's reading.

## Model Experience

### Per-step temporal context

**What the model sees**: Before each step, one source-tagged context message containing the two lines below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; durations use compact whole-second units.

**Token effect**: One two-line message accumulates per step until compaction shadows older history.

#### First step

```markdown
Time recorded before turn <turn>, step 1: <timestamp>
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

#### Later steps

```markdown
Time recorded before turn <turn>, step <step>: <timestamp>
Elapsed since the preceding step context: <duration>.
```

## Known Limitations and Deferred Work

- **Whole-second display** — timestamps and durations omit sub-second precision even though durable event times retain milliseconds.
- **Session-event baseline** — elapsed time starts from durable append timestamps, not a client transport's original send timestamp.
- **Process-local default zone** — omission uses the Node process's `TZ`, host, or container zone captured at plugin load, not a remote user's zone; configure an explicit IANA zone when those differ.
- **History cost between compactions** — one reading remains model-visible for every unshadowed step so prior timing claims stay historically truthful.
