# Agent Note: Durable Session-local reminders

Status: implemented

English | [中文](2026-08-05-durable-web-schedule.zh.md)

## Problem

A reminder created inside a conversation must remain attributable to that exact Session and survive a process restart. A process-local timer or inbox item cannot provide that durability, while a global scheduler or private database introduces a second identity, persistence, and lifecycle system.

Busy Agents, long waits, wall-clock changes, cold Sessions, forks, persistence failures, and teardown make a simple timeout insufficient. The design must distinguish a durable record from its disposable live wait and keep a fork from inheriting its parent's active reminders.

## Decision

The [`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay explicitly loads `@deepseek-ai/dsh-tool-schedule`; the default Web tree remains unchanged. Schedule observes only root Agents published after the plugin loads and installs its three tools plus one disposable owner in that Agent scope. Cold history reads, already-published roots, child Agents, and other hosts do not activate it.

The user-visible boundary is `session-local`: the original Session runs an on-time reminder only while it is live, does no external notification while cold, and processes an overdue reminder after that Session becomes live again. Due work waits until the Agent is fully idle, then enters the ordinary next-turn queue through `followup()`; it never steers the current turn. The separate Web receipt portion of the original design is superseded by [conversational Schedule delivery](../simplification/2026-08-09-conversational-schedule-delivery.md).

| Scenario | Durable fact | Live behavior | User-visible result |
| --- | --- | --- | --- |
| Create and manage | `schedule/change` create/delete events in the original Session | Agent-scoped tools checkpoint before reading and after mutations | Stable id, UTC target, `scheduled`/`overdue`, and `session-local` disclosure |
| Due while busy | Active create remains in the fold | Owner waits for `whenIdle()`, claims idle maintenance, queues one follow-up, then appends dispatch | A later ordinary conversation turn |
| Process stopped or Session cold | Active create remains in persistence | No timer or background scan exists; resume rebuilds the owner | Future target waits again; overdue target is attempted once |
| Fork | Parent events remain in the inherited prefix | Child fold starts at `seedLength` | No parent reminder becomes active child work |

### Session log authority and tools

The version-1 `schedule/change` stream is the only durable Schedule authority. A create record owns a Session-local, non-reused branded id, the trimmed user prompt, the rule, and its UTC target. Delete and dispatch are terminal transitions. The strict decoder and pure fold reject unknown versions, extra fields, reused ids, and transitions against inactive records. A normal Session folds its complete stream; a fork folds only events at or after `SessionHeader.seedLength`.

The current rule accepts a non-empty prompt and exactly one positive safe-integer `after_seconds`. Its record is `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`; dispatch stores only the id because the record already fixes its occurrence. `at`, `every_seconds`, `cron`, and `time_zone` are rejected rather than hidden in unused fields. Tool values derive `scheduled` or `overdue` and always include `deliveryMode: 'session-local'`.

An Agent-scoped FIFO serializes each accepted management transaction and the live owner's due transaction from preflight through any post-append barrier. Every tool operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create may reject input-shape failures before entering the FIFO; after a successful preflight it allocates an id, appends create, and waits for a second barrier. Delete validates its id before the FIFO, then preflights before deciding whether an id is active and waits for a second barrier only when it appends. List and unknown or finished delete never answer from an unconfirmed live suffix or observe a dispatch before their own barrier. A failed barrier returns `persistence_uncertain` rather than guessing whether an eager write committed.

Every successful management preflight also asks the live owner to recompute. This closes the recovery path where create appended successfully but its post-append barrier rejected: a later list can confirm the retained batch, return the active record, and arm its timer without a Schedule-specific retry loop.

### Live delivery lifecycle

The Agent-scoped owner derives its earliest target from the durable fold. Long targets use bounded timer segments, and every wake reads the wall clock again, so a rollback cannot fire early and a forward jump becomes overdue. If a turn or another maintenance task already owns the Agent, `runMaintenance()` rejects the claim; the record stays active and one `whenIdle()` wait triggers a later retry. A rejected persistence preflight or contained framing or synchronous-enqueue failure also leaves the record active, but no private retry timer runs; later Agent activity reaching idle or a successful Schedule management preflight asks the owner to try again.

The accepted path first clears pending persistence and claims the idle phase through `runMaintenance()`. Inside that task it refolds the exact Session suffix, samples the decision clock once, constructs the complete fixed reminder frame with JSON-escaped id and prompt, synchronously queues one `followup()`, and appends the id-only dispatch. Waking input remains parked until maintenance settles, so the driver cannot claim the message before dispatch enters the log; only after the task releases the phase does the owner wait for the dispatch barrier.

Dispatch records queue admission, not model completion or user receipt. A framing or synchronous enqueue failure appends no dispatch. An append failure faults that owner because the message may already be queued. A later prompt-admission, request-checkpoint, or model failure cannot retract a dispatch. Agent or plugin disposal cancels timers, stops new work, unwinds the three tool registrations, and waits for in-flight preflights or idle waits without deleting durable records.

## Alternatives considered

**Use `ctx.tasks`.** Tasks own process-local work, terminal outcomes, collection, and notifications rather than Session-log state and conversation follow-ups. Reusing them would make the wrong lifecycle authoritative.

**Store reminders in a private SQLite table or global scheduler.** This could run cold Sessions, but requires a second Session identity map, startup scan, ownership lease, crash protocol, and notification policy. The accepted scope deliberately runs only while the original Session is live.

**Claim dispatch before `followup()` or add exactly-once fencing.** A claim-first record can silently lose the user-visible reminder when enqueue fails. Cross-process exactly-once requires a lease, outbox, acknowledgement, and downstream idempotency boundary that Session-local best-effort model work does not provide.

**Adopt existing roots or register global tools.** Late adoption makes plugin load order change which unseen timers begin running and exposes tools outside the supported root-Agent composition. Future-root, Agent-scoped installation gives one clear lifecycle.

The design does not recognize or migrate any unmerged Schedule implementation or private storage format. No fixed Session id, claim-before-send record, startup miss, or private database is a compatibility input.

## Verification

Package tests pin strict decoding, transitions, fork suffixes, id reuse, time bounds, bounded waits, wall-clock movement, overdue admission, fixed framing, enqueue and append failures, barrier recovery, registration rollback, and quiescent disposal. A production-JSONL restart test resumes one overdue record through the real Agent lifecycle and proves that a later restart does not dispatch it again. The opt-in Loader composition boots the package, and a keyless browser scenario executes `schedule_create` through the complete tool pipeline and snapshots the ordinary assistant follow-up.

## Consequences

- Reminder state survives process restart and replays through ordinary Session persistence without a new database or public service.
- A cold Session does no work and sends no external notification; reopening it may deliver an overdue reminder.
- Each live root adds only fold-derived timers, an optional idle wait, and one in-flight operation.
- The narrow crash interval after synchronous follow-up admission and before durable dispatch can repeat the reminder after recovery; the design prefers a visible duplicate over silent loss and makes no exactly-once promise.
- The strict after-only protocol is intentionally small; other rule families require explicit record, time, and recurrence semantics rather than dormant fields.
