# Agent Note: Durable Session-local Web reminders

Status: implemented

English | [中文](2026-08-05-durable-web-schedule.zh.md)

## Problem

A reminder created inside a conversation needs to survive a process restart and remain attributable to that exact Session. A process-local timer or model inbox item cannot provide that durability, while a global scheduler or private database would introduce a second identity, persistence, and lifecycle system. The user also needs a visible receipt even when the best-effort model turn later fails, without seeing a reminder whose dispatch never reached storage.

Busy Agents, long waits, wall-clock changes, cold Sessions, forks, persistence failures, and browser history races make a simple timeout insufficient. The design must distinguish a durable record from its disposable live wait, keep a fork from inheriting its parent's active reminders, and merge a presentation sidecar that can arrive after the underlying event.

## Decision

The [`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay explicitly loads `@deepseek-ai/dsh-tool-schedule` and the separate `@deepseek-ai/dsh-client-ui-schedule` renderer. The default Web tree remains unchanged. Schedule observes only root Agents published after the plugin loads and installs its three tools plus one disposable owner in that Agent scope. Cold history reads, already-published roots, child Agents, and other hosts do not activate it.

The user-visible boundary is `session-local`: the original Session runs an on-time reminder only while it is live, does no external notification while cold, and processes an overdue reminder after that Session becomes live again.

| Scenario | Durable fact | Live behavior | User-visible result |
| --- | --- | --- | --- |
| Create and manage | `schedule/change` create/delete events in the original Session | Agent-scoped tools checkpoint before reading and after mutations | Stable id, UTC target, `scheduled`/`overdue`, and `session-local` disclosure |
| Due while busy | Active create remains in the fold | Owner waits for `whenIdle()`, claims idle maintenance, queues one followup, then appends dispatch | One replayable reminder receipt; model failure does not retract it |
| Process stopped or Session cold | Active create remains in persistence | No timer or background scan exists; resume rebuilds the owner | Future target waits again; overdue target is attempted once |
| Fork | Parent events remain in the inherited prefix | Child fold starts at `seedLength` | Parent receipt may appear in history, but no parent reminder becomes active child work |

### Session log authority and tools

The version-1 `schedule/change` stream is the only durable Schedule authority. A create record owns a Session-local, non-reused branded id, the trimmed user prompt, the rule, and its UTC target. Delete and dispatch are terminal transitions. The strict decoder and pure fold reject unknown versions, extra fields, reused ids, and transitions against inactive records. A normal Session folds its complete stream; a fork folds only events at or after `SessionHeader.seedLength`.

The current rule accepts a non-empty prompt and exactly one positive safe-integer `after_seconds`. Its record is `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`; dispatch stores only the id because the record already fixes its occurrence. `at`, `every_seconds`, `cron`, and `time_zone` are rejected rather than hidden in unused fields. Tool values derive `scheduled` or `overdue` and always include `deliveryMode: 'session-local'`.

An Agent-scoped FIFO serializes each accepted management transaction and the live owner's due transaction from preflight through any post-append barrier. Every tool operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create may reject input-shape failures before entering the FIFO; after a successful preflight it allocates an id, appends create, and waits for a second barrier. Delete validates its id before the FIFO, then preflights before deciding whether the id is active and waits for a second barrier only when it appends. List and unknown or finished delete never answer from an unconfirmed live suffix or observe a dispatch before its own barrier. A failed barrier returns `persistence_uncertain` rather than guessing whether an eager write committed.

Every successful management preflight also asks the live owner to recompute. This closes the recovery path where create appended successfully but its post-append barrier rejected: a later list can confirm the coordinator's retained batch, return the active record, and arm its timer without a Schedule-specific retry loop.

### Persistence checkpoint and initialization recovery

`SessionStore.flush()` awaits every scoped listener and treats literal `true` as an explicit durability acknowledgement. An acknowledged call publishes a contained `session/flushed(session, throughSeq)` observation whose exclusive boundary was captured at call entry; append notification itself is not durability evidence. Observe-only listeners return void, an empty or observe-only checkpoint returns `false`, and any listener rejection prevents the success observation after all listeners settle.

The persistence coordinator supplies that acknowledgement only after its write path is quiescent. Its live controller retains the initial `seedEnd` scalar rather than a seed copy. If the first initialization rejects, a later flush rebuilds that immutable prefix from the append-only Session, reads the backend's actual cursor, and appends only a missing suffix. This covers failures before storage changed and failures reported after a commit, so one transient error neither permanently poisons the Session nor duplicates its prefix.

### Live delivery lifecycle

The Agent-scoped owner derives its earliest target from the durable fold. Long targets use bounded timer segments, and every wake reads the wall clock again, so a rollback cannot fire early and a forward jump becomes overdue. If a turn or another maintenance task already owns the Agent, `runMaintenance()` rejects the claim; the record stays active and one `whenIdle()` wait triggers a later retry. A rejected persistence preflight or contained framing/synchronous-enqueue failure also leaves the record active, but no private retry timer runs; later Agent activity reaching idle or a successful Schedule management preflight asks the owner to try again.

The accepted path first clears pending persistence and claims the true idle phase through `runMaintenance()`. Inside that task it refolds the exact Session suffix so a direct management mutation that won the claim race cannot be followed by a stale dispatch, samples the decision clock once, constructs the complete fixed reminder frame with JSON-escaped id and prompt, synchronously queues one `followup()`, and appends the id-only dispatch. Waking input remains parked until maintenance settles, so the driver cannot claim the message before dispatch enters the log; only after the task releases the phase does the owner wait for the dispatch barrier. A framing or synchronous enqueue failure is contained and appends no dispatch. An append failure faults that owner because the message may already be queued. A later prompt-admission, request-checkpoint, or model failure cannot retract a dispatch.

Agent or plugin disposal cancels timers, stops new work, unwinds the three tool registrations, and waits for in-flight preflights or idle waits. It never deletes durable records during teardown. The narrow crash interval after synchronous followup admission and before durable dispatch may repeat the reminder after recovery; the design prefers a visible duplicate over silent loss and makes no model-success, user-read, external-effect, or exactly-once promise.

### Commit-aware Web receipt

The Schedule package owns `scheduleReminderPresentation()`, which derives `{ scheduleId, prompt, occurrenceAt, deliveryMode }` from create plus dispatch. The current fork's `seedLength` is a hard boundary for child-owned dispatches. An inherited dispatch instead pairs with its nearest preceding same-id create because `session/end-seed` also marks replay or resume construction, not only fork ownership. This keeps resumed ancestor receipts renderable, preserves nested-generation id reuse, and never changes live ownership.

The Host continues to send every raw event on append. It keeps one monotonic watermark per exact live `Session` in a `WeakMap`; only `session/flushed` advancement makes it redeliver newly covered dispatch events with the generic `{ for: 'event', view }` sidecar. The durable `schedule/change` type selects the client renderer. Taking the maximum contains reversed concurrent flush completion, and exact object identity prevents a reused Session id from inheriting another lifecycle's cursor.

Attached history independently inspects persistence and adds views only to a stored event prefix whose header identity and every event match the live Session. Persistence canonically writes absent top-level `delegationDepth` as zero, so those two forms are identity-equivalent; cwd, lineage, origin, timestamps, version, id, and every event still match exactly. Missing, failed, divergent, or longer inspection withholds the view while returning raw history. Detached history is already a persisted prefix. A parent dispatch copied into a fork seed therefore appears in child history only after child storage proves that prefix.

The browser Session accepts a repeated seq only when the durable event is deeply identical, then upgrades the sidecar immediately without appending another event. Tail loading and true gap repair retain uncovered events in the existing `liveBuffer`; an accepted repair snapshot starts another pull when it advanced the tail but left a later buffered gap, while an identity conflict triggers a full resync. Ordinary older-page pagination keeps receiving live tail events in the current arrays, while a sidecar below the current window stays with the in-flight page and attaches only when that page returns the identical event. Reconnect generations prevent stale page or repair results and `finally` blocks from touching the rebuilt window. `TranscriptAdapter` creates a generic `PresentedEventNode` keyed by the durable event type. `ui-conversation` dispatches it through `conversation.chat.eventview` and retains an expandable JSON fallback, while `ui-schedule` owns the bilingual `schedule/change` reminder row.

```text
schedule_create → Session create event → persistence
                                      ↓ live owner
due → admission → followup → dispatch → flush(true) → session/flushed
                                                        ↓
                                              Host late event sidecar
                                                        ↓
                                client same-seq upgrade → event-keyed UI receipt
```

## Alternatives considered

**Use `ctx.tasks`.** Tasks own process-local work, terminal outcomes, collection, and notifications rather than Session-log state and replayable conversation receipts. Reusing them would make the wrong lifecycle authoritative.

**Store reminders in a private SQLite table or global scheduler.** This could run cold Sessions, but requires a second Session identity map, startup scan, ownership lease, crash protocol, and notification policy. The accepted scope deliberately runs only while the original Session is live.

**Claim dispatch before `followup()` or add exactly-once fencing.** A claim-first record can silently lose the user-visible reminder when enqueue fails. Cross-process exactly-once requires a lease, outbox, acknowledgement, and downstream idempotency boundary that Session-local best-effort model work does not provide.

**Treat the model message as the receipt.** The queued inbox item is process-local and may fail before a durable user message exists. A dispatch-derived Web receipt remains visible and replayable independently of model success.

**Attach the reminder view on append.** `session/event` precedes the durability result, so this would display a ghost receipt after a rejected flush. The success watermark makes presentation follow the commit point.

**Add a Schedule-specific wire frame, client cache, or management page.** The generic event sidecar, existing Session window buffer, keyed slot, and model-facing tools already carry the required result. A parallel transport or state store would duplicate identity and replay logic.

**Adopt existing roots or register global tools.** Late adoption makes plugin load order change which unseen timers begin running and exposes tools outside the supported root-Agent composition. Future-root, Agent-scoped installation gives one clear lifecycle.

The design does not recognize or migrate any unmerged Schedule implementation or private storage format. No fixed Session id, claim-before-send record, startup miss, or private database is a compatibility input.

## Verification

Package tests pin strict decoding, transitions, fork suffixes, id reuse, time bounds, bounded waits, wall-clock movement, overdue admission, fixed framing, enqueue and append failures, barrier recovery, registration rollback, and quiescent disposal at 100% per-file coverage. Persistence tests cover new, fork, and resumed initialization failures against the actual durable cursor. The assembled Loader/Web restart lane proves pending recovery, fork isolation, one durable dispatch, cold-history rendering without Agent activation, and no redelivery after another restart. Host/client tests cover commit gating, reversed watermarks, semantic header identity, per-event prefix matching, immediate same-seq upgrades, concurrent live-tail pagination, true gaps, and reconnect generations.

The opt-in Loader composition boots the source and built packages. A keyless real-browser scenario executes `schedule_create` through the complete tool pipeline, waits for a one-second dispatch, observes the identity-matched persisted prefix, and renders the durable reminder card from attached history. The deliberately absent model adapter closes the turn with an error after dispatch, proving that model failure does not remove the receipt.

## Consequences

- Reminder state survives process restart and replays through ordinary Session persistence without a new database or public service.
- A cold Session does no work and sends no external notification; reopening it may deliver an overdue reminder, and every tool/card says `session-local`.
- Each live root adds only fold-derived timers, an optional idle wait, and one in-flight operation. Long waits and plugin unload do not create a second durable state machine.
- The generic commit-aware event-view path is reusable by other durable events, but it adds event-identity checks and request-generation fencing to the client Session window.
- The strict after-only protocol is intentionally small; other rule families require explicit record, time, and recurrence semantics rather than dormant fields.
