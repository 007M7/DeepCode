# @deepseek-ai/dsh-time-context

Opt-in dynamic system-prompt context with the current zoned time and elapsed time since the latest model-visible message before the turn. `dsh-agent-spine-demo` and shipped examples do not mount it. Decision record: [the time-context RFC](../../../docs/rfc/implemented/feature/2026-07-14-time-context-plugin.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: Asia/Shanghai   # optional IANA override; omit for the process zone
    refreshIntervalMs: 60000  # default; 0 refreshes on every step
```

When `timeZone` is omitted, the plugin resolves the Node process's system zone once at plugin load. Node honors `TZ`; without that override, the host or container supplies the zone. An explicit `timeZone` must be an IANA identifier and is validated at plugin load. `refreshIntervalMs` must be a non-negative safe integer. Every turn's first request refreshes; later steps reuse the reading until its age reaches the interval. `0` refreshes every step. Refresh occurs only during request assembly and creates no timer work.

## Message baseline

The duration starts at the latest user, assistant, tool-result, context, or steering message before the current `turn/start`. Every refresh in the turn retains that baseline, so the current prompt does not collapse the interval to approximately zero. The first turn reports that no earlier message exists. The durable clock source is session-event append time, not client send time.

The loop records the dynamic section in `request/header` / `request/header-delta`. Requests therefore remain reconstructable, carry one timing block, and retain no earlier readings in conversation history.

## Model Experience

### Temporal system prompt

**What the model sees**: Every request in an active turn includes the two lines below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; `<duration-or-unavailable>` is compact whole-second units or the first-turn fallback.

**Token effect**: Fixed two-line cost per request. A refresh replaces the request-header section; prior readings do not accumulate.

#### Temporal context section

```markdown
Current time: <timestamp>
Time since previous message: <duration-or-unavailable>.
```

## Known Limitations and Deferred Work

- **Request-bound refresh only** — no clock update is emitted while the agent is waiting inside a model call or tool; the next assembled step refreshes once the configured interval has elapsed.
- **Whole-second display** — timestamps and durations omit sub-second precision even when `refreshIntervalMs` is below 1,000.
- **Session-event baseline** — elapsed time starts from the durable append timestamp, not a client transport's original send timestamp.
- **Process-local default zone** — omission uses the Node process's `TZ`, host, or container zone captured at plugin load, not a remote user's zone; configure an explicit IANA zone when those differ.
