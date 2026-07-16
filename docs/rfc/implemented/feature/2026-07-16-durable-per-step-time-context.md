# RFC: Durable per-step time context

Status: implemented

English | [中文](2026-07-16-durable-per-step-time-context.zh.md)

## Problem

A request-only clock can tell the model the current time, but replacing that value in the system prompt removes the evidence behind earlier time-sensitive reasoning. Multi-step turns need each request to see its own reading and the readings that shaped preceding steps. The request must remain reconstructable after restart, and automatic compaction must account for the same timing context the model receives.

Refresh intervals make the displayed time depend on process-local cache state rather than the durable session. They also let multiple steps share a reading even though each step is a distinct model request.

## Decision

`@deepseek-ai/dsh-time-context` is an opt-in function plugin in `packages/context/time-context/`. It registers a prepended `agent/pre-step` listener and calls `agent.inject()` once for every step whose signal is not already aborted. The injected `context/message` carries source `{ kind: 'plugin', plugin: 'time-context' }` and append surface metadata.

The listener records context before the matching `step/start`. Its prepended registration runs before ordinary automatic compaction listeners, so pressure estimation and any resulting surface rewrite observe the pending step's time context. The message then enters the history snapshot used by that step.

The plugin has one optional config key, `timeZone`. An omitted value resolves the Node process's IANA zone once at plugin load; an explicit value is validated by `Intl.DateTimeFormat`. The timestamp includes the numeric UTC offset and resolved IANA zone. There is no refresh interval or timer because every step records a reading.

### Text and elapsed baselines

The first step in a turn receives:

```text
Time recorded before turn <turn>, step 1: <timestamp>
Elapsed since the preceding model-visible message: <duration-or-unavailable>.
```

The baseline is the latest preceding user, assistant, tool-result, context, or steering message. This includes the accepted prompt that opened an ordinary message turn. If no model-visible message exists, the duration is `unavailable`.

Later steps receive:

```text
Time recorded before turn <turn>, step <step>: <timestamp>
Elapsed since the preceding step context: <duration>.
```

Their baseline is the durable event timestamp of the preceding time-context message in the same turn. Duration formatting uses compact whole-second units and clamps backward wall-clock movement to zero. The explicit turn and step make every retained reading historically attributable after later turns append more context.

### Durability and request reconstruction

Each reading remains a normal surface node until compaction shadows it. A later request therefore sees the cumulative unshadowed readings that affected earlier steps, rather than a system-prompt value rewritten in place.

The plugin contributes nothing to system-prompt assembly. `request/header` and `request/header-delta` contain no time-context text; request reconstruction obtains the reading from the durable surface prefix at the matching `step/start`. The plugin depends on the agent registry for its lifecycle listener and does not require the system-prompt service at runtime.

## Testing

Unit and real-loop tests pin formatting, both elapsed baselines, backward-clock clamping, time-zone validation, aborted-signal behavior, listener disposal, source and surface metadata, ordering before `step/start` and ordinary pre-step listeners, exactly one event per transmitted request, cumulative multi-step visibility, and absence from request headers. A keyless subprocess e2e boots the real Loader and stdio app, drives two turns, and verifies the persisted context events externally.

## Supersedes

This decision supersedes the dynamic system-prompt storage and refresh policy in [Optional time-context plugin](2026-07-14-time-context-plugin.md). It keeps the package location, opt-in deployment stance, timestamp formatting, process-zone default, and load-time validation. Durable per-step history replaces the `context:time` prompt section, refresh cache, `refreshIntervalMs`, and request-header deltas.

## Alternatives considered

- **Keep the dynamic system-prompt section and refresh cache** — rejected because replacement erases earlier readings, cache state is not replayable, and a frozen request envelope would make the value stale for an entire loop instance.
- **Replace the preceding context surface node** — rejected because replacement preserves the old node's position or shadows intervening conversation; neither represents when the new reading became visible.
- **Inject from a background timer** — rejected because idle time has no pending request to consume the value, and timer-driven injection would create durable turns solely to report time passing.
- **Expose time only through a tool** — rejected because ordinary temporal reasoning would require an avoidable tool round trip and would not guarantee a reading before every step.
- **Use `agent/session-prefix`** — rejected because one loop-instance prefix cannot represent distinct step timestamps and does not accumulate historically attributable readings.

## Consequences

- Every opted-in model request receives a fresh, reconstructable time reading before the step opens.
- Timing context grows by one two-line message per step until compaction shadows older surface nodes; historical truth costs more tokens than a replace-in-place system section.
- The first-step duration normally measures from the prompt that opened the turn, while later-step durations measure model and tool processing since the preceding step context.
- An omitted `timeZone` still reflects the deployment process rather than a remote user, and elapsed time still uses durable harness append boundaries rather than client-origin timestamps.
