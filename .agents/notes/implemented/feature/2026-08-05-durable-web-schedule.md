# Agent Note: Durable Session-local reminders

Status: implemented

English | [中文](2026-08-05-durable-web-schedule.zh.md)

## Problem

A reminder created inside a conversation must remain attributable to that exact Session and survive a process restart. A process-local timer or inbox item cannot provide that durability, while a global scheduler or private database introduces a second identity, persistence, and lifecycle system.

Busy Agents, long waits, wall-clock changes, cold Sessions, forks, persistence failures, absolute calendar input, and teardown make a simple timeout insufficient. The design must distinguish a durable record from its disposable live wait, keep a fork from inheriting its parent's active reminders, and avoid spreading Schedule-specific presentation or time-zone state across unrelated components.

## Decision

The [`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay explicitly loads `@deepseek-ai/dsh-time-context` and `@deepseek-ai/dsh-tool-schedule`; the default Web tree remains unchanged. Schedule observes only root Agents published after the plugin loads and installs its three tools plus one disposable owner in that Agent scope. Cold history reads, already-published roots, child Agents, and other hosts do not activate it.

The user-visible boundary is `session-local`: the original Session runs an on-time reminder only while live, does no external notification while cold, and processes an overdue reminder after it becomes live again. Due work waits until the Agent is fully idle, then enters the ordinary next-turn queue through `followup()`; it never steers the current turn and has no independent Web receipt ([conversational delivery](../simplification/2026-08-09-conversational-schedule-delivery.md)).

| Scenario | Durable fact | Live behavior | User-visible result |
| --- | --- | --- | --- |
| Create and manage | `schedule/change` create/delete in the original Session | Agent-scoped tools checkpoint before reads and after mutations | Stable id, UTC target, state, and `session-local` disclosure |
| Due while busy | Active create remains in the fold | Owner waits for idle maintenance, queues one follow-up, then appends dispatch | A later ordinary conversation turn |
| Process stopped or Session cold | Active create remains persisted | No timer or background scan; resume rebuilds the owner | Future target waits; overdue target is attempted |
| Fork | Parent events remain in the inherited prefix | Child fold starts at `seedLength` | Parent work does not become active in the child |

### Session-log authority and tools

The version-1 `schedule/change` stream is the only durable Schedule authority. A create record owns a Session-local, non-reused branded id, the trimmed prompt, its rule discriminator, and UTC target. Delete and one-shot dispatch are terminal transitions. The strict decoder and pure fold reject unknown versions, extra fields, reused ids, and transitions against inactive records. A normal Session folds its complete stream; a fork folds only events at or after `SessionHeader.seedLength`.

The current rule union accepts a non-empty prompt and exactly one selector. `after_seconds` is a positive safe-integer delay whose record is `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`. `at` is either strict RFC 3339 with `Z` or a numeric offset, or structured `{ date, time, time_zone }` with an explicit zone; its record is `{ id, kind: 'at', prompt, scheduledAt }`. Dispatch stores only the id because the active record fixes the occurrence. Tool values derive `scheduled` or `overdue` and include `deliveryMode: 'session-local'`.

An Agent-scoped FIFO serializes management transactions and the live owner's due transaction from preflight through post-append barriers. Every tool read first awaits `ctx.sessions.flush(session)`. Create rejects input-shape failures before the FIFO when possible, preflights, allocates an id, appends, and checkpoints again. Delete validates its id before the FIFO, preflights before deciding whether it is active, and checkpoints again only after append. List and not-found delete never answer from an unconfirmed live suffix. Failed barriers return `persistence_uncertain` rather than guessing whether an eager write committed.

Every successful management preflight asks the live owner to recompute. A later list can therefore confirm a retained create after a previous post-append rejection and arm it without a private persistence-retry timer.

### Explicit absolute-time boundary

Natural-language interpretation and Schedule parsing are deliberately separate ([time-zone simplification](../simplification/2026-08-09-explicit-schedule-time-zone.md)). Each browser prompt carries its Host-validated IANA zone only on that durable user message. Time-context tells the model to assume that zone for otherwise-unqualified dates and times. Schedule neither imports that plugin nor stores a Session zone: the model must turn its interpretation into an offset-bearing RFC 3339 value or a local object with explicit `time_zone`.

Schedule validates exact calendar shapes, offsets, zone names, and a strictly future four-digit-year instant. A local time inside a daylight-saving gap is rejected; an overlap chooses its first, earlier instant. A successful create stores only canonical UTC `scheduledAt`, not the original offset, local fields, or zone.

### Live delivery lifecycle

The Agent-scoped owner derives its earliest target from the durable fold. Long targets use bounded timer segments, and every wake reads the wall clock again, so a rollback cannot fire early and a forward jump becomes overdue. If a turn or maintenance task owns the Agent, `runMaintenance()` rejects the claim; the record stays active and one `whenIdle()` wait triggers another attempt. A rejected preflight or contained framing/enqueue failure also leaves it active without starting a private retry timer.

The accepted path clears pending persistence and claims the true idle phase. It refolds the exact Session suffix, samples the decision clock, constructs fixed reminder framing with JSON-escaped id and prompt, synchronously queues one `followup()`, and appends id-only dispatch before releasing maintenance. Waking input remains parked until release, so the message cannot be claimed before dispatch enters the log; afterward the owner checkpoints dispatch.

Dispatch records queue admission, not model completion or user receipt. Framing or synchronous enqueue failure appends no dispatch. An append failure faults that owner because the message may already be queued. Agent or plugin disposal cancels timers, stops new work, unwinds tool registrations, and awaits in-flight work without deleting durable records. A crash after follow-up admission but before durable dispatch can repeat the reminder after recovery; the design makes no exactly-once promise.

## Alternatives considered

**Use `ctx.tasks`.** Tasks own process-local work, outcomes, and notifications rather than Session-log state and conversation follow-ups.

**Store reminders in a private database or global scheduler.** This could run cold Sessions but requires a second identity map, startup scan, ownership lease, crash protocol, and notification policy.

**Persist a Session time zone and infer local `at`.** This spreads one interpretive default through Session core, Host create/fork, persistence formats, clients, and mismatch recovery. Request-local model guidance plus an explicit tool boundary deletes that coupling.

**Keep an independent durable Web receipt.** Dispatch is an internal queue fact, not the user's reminder. Rendering the ordinary assistant answer avoids a second delivery meaning and removes Schedule code from Host and client layers.

**Claim dispatch before `followup()` or add exactly-once fencing.** Claim-first can silently lose a reminder when enqueue fails. Cross-process exactly-once needs a lease, outbox, acknowledgement, and downstream idempotency boundary outside this Session-local scope.

**Adopt existing roots or register global tools.** Late adoption makes plugin load order activate unseen timers and exposes tools outside the supported root composition.

## Verification

Package tests pin strict replay, transitions, fork suffixes, id reuse, offset and local-calendar profiles, IANA validation, daylight-saving gaps and overlaps, time bounds, timer segmentation, wall-clock movement, overdue admission, fixed framing, enqueue and append failures, barrier recovery, registration rollback, and quiescent disposal at per-file 100% coverage. A production JSONL restart test proves one overdue reminder dispatches through the real Agent lifecycle and does not redispatch after another restart. Host/client tests pin browser-zone sampling and prompt-bound validation. The keyless assembled Web scenario drives a real browser prompt through time-context, a model `schedule_create` call with explicit `time_zone`, durable dispatch, and an ordinary assistant follow-up with no receipt UI.

## Consequences

- Reminder state survives restart through ordinary Session persistence without a new database or public service.
- Cold Sessions do no work and send no external notification; reopening one may deliver overdue work.
- Absolute input is deterministic without persistent Session-zone state or a dependency from Schedule to time-context.
- Users see normal conversation output; dispatch never overstates model success or acknowledgement.
- Each live root adds only fold-derived timers, an optional idle wait, and one in-flight operation.
- Recurrence requires explicit transition, catch-up, and model-budget semantics rather than dormant fields; cron remains outside this product boundary.
