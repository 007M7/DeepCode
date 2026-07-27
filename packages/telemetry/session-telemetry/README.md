# @deepseek-ai/dsh-session-telemetry

English | [中文](README.zh.md)

The telemetry seam: the CAPTURE side of session-event reporting, behind a backend contract any reporting SDK satisfies with zero bending. The boundary axiom that shapes everything here: **this package's aspect ends at `emit()`** — batching, retry, queueing, and loss policy belong to the backend's SDK and are neither specified nor wrapped. Rationale and rejected alternatives: [the revival Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md).

## The backend contract

`TelemetryBackend` is three members: `emit(record)` (MUST be a non-blocking enqueue — it runs synchronously on the `session/event` hot path), optional `flush()` (a turn-boundary hint, fire-and-forget; most backends leave it unimplemented and let their SDK's batching cadence govern export timing — an implementer owns the interaction between concurrent flushes and `shutdown()`'s drain), and `shutdown()` (the lifecycle forward: drain-and-quiesce, awaited at dispose). `Telemetry` is its service-registered form under the `telemetry` context key — one implementation per context, duplicate load throws. A backend composes `TelemetryCoordinator` in its constructor.

## Capture points

The coordinator registers, all through the composing fiber's effects: `session/created` (adopt: record the header, read the log back through the projection from the construction boundary — constructor seeds from fork/resume never re-emit on the firehose and never re-export), `session/event` (project, deep-copy, redact, hand off; zero I/O), `session/flush` (forward the optional `flush()` hint and return void — the loop's awaited parallel must never wait on telemetry), `session/disposed` (emit the session's `shutdown` operational record at its own termination edge — where receivers key crash detection — then retire it, so a long-lived backend neither retains closed sessions nor re-marks them at unload), `agent/error` (the one live-bus relay; turn-enclosure structurally bars those errors from the log), a dispose effect (mark each session still alive at teardown, then await the backend's `shutdown()`; failures warn instead of throwing), and an adoption sweep of `ctx.sessions.list()` (a hot reload does not replay `session/created`).

## The redact waterfall

Every record passes the `telemetry/record` waterfall between projection and `emit()` — the seam's scrubbing extension point. The seam ships NO rules of its own: the innermost `next()` passes the record through unchanged, so with no listener mounted records reach the backend exactly as captured, and exported data is precisely as clean as the rules a deployment mounts. Listeners stack by transforming `next()`'s return value; returning without `next()` replaces everything beneath, and a throwing listener withholds that one record fail-closed inside the coordinator's containment. Redaction applies to the exported copy only; the canonical session log is never rewritten.

## The handoff cursor

A module-scope `WeakMap<Session, seq>` marks the highest seq HANDED OFF (not delivered) per session, advanced at emit time. It survives reloads that do not re-evaluate this module — config re-applies and backend source reloads, which is where iteration happens; that asymmetry is why the cursor lives in the seam. On re-adoption the coordinator re-hands only events past the cursor (events at or below it still rebuild the chunk-projection state); a missing cursor safely degrades to a re-hand from the session's construction boundary (`Session.firstLiveSeq` — seq 0 for a session born in this process), absorbed by receiver-side dedupe on `(session.id, event.seq)`. Constructor seeds never re-export: a resumed session's history shipped from the previous process under the same id, and a fork's inherited prefix lives in the parent's stream (receivers stitch on `session.parent_id` + `session.seed_length`). The accepted cost, consistent with at-most-once delivery: a resume does not backfill records a previous process failed to deliver — a deployment with a backfill requirement needs the deferred outbox, not replay. This is a deliberate, narrow exception to the registrations-are-effects discipline: entries die with their sessions, the value is a monotonic watermark, and losing it is never an error.

## The fixed chunk projection

Only the first `assistant/chunk` of each `(turn, step)` ships; the rest are dropped at capture and never advance the cursor. That one chunk is the stream-started signal: `step/start` + first-chunk presence + `assistant/message` presence + the `turn/end` reason distinguish "the request never started" from "the stream died midway" without chunk volume, and time-to-first-token stays computable. Chunk elision makes `seq` gaps routine on the wire — a gap is never a loss signal. Every other event type, including ones merged by plugins this package never heard of, passes through whole.

## The logical record

`TelemetryRecord`: `channel` (`ledger` | `ops`), `time` (epoch ms), `severity` (pre-mapped: ERROR for `tool/result.isError` and `turn/end` error reasons; WARN for `prompt/blocked`; INFO otherwise, including plugin-merged event types whose outcome semantics stay with their owners), identity-only `attributes` (`session.id`, `event.type`, `event.seq`, plus `session.cwd`/`session.parent_id`/`session.seed_length` when the header has them), and the complete deep-copied `event.data` as `body` — post-redaction. Operational records carry `telemetry.op` (`agent-error` | `shutdown`) and `session.id`, and deliberately NO `event.seq`/`event.type` — signals to alert on, not entries to sum. Delivery downstream of the handoff is the backend SDK's; duplicates remain possible (cursor-less re-adoption, SDK retries), so receivers dedupe on `(session.id, event.seq)`.

## Model Experience

None, as the seam only observes the session stream and hands redacted copies to a reporting backend; it never contributes to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Best-effort delivery** — the cursor marks handed-off, not delivered; a session torn down inside a reload window cannot be re-adopted; whatever sits in a backend queue at crash time is lost. A durable outbox (spool, per-sink cursors, at-least-once) is deferred until a deployment states a crash-loss requirement — see [the revival Agent Note](../../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md).
- **No built-in redaction rules** — with no `telemetry/record` listener mounted, records leave the process exactly as captured, including any credentials embedded in file contents or command output; a deployment exporting to a shared collector owns its rule set.
