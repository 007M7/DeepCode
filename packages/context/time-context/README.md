# @deepseek-ai/dsh-time-context

Optional temporal request context. The plugin contributes one dynamic system-prompt section with the current zoned time and the elapsed duration since the last model-visible message before the current turn. It is not mounted by `dsh-agent-core` or any shipped example; deployments opt in explicitly. Decision record: [the time-context RFC](../../../docs/rfc/implemented/feature/2026-07-14-time-context-plugin.md).

## Config

```yaml
- id: time-context
  name: '@deepseek-ai/dsh-time-context'
  config:
    timeZone: UTC              # default; any IANA time-zone identifier
    refreshIntervalMs: 60000  # default; 0 refreshes on every step
```

`timeZone` is validated at plugin load. `refreshIntervalMs` must be a non-negative safe integer and is evaluated only when a request is assembled: every turn's first request gets a fresh reading, and a later step in the same turn reuses that reading until it is at least this old. Thus `0` means per-step refresh, while a positive value bounds staleness at request boundaries without creating timer-driven turns.

## Message baseline

The duration starts at the latest model-visible session event before the current `turn/start`: a user, assistant, tool-result, context, or steering message. All later refreshes in that turn retain the same baseline, so the value measures elapsed time since the preceding conversation message rather than collapsing to approximately zero after the current prompt is appended. The first turn reports that no earlier message exists. Session event append time is the durable clock source; client-side send time is not part of the session contract.

The plugin uses a dynamic system-prompt section rather than retained `context/message` history. The loop records the exact rendered value in `request/header` / `request/header-delta`, so requests remain reconstructable while the current request carries only one timing block.

## Model Experience

### Temporal system prompt

**What the model sees**: Every request in an active turn includes the two-line section below. `<timestamp>` is an ISO-shaped local timestamp with numeric offset and IANA zone; `<duration-or-unavailable>` is compact whole-second units or the first-turn fallback.

**Token effect**: Fixed two-line request context. A refresh replaces the section in the request header rather than retaining prior readings in conversation history.

#### Temporal context section

```markdown
Current time: <timestamp>
Time since previous message: <duration-or-unavailable>.
```

## Known Limitations and Deferred Work

- **Request-bound refresh only** — no clock update is emitted while the agent is waiting inside a model call or tool; the next assembled step refreshes once the configured interval has elapsed.
- **Whole-second display** — timestamps and durations omit sub-second precision even when `refreshIntervalMs` is below 1,000.
- **Session-event baseline** — elapsed time starts from the durable append timestamp, not a client transport's original send timestamp.
