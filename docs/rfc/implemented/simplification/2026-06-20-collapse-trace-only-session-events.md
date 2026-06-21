# RFC: Fold trace-only session facts into load-bearing events

Status: implemented (proposed and accepted 2026-06-20)

## Problem

The session event vocabulary includes first-class events that are not part of replayable conversation history and have little or no production consumption. `usage` is already present as a model stream chunk before the loop also appends a separate `usage` event. `error` duplicates the `turn/end { kind: 'error', message, code }` reason for loop failures; ACP settlement reads the turn-end reason, ACP rendering ignores the `error` event, and `deriveMessages()` skips it.

These events make the canonical transcript look more useful as telemetry than it currently is. They add event variants, invariants, tests, snapshots, and persistence cases, but they are not load-bearing as separate records. The facts they carry can still be useful: token usage should remain available for accounting, and an error's step number should not silently disappear. The simplification is to fold those facts into nearby events consumers already must understand, not to record less information.

## Proposal

Remove standalone trace-only events only where their information can be preserved without a parallel record:

- Fold successful-step usage into the matching `assistant/message`, e.g. `assistant/message { turn, step, content, usage? }`, so the assembled model output and its accounting travel together.
- For a failed or aborted step that has usage but no `assistant/message`, carry the usage on the terminal turn reason or another load-bearing failure record in the same turn. The implementing design must prove no usage chunk that is currently persisted becomes unrepresented.
- Fold the step number from the standalone `error` event into `turn/end.reason` for `kind: 'error'`, e.g. `{ kind: 'error', step, message, code? }`. `turn/end` is the durable turn outcome ACP and resume already consume.
- Keep `agent/error` and logging for live diagnostics; do not add a second session-log error record after `turn/end`.

If analytics become real, add a projection helper or a dedicated telemetry store with its own retention policy. The user conversation log should contain what is needed to render, resume, audit, and account for the interaction without requiring consumers to reconcile duplicate trace rows.

## Acceptance criteria

- `SessionEventMap` drops standalone `usage` and `error` only after their fields are represented on load-bearing session events.
- The loop no longer appends a separate `usage` event for a usage chunk.
- The loop records durable failures through `turn/end { kind: 'error', step, message, code? }` or an equivalent no-information-loss shape and reports live diagnostics through `agent/error`.
- ACP snapshots and persistence tests stop asserting trace-only lines.
- Documentation explains exactly where token usage and operational errors are observed.
- The session format version and recorded fixtures are refreshed; non-current stored logs are rejected per the pre-release format policy.

## What we give up

A consumer can no longer filter the canonical log for standalone `usage` or step-level `error` rows. It must read those facts from the assistant/failure events that carry them. That is a reasonable simplification only if the implementing PR proves the same facts remain present; otherwise the standalone events should stay.

## Implementation note

Shipped as proposed, with two scope refinements (per AGENTS.md "RFCs are proposals, not golden truth"):

- **No format-version bump.** The acceptance criterion "the session format version and recorded fixtures are refreshed" over-reached: the harness is pre-release with no persisted user data, so per the pre-release format policy there is nothing to migrate or reject. The session `version` stays `1`; only event shapes and recorded fixtures change. `turn/end.reason.error.step` is therefore optional-on-read for any hypothetical pre-existing log but guaranteed for newly-written ones — no migration shim.
- **Empty-content `assistant/message` hosts usage with no data loss.** The proof the proposal demanded (no persisted usage chunk becomes unrepresented) lands on the max-tokens path: a step cut off with usage but empty content (e.g. only a dropped tool call) previously emitted a standalone `usage`. It now records an empty-content `assistant/message { content: [], usage }`. To keep that from injecting a spurious content-less assistant turn into the provider transcript, `deriveMessages()` skips empty-content `assistant/message` events. A regression test asserts usage stays represented AND derived history is uncorrupted.

Usage is now observed on `assistant/message.usage`; an operational error's step on `turn/end.reason` for `kind: 'error'`. `agent/error` + logging are unchanged for live diagnostics.
