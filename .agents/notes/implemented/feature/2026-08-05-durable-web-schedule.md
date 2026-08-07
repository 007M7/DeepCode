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
| Several recurring reminders are overdue | Each active record retains its next target; dispatch history retains the last batch time and Cron calendar decisions | One maintenance claim selects every latest due occurrence after the shared 300-second gate | One model batch, with an independent receipt and next target for each reminder |
| Process stopped or Session cold | Active create remains in persistence | No timer or background scan exists; resume rebuilds the owner | Future target waits again; overdue target is attempted once |
| Fork | Parent events remain in the inherited prefix | Child fold starts at `seedLength` | Parent receipt may appear in history, but no parent reminder becomes active child work |

### Session log authority and tools

The version-1 `schedule/change` stream is the only durable Schedule authority. A create record owns a Session-local, non-reused branded id, the trimmed user prompt, the rule, and its UTC target. Delete terminates any record; an id-only dispatch terminates a one-shot; an Every dispatch stores the shared batch `acceptedAt` and advances by anchor arithmetic; a Cron dispatch stores `occurrenceAt`, shared `acceptedAt`, and optional `nextScheduledAt` to freeze the live calendar decision. The fold terminates a record with no next target and derives every remaining recurring record as terminal when the shared gate itself has no four-digit-year admission left. The strict decoder and pure fold reject unknown versions, extra fields, reused ids, mismatched dispatch shapes, batches less than 300 seconds apart, and transitions against inactive records. A normal Session folds its complete stream; a fork folds only events at or after `SessionHeader.seedLength`.

The current rule union accepts a non-empty prompt and exactly one selector. `after_seconds` is a positive safe-integer delay whose record is `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`. `at` is either a strict RFC 3339 date-time with `Z` or a numeric offset, or a structured `{ date, time, time_zone? }` local value; its record is `{ id, kind: 'at', prompt, scheduledAt }`. Both one-shot dispatches store only the id because the active record already fixes the occurrence. `every_seconds` is a safe integer of at least 300; its `{ id, kind: 'every', prompt, everySeconds, scheduledAt }` record needs no stored anchor because each accepted target remains on the initial fixed-rate sequence. Its dispatch stores only `id + acceptedAt`, from which the fold derives occurrence and next. Cron must be paired with explicit `time_zone`; its `{ id, kind: 'cron', prompt, cron, timeZone, scheduledAt }` record retains the canonical calendar rule and zone, while its dispatch freezes occurrence and next. Tool values derive `scheduled` or `overdue`, always include `deliveryMode: 'session-local'`, and expose `deliveryNotBefore` only while an overdue recurring record is gate-blocked.

An Agent-scoped FIFO serializes each accepted management transaction and the live owner's due transaction from preflight through any post-append barrier. Every tool operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create may reject input-shape failures before entering the FIFO; after a successful preflight it allocates an id, appends create, and waits for a second barrier. Delete validates its id before the FIFO, then preflights before deciding whether the id is active and waits for a second barrier only when it appends. List and unknown or finished delete never answer from an unconfirmed live suffix or observe a dispatch before its own barrier. A failed barrier returns `persistence_uncertain` rather than guessing whether an eager write committed.

Every successful management preflight also asks the live owner to recompute. This closes the recovery path where create appended successfully but its post-append barrier rejected: a later list can confirm the coordinator's retained batch, return the active record, and arm its timer without a Schedule-specific retry loop.

### Session and request time-zone ownership

The official Web create path requires the browser's IANA zone, validates and canonicalizes it at the Host boundary, and stores it once as immutable `SessionHeader.timeZone`. Resume preserves that value, fork copies it, and another create for the same id and cwd conflicts when its canonical zone differs. Session core keeps the field optional so pre-zone Sessions remain readable but explicitly `unavailable`; a legacy header is never backfilled from a later browser request. JSONL preserves the optional header, while SQLite schema v14 adds nullable `time_zone` and upgrades an owned v13 database atomically without guessing values for existing rows.

That exact v13-to-v14 transaction is a narrow planned exception to the pre-release default of rejecting old storage formats: valid headerless Session databases can exist before time-zone metadata is introduced. It accepts only the owned v13 layout, rejects older, newer, or spoofed schemas without mutation, and does not establish a general migration framework.

Every Web prompt samples its own `clientTimeZone`, which the Host validates before Agent entry and binds to that immutable `user-rpc` message source. This is request provenance, not a mutable property of the connection or Session, so concurrent tabs cannot overwrite one another and queue, steering, edit, retry, and persisted history retain the originating zone.

Time-context delegates through `agent/pre-step`, derives the final non-empty entered batch's zones from the immutable Session header and message-bound browser sources, and appends one model-visible reading to that batch. Its source remains the simple plugin marker; it does not copy those facts into another durable authority. Steering inserted after AgentLoop claims the current batch keeps ordinary next-step ownership and receives fresh context when that step enters. Rejection, an empty decision, cancellation, or failure before `step/start` records no reading, and this feature adds no inbox or AgentLoop lifecycle state.

Schedule requires a time-context marker in the current open turn, then derives request zones directly from that turn's original `user-rpc` sources. An implicit local `at` is accepted only when that derivation has one client zone equal to the Session zone. A headerless Session, missing or mixed client provenance, or a client/Session mismatch returns `timezone_confirmation_required` with the known zones. An explicit `time_zone` bypasses that ambiguity check but still passes the same IANA validation.

### Absolute-time normalization

Schedule, rather than the model or process locale, owns deterministic calendar normalization. Explicit-offset input must match the narrow supported profile and identify a strictly future four-digit-year instant. Structured local input validates the calendar and selected zone, rejects a daylight-saving gap, and chooses the first, earlier instant in an overlap. A successful create stores only UTC `scheduledAt`; the original offset, local fields, and interpreting zone are not a second durable representation. Natural-language interpretation remains the model's job, and time-context appears before the tool call rather than relying on a result echo.

### Restricted Cron calendar evaluation

Schedule owns a numeric five-field parser rather than exposing Croner's language. Each field is exactly a wildcard, integer, strictly increasing integer list, increasing inclusive range, wildcard step, or range step. Canonicalization removes leading zeros and normalizes spaces. Day-of-month and day-of-week cannot both be restricted; Sunday `0` and `7` share one semantic value. Names, macros, seconds, years, Quartz tokens, mixed forms, and duplicate semantics fail before persistence.

The frequency proof enumerates the complete 400-year Gregorian date cycle and combines it with exact times-of-day. It checks same-day neighbors, cross-midnight neighbors, and the cycle seam, rejecting any nominal interval below five minutes without maintaining a quota or sampling a shorter window.

The exact production dependency is `croner@10.0.1`, an MIT-licensed ESM package with no transitive dependencies. Schedule gives it hidden seconds=`0` and year=`1-9999`, constructs it paused without a callback, and retains timer, gate, admission, and persistence ownership. The adapter rejects gap-normalized candidates, chooses the first instant in an overlap, and requires strict forward/backward cursor movement. JavaScript constructors remap years 0–99, so an owned local-calendar walker handles that lower range and its transition before safe-year searches delegate to Croner. Live create and due handling, including the pre-append package invariant, use current Croner and ICU; replay only checks canonical rule/zone shapes, whole-minute four-digit UTC instants, and `currentScheduledAt <= occurrenceAt <= acceptedAt < nextScheduledAt`, so tzdata changes never invalidate a committed history.

### Persistence checkpoint and initialization recovery

`SessionStore.flush()` awaits every scoped listener and treats literal `true` as an explicit durability acknowledgement. An acknowledged call publishes a contained `session/flushed(session, throughSeq)` observation whose exclusive boundary was captured at call entry; append notification itself is not durability evidence. Observe-only listeners return void, an empty or observe-only checkpoint returns `false`, and any listener rejection prevents the success observation after all listeners settle.

The persistence coordinator supplies that acknowledgement only after its write path is quiescent. Its live controller retains the initial `seedEnd` scalar rather than a seed copy. If the first initialization rejects, a later flush rebuilds that immutable prefix from the append-only Session, reads the backend's actual cursor, and appends only a missing suffix. This covers failures before storage changed and failures reported after a commit, so one transient error neither permanently poisons the Session nor duplicates its prefix.

### Live delivery lifecycle

The Agent-scoped owner derives its active targets and latest recurring batch from the durable fold. Long targets use bounded timer segments, and every wake reads the wall clock again, so a rollback cannot fire early and a forward jump becomes overdue. A fixed-rate record treats its current `scheduledAt` as the earliest unaccepted point on the original sequence; integer division selects the latest due point directly. A Cron record treats its persisted target as a history-stable baseline, searches only for newer current matches, and persists the chosen occurrence and next target. Neither rule replays a missed backlog or shifts its authority to delivery time. Once one recurring record is overdue behind a closed gate, the owner arms that gate or an earlier one-shot instead of waking at intervening recurring targets. If a turn or another maintenance task already owns the Agent, `runMaintenance()` rejects the claim; the record stays active and one `whenIdle()` wait triggers a later retry. A rejected persistence preflight or contained framing/synchronous-enqueue failure also leaves the record active, but no private retry timer runs; later Agent activity reaching idle or a successful Schedule management preflight asks the owner to try again.

The accepted path first clears pending persistence and claims the true idle phase through `runMaintenance()`. Inside that task it refolds the exact Session suffix so a direct management mutation that won the claim race cannot be followed by a stale dispatch, then samples the decision clock once. A due one-shot bypasses the recurring gate and keeps the single fixed frame plus id-only dispatch. Otherwise the 300-second gate admits every overdue Every and Cron record in target/create order: the owner derives each latest occurrence, constructs the complete JSON batch before enqueue, synchronously queues one `followup()`, and appends an independent rule-specific dispatch per record. The gate's spacing directly limits every half-open 24-hour window to at most 288 recurring model turns; no second counter or quota exists. Waking input remains parked until maintenance settles, so the driver cannot claim the message before dispatch enters the log; only after the task releases the phase does the owner wait for the shared dispatch barrier. A framing or synchronous enqueue failure is contained and appends no dispatch. An append failure faults that owner because the message may already be queued. A later prompt-admission, request-checkpoint, or model failure cannot retract a dispatch.

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

**Hand-roll an IANA calendar evaluator or expose Croner's full syntax.** Implementing zone transitions locally would duplicate tzdata-sensitive search, while accepting the dependency's names, macros, seconds, years, and Quartz extensions would make an external parser the public contract. The narrow Schedule parser and paused adapter keep language, frequency, lifecycle, and replay policy in their owning package while delegating calendar search.

The design does not recognize or migrate any unmerged Schedule implementation or private storage format. No fixed Session id, claim-before-send record, startup miss, or private database is a compatibility input.

## Verification

Package tests pin strict decoding, transitions, fork suffixes, id reuse, offset and local-calendar profiles, IANA validation, gap rejection, overlap-first selection, mismatch confirmation, time bounds, fixed-rate anchor arithmetic, restricted cron grammar, 400-year frequency proof, hidden year 3000 support, DST search, history-stable Cron dispatches, latest-only catch-up, 300-second batch spacing, full mixed batches, one-shot bypass, bounded waits, wall-clock movement, overdue admission, management/dispatch race refolding, fixed framing, enqueue and append failures, barrier recovery, registration rollback, and quiescent disposal at 100% per-file coverage. Persistence tests cover new, fork, and resumed initialization failures against the actual durable cursor, optional header round-trips, a real SQLite v13-to-v14 migration, and a production JSONL restart. The assembled Loader/Web restart lane proves pending recovery, fork isolation, one durable dispatch, cold-history rendering without Agent activation, and no redelivery after another restart. Host/client tests cover zone identity across live, stored, and concurrent-create paths; per-operation prompt provenance; commit gating; reversed watermarks; semantic header identity; per-event prefix matching; same-seq upgrades; every window merge exit; and reconnect generations.

Time-context tests cover final pre-step messages, current-turn unique/mixed/missing zone derivation, post-claim steering entering the next step, cancellation, empty suppression, retry, exact snapshot-source validation, and in-flight disposal. Schedule tests independently derive the same request zones from durable `user-rpc` sources, reuse a same-turn marker across an empty continuation, and fail closed without an open-turn marker. The opt-in Loader composition boots the source and built packages. Keyless real-browser scenarios execute `schedule_create` through the complete tool pipeline for the short `after` and absolute-time cases, observe the identity-matched persisted prefix, and render durable cards from attached history. One production-JSONL restart scenario pins the exact ordered Every batch. The final mixed restart proves an overdue one-shot dispatch precedes an already eligible Every/Cron batch, then verifies one shared `acceptedAt`, two rule-specific dispatches, one exact batch golden, future targets, and independent Web receipts. The deliberately absent model adapter closes each reminder turn with an error after dispatch, proving that model failure does not remove a receipt.

## Consequences

- Reminder state survives process restart and replays through ordinary Session persistence without a new database or public service.
- A cold Session does no work and sends no external notification; reopening it may deliver an overdue reminder, and every tool/card says `session-local`.
- Each live root adds only fold-derived timers, an optional idle wait, and one in-flight operation. Long waits and plugin unload do not create a second durable state machine.
- A Session's default zone is immutable and may remain unavailable for older history. Travel or concurrent tabs can therefore require an explicit zone instead of silently changing the meaning of “tomorrow at 09:00.”
- The generic commit-aware event-view path is reusable by other durable events, but it adds event-identity checks and generation-aware merge behavior to the client Session window.
- The strict protocol covers delayed, absolute, fixed-rate, and explicit-zone calendar targets while keeping the external evaluator private and history stable.
