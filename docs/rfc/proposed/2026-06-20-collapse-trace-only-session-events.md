# RFC: Collapse trace-only session events

Status: proposed

## Problem

The session event vocabulary includes first-class events that are not part of replayable conversation history and have little or no production consumption. `usage` is already present as a model stream chunk before the loop also appends a separate `usage` event. `error` duplicates the `turn/end { kind: 'error', message, code }` reason for loop failures; ACP settlement reads the turn-end reason, ACP rendering ignores the `error` event, and `deriveMessages()` skips it.

These events make the canonical transcript look more useful as telemetry than it currently is. They add event variants, invariants, tests, snapshots, and persistence cases, but they are not load-bearing for resume. The implemented [turn enclosure](../implemented/2026-06-15-turn-enclosure-invariant.md) already says post-turn operational diagnostics do not belong in the replayable session log.

## Proposal

Remove trace-only events from the canonical session log unless a production consumer needs them. Model usage can be derived from retained stream chunks, attached to `assistant/message`, or emitted on a separate telemetry channel. Loop errors should be represented by `turn/end.reason` for durable transcript semantics and `agent/error` or logging for operational diagnostics. Do not keep a parallel `error` event that consumers must reconcile with the final turn reason.

If analytics become real, add a projection helper or a dedicated telemetry store with its own retention policy. The user conversation log should contain what is needed to render, resume, and audit the interaction, not every metric-shaped detail the loop happened to observe.

## Acceptance criteria

- `SessionEventMap` drops `usage` and `error`, or folds their fields into nearby load-bearing events.
- The loop no longer appends a separate `usage` event for a usage chunk.
- The loop records durable failures only as `turn/end { kind: 'error' }` and reports live diagnostics through `agent/error`.
- ACP snapshots and persistence tests stop asserting trace-only lines.
- Documentation explains where token usage and operational errors are observed if they remain available.
- The session format version and recorded fixtures are refreshed; non-current stored logs are rejected per the pre-release format policy.

## What we give up

A consumer can no longer filter the canonical log for `usage` or step-level `error` events. That is a real loss for future analytics and debugging, but there is no current production analytics consumer. Keeping a telemetry-shaped event in the replay log because it might matter later repeats the dead-summary pattern from [drop the mutable session summary](../implemented/2026-06-19-drop-mutable-session-summary.md).
