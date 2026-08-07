# Agent Note: Durable Session-local Web reminders

Status: implemented

English | [中文](2026-08-05-durable-web-schedule.zh.md)

## Problem

A reminder created inside a conversation needs to survive a process restart and remain attributable to that exact Session. A process-local timer or model inbox item cannot provide that durability, while a global scheduler or private database would introduce a second identity, persistence, and lifecycle system. The user also needs a visible receipt even when the best-effort model turn later fails, without seeing a reminder whose dispatch never reached storage.

Busy Agents, long waits, wall-clock changes, cold Sessions, forks, persistence failures, and browser history races make a simple timeout insufficient. The design must distinguish a durable record from its disposable live wait, keep a fork from inheriting its parent's active reminders, and merge a presentation sidecar that can arrive after the underlying event.

## Decision

The [`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay explicitly loads `@deepseek-ai/dsh-time-context`, `@deepseek-ai/dsh-tool-schedule`, and the separate `@deepseek-ai/dsh-client-ui-schedule` renderer. The default Web tree remains unchanged. Schedule observes only root Agents published after the plugin loads and installs its three tools plus one disposable owner in that Agent scope. Cold history reads, already-published roots, child Agents, and other hosts do not activate it.

The user-visible boundary is `session-local`: the original Session runs an on-time reminder only while it is live, does no external notification while cold, and processes an overdue reminder after that Session becomes live again.

| Scenario | Durable fact | Live behavior | User-visible result |
| --- | --- | --- | --- |
| Create and manage | `schedule/change` create/delete events in the original Session | Agent-scoped tools checkpoint before reading and after mutations | Stable id, UTC target, `scheduled`/`overdue`, and `session-local` disclosure |
| Due while busy | Active create remains in the fold | Owner waits for `whenIdle()`, claims idle maintenance, queues one followup, then appends dispatch | One replayable reminder receipt; model failure does not retract it |
| Process stopped or Session cold | Active create remains in persistence | No timer or background scan exists; resume rebuilds the owner | Future target waits again; overdue target is attempted once |
| Fork | Parent events remain in the inherited prefix | Child fold starts at `seedLength` | Parent receipt may appear in history, but no parent reminder becomes active child work |

### Session log authority and tools

The version-1 `schedule/change` stream is the only durable Schedule authority. A create record owns a Session-local, non-reused branded id, the trimmed user prompt, the rule, and its UTC target. Delete and dispatch are terminal transitions. The strict decoder and pure fold reject unknown versions, extra fields, reused ids, and transitions against inactive records. A normal Session folds its complete stream; a fork folds only events at or after `SessionHeader.seedLength`.

The current rule union accepts a non-empty prompt and exactly one selector. `after_seconds` is a positive safe-integer delay whose record is `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`. `at` is either a strict RFC 3339 date-time with `Z` or a numeric offset, or a structured `{ date, time, time_zone? }` local value; its record is `{ id, kind: 'at', prompt, scheduledAt }`. Both dispatch shapes store only the id because the active record already fixes the occurrence. `every_seconds` and `cron` remain rejected rather than hidden in unused fields. Tool values derive `scheduled` or `overdue` and always include `deliveryMode: 'session-local'`.

An Agent-scoped FIFO serializes each accepted management transaction and the live owner's due transaction from preflight through any post-append barrier. Every tool operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create may reject input-shape failures before entering the FIFO; after a successful preflight it allocates an id, appends create, and waits for a second barrier. Delete validates its id before the FIFO, then preflights before deciding whether the id is active and waits for a second barrier only when it appends. List and unknown or finished delete never answer from an unconfirmed live suffix or observe a dispatch before its own barrier. A failed barrier returns `persistence_uncertain` rather than guessing whether an eager write committed.

Every successful management preflight also asks the live owner to recompute. This closes the recovery path where create appended successfully but its post-append barrier rejected: a later list can confirm the coordinator's retained batch, return the active record, and arm its timer without a Schedule-specific retry loop.

### Session and request time-zone ownership

The official Web create path requires the browser's IANA zone, validates and canonicalizes it at the Host boundary, and stores it once as immutable `SessionHeader.timeZone`. Resume preserves that value, fork copies it, and another create for the same id and cwd conflicts when its canonical zone differs. Session core keeps the field optional so pre-zone Sessions remain readable but explicitly `unavailable`; a legacy header is never backfilled from a later browser request. JSONL preserves the optional header, while SQLite schema v14 adds nullable `time_zone` and upgrades an owned v13 database atomically without guessing values for existing rows.

Every Web prompt samples its own `clientTimeZone`, which the Host validates before Agent entry and binds to that immutable `user-rpc` message source. This is request provenance, not a mutable property of the connection or Session, so concurrent tabs cannot overwrite one another and queue, steering, edit, retry, and persisted history retain the originating zone.

Time-context delegates through `agent/pre-step`, derives the final non-empty entered batch's zones from the immutable Session header and message-bound browser sources, and appends one model-visible reading to that batch. Its source remains the simple plugin marker; it does not copy those facts into another durable authority. Steering inserted after AgentLoop claims the current batch keeps ordinary next-step ownership and receives fresh context when that step enters. Rejection, an empty decision, cancellation, or failure before `step/start` records no reading, and this feature adds no inbox or AgentLoop lifecycle state.

Schedule requires a time-context marker in the current open turn, then derives request zones directly from that turn's original `user-rpc` sources. An implicit local `at` is accepted only when that derivation has one client zone equal to the Session zone. A headerless Session, missing or mixed client provenance, or a client/Session mismatch returns `timezone_confirmation_required` with the known zones. An explicit `time_zone` bypasses that ambiguity check but still passes the same IANA validation.

### Absolute-time normalization

Schedule, rather than the model or process locale, owns deterministic calendar normalization. Explicit-offset input must match the narrow supported profile and identify a strictly future four-digit-year instant. Structured local input validates the calendar and selected zone, rejects a daylight-saving gap, and chooses the first, earlier instant in an overlap. A successful create stores only UTC `scheduledAt`; the original offset, local fields, and interpreting zone are not a second durable representation. Natural-language interpretation remains the model's job, and time-context appears before the tool call rather than relying on a result echo.

### Persistence checkpoint and initialization recovery

`SessionStore.flush()` awaits every scoped listener and treats literal `true` as an explicit durability acknowledgement. An acknowledged call publishes a contained `session/flushed(session, throughSeq)` observation whose exclusive boundary was captured at call entry; append notification itself is not durability evidence. Observe-only listeners return void, an empty or observe-only checkpoint returns `false`, and any listener rejection prevents the success observation after all listeners settle.

The persistence coordinator supplies that acknowledgement only after its write path is quiescent. Its live controller retains the initial `seedEnd` scalar rather than a seed copy. If the first initialization rejects, a later flush rebuilds that immutable prefix from the append-only Session, reads the backend's actual cursor, and appends only a missing suffix. This covers failures before storage changed and failures reported after a commit, so one transient error neither permanently poisons the Session nor duplicates its prefix.

### Live delivery lifecycle

The Agent-scoped owner derives its earliest target from the durable fold. Long targets use bounded timer segments, and every wake reads the wall clock again, so a rollback cannot fire early and a forward jump becomes overdue. If a turn or another maintenance task already owns the Agent, `runMaintenance()` rejects the claim; the record stays active and one `whenIdle()` wait triggers a later retry. A rejected persistence preflight or contained framing/synchronous-enqueue failure also leaves the record active, but no private retry timer runs; later Agent activity reaching idle or a successful Schedule management preflight asks the owner to try again.

The accepted path first clears pending persistence and claims the true idle phase through `runMaintenance()`. Inside that task it refolds the exact Session suffix so a direct management mutation that won the claim race cannot be followed by a stale dispatch, samples the decision clock once, constructs the complete fixed reminder frame with JSON-escaped id and prompt, synchronously queues one `followup()`, and appends the id-only dispatch. Waking input remains parked until maintenance settles, so the driver cannot claim the message before dispatch enters the log; only after the task releases the phase does the owner wait for the dispatch barrier. A framing or synchronous enqueue failure is contained and appends no dispatch. An append failure faults that owner because the message may already be queued. A later prompt-admission, request-checkpoint, or model failure cannot retract a dispatch.

Agent or plugin disposal cancels timers, stops new work, unwinds the three tool registrations, and waits for in-flight preflights or idle waits. It never deletes durable records during teardown. The narrow crash interval after synchronous followup admission and before durable dispatch may repeat the reminder after recovery; the design prefers a visible duplicate over silent loss and makes no model-success, user-read, external-effect, or exactly-once promise.

### Commit-aware Web receipt

The Schedule package owns `scheduleReminderPresentation()`, which derives `{ scheduleId, prompt, occurrenceAt }` from create plus dispatch; the client renderer adds the fixed `session-local` label. The current fork's `seedLength` is a hard boundary for child-owned dispatches. An inherited dispatch instead pairs with its nearest preceding same-id create because `session/end-seed` also marks replay or resume construction, not only fork ownership. This keeps resumed ancestor receipts renderable, preserves nested-generation id reuse, and never changes live ownership.

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

**Use the process zone or the most recently connected browser as the default.** The process zone is deployment state, while a connection-level value lets one tab or a later trip silently reinterpret another request. An immutable Session default plus message-bound client provenance makes disagreement visible without creating shared mutable zone state.

**Parse arbitrary natural-language dates inside Schedule or persist the local input.** A second language parser would compete with the model, and retaining local text or zone beside the resolved instant would create two durable interpretations of one one-shot target. The model emits a narrow structure after seeing time-context; Schedule validates it and stores one UTC fact.

The design does not recognize or migrate any unmerged Schedule implementation or private storage format. No fixed Session id, claim-before-send record, startup miss, or private database is a compatibility input.

## Verification

Package tests pin strict decoding, transitions, fork suffixes, id reuse, offset and local-calendar profiles, IANA validation, gap rejection, overlap-first selection, mismatch confirmation, time bounds, bounded waits, wall-clock movement, overdue admission, fixed framing, enqueue and append failures, barrier recovery, registration rollback, and quiescent disposal at 100% per-file coverage. Persistence tests cover new, fork, and resumed initialization failures against the actual durable cursor, optional header round-trips, a real SQLite v13-to-v14 migration, and a production JSONL restart. The assembled Loader/Web restart lane proves pending recovery, fork isolation, one durable dispatch, cold-history rendering without Agent activation, and no redelivery after another restart. Host/client tests cover zone identity across live, stored, and concurrent-create paths; per-operation prompt provenance; commit gating; reversed watermarks; semantic header identity; per-event prefix matching; same-seq upgrades; every window merge exit; and reconnect generations.

Time-context tests cover final pre-step messages, current-turn unique/mixed/missing zone derivation, post-claim steering entering the next step, cancellation, empty suppression, retry, exact snapshot-source validation, and in-flight disposal. Schedule tests independently derive the same request zones from durable `user-rpc` sources, reuse a same-turn marker across an empty continuation, and fail closed without an open-turn marker. The opt-in Loader composition boots the source and built packages. Keyless real-browser scenarios execute `schedule_create` through the complete tool pipeline for the existing short `after` case and one absolute-time case, observe the identity-matched persisted prefix, and render the durable reminder card from attached history. The deliberately absent model adapter closes the turn with an error after dispatch, proving that model failure does not remove the receipt.

## Consequences

- Reminder state survives process restart and replays through ordinary Session persistence without a new database or public service.
- A cold Session does no work and sends no external notification; reopening it may deliver an overdue reminder, and every tool/card says `session-local`.
- Each live root adds only fold-derived timers, an optional idle wait, and one in-flight operation. Long waits and plugin unload do not create a second durable state machine.
- A Session's default zone is immutable and may remain unavailable for older history. Travel or concurrent tabs can therefore require an explicit zone instead of silently changing the meaning of “tomorrow at 09:00.”
- The generic commit-aware event-view path is reusable by other durable events, but it adds event-identity checks and generation-aware merge behavior to the client Session window.
- The strict one-shot protocol covers delayed and absolute targets. Recurring rule families still require explicit transition, catch-up, and model-budget semantics rather than dormant fields.
