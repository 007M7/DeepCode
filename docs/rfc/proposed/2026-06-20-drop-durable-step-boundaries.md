# RFC: Drop durable step boundary events

Status: proposed

## Problem

The session log stores `step/start` and `step/end` events even though every step-scoped event already carries `{ turn, step }`: assistant chunks, assistant messages, tool calls, tool results, usage, and errors. `deriveMessages()` ignores step boundaries, ACP ignores them for UI, and the main consumers are invariants, tests, snapshot goldens, and crash repair.

The boundary events make the log more ceremonial than informative. The loop tracks open steps solely to close them, repair synthesizes `step/end` when a crash leaves a step open, invariants track a second nesting stack inside the turn, and snapshots carry lines that do not affect replayed message history. A model request that crashes before producing any step-scoped event is the only information represented by a bare `step/start`, and that case has no useful resumable content.

## Proposal

Make the turn the only durable boundary. Remove `step/start` and `step/end` from `SessionEventMap`; keep the numeric `step` field on events that need grouping. The loop increments the step counter and records step-scoped events with that number, but it no longer appends open/close boundary events. Consumers infer step groups from contiguous events sharing `(turn, step)`.

The invariants plugin should enforce that step-scoped events have valid positive step numbers within an open turn, not that separate boundary records surround them. Crash repair should not synthesize `step/end`; if [interrupted turns are truncated](2026-06-20-truncate-interrupted-turns.md), the repair path disappears entirely.

## Acceptance criteria

- `SessionEventMap` no longer includes `step/start` or `step/end`.
- The loop has no `closeStep()` finalization path.
- ACP snapshots and persistence contract fixtures stop expecting step-boundary lines.
- `deriveMessages()` and replay derive the same message history from step-scoped events.
- The [event taxonomy docs](../../architecture.md) describe turns as the durable boundary and steps as a field on step-scoped records.
- The session format version and recorded fixtures are refreshed; non-current stored logs are rejected per the pre-release format policy.

## What we give up

The log no longer records "a model request started but produced no event before the process died" as a durable fact. That is acceptable: there is no assistant content, tool call, usage, or error to replay from that empty request. A live UI can still show an in-progress step from a transient event if it needs one; the durable log should not store an empty bracket.
