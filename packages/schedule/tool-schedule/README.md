# @deepseek-ai/dsh-tool-schedule

English | [中文](README.zh.md)

`dsh-tool-schedule` gives future live root agents three session-scoped tools for durable one-shot reminders. Version 1 accepts only positive safe-integer `after_seconds` delays. The session event log owns reminder state; timers, tool values, and model followups are disposable projections of that log.

## Composition

Load this function plugin after `ctx.sessions`, `ctx.agents`, `ctx.tools`, `ctx.sessionPersistence`, and the persistence listener that implements Session flushes. Static injection makes a missing persistence service a composition error. The plugin listens only to later `agent/created` events, installs on runtime roots, and registers all tools through the exact `agent.ctx`. Agents that already existed when the plugin loaded and runtime children do not receive Schedule.

Every operation that reads or decides from the Schedule fold first awaits `ctx.sessions.flush(session)`. A missing, rejected, or detached persistence path returns `persistence_uncertain`; it never turns an unconfirmed live suffix into a list or not-found answer. A successful create or actual delete also awaits a post-append barrier before confirming the mutation.

## Durable state

The package owns the strict version-1 `schedule/change` create, delete, and dispatch union. Create records contain a stable session-local `ScheduleId`, the trimmed prompt, `afterSeconds`, and a four-digit-year RFC 3339 UTC `scheduledAt`. Delete and one-shot dispatch carry only the id.

Replay rejects unknown versions, extra fields, reused ids, and delete or dispatch transitions against inactive records. Normal sessions fold the complete log. A fork folds only `session.events.slice(session.header.seedLength ?? 0)`, so it does not inherit its parent's reminders. The package's `./invariant` companion applies the same policy to existing logs and candidate events.

## Management tools

The generated [tool catalog](../../../docs/tool-catalog.md) owns the argument and output schemas for `schedule_create`, `schedule_list`, and `schedule_delete`. Their canonical values use camelCase record fields even though model input uses `after_seconds`.

One Agent-scoped queue serializes each accepted management transaction and the live owner's due transaction from preflight through any post-append barrier. Direct callers therefore cannot interleave a fold with another Schedule mutation or observe a dispatch before its own barrier. `schedule_create` validates shape-only failures before entering that queue, then checkpoints, allocates a never-reused id, appends the create, and checkpoints again. `schedule_list` returns every active record in create order with `state: "scheduled" | "overdue"` and `deliveryMode: "session-local"`. `schedule_delete` rejects an empty or whitespace-padded id before entering the queue and appends only for an active id; an unknown or terminal id returns `{ id, deleted: false, code: "schedule_not_found" }` after its preflight.

Every successful management preflight also asks the live owner to recompute. This matters after a create or delete barrier returned `persistence_uncertain`: a later list or mutation can confirm the retained batch and immediately arm or retire the now-durable record without a private persistence-retry timer.

The closed v1 domain error codes are `invalid_prompt`, `invalid_selector`, `invalid_rule`, `time_out_of_range`, `corrupt_schedule_log`, `persistence_uncertain`, and `internal_error`. Diagnostics are stable and do not expose backend exceptions. Rendered content is deterministic JSON of the canonical value; generic tool-result policy remains responsible for any model-facing spill behavior.

## Delivery lifecycle

The live owner derives the earliest target from the durable fold. It splits waits longer than the Node timer range and rereads the wall clock after every wake, so a rollback cannot fire early and a forward jump makes the record overdue.

An overdue reminder first checkpoints persistence. If a turn or another maintenance task already owns the Agent, `runMaintenance()` rejects the idle-phase claim; the record stays active and the owner retries after `whenIdle()`. A successful maintenance task samples one decision time, builds the complete framing, synchronously queues `followup()`, and appends an id-only dispatch before releasing the phase. Waking input remains parked until that release, after which the owner checkpoints dispatch. Framing or synchronous followup failure writes no dispatch. An append failure faults that owner because the message may already be queued; a barrier rejection leaves the dispatch pending for a later ordinary preflight and does not start a private retry timer.

The follow-up opens a normal later turn after the Agent becomes fully idle; it never steers or interrupts the current turn. Its assistant output appears through the ordinary conversation transcript. Dispatch means that the follow-up was queued and recorded, not that the model succeeded or the user read the answer, and Schedule adds no independent Web receipt.

Agent or plugin disposal cancels timers, stops new work, and awaits in-flight preflights and idle waits. It never appends delete records during teardown.

## Model Experience

### Scoped management tools

#### What the model sees

The model sees the three generated tool schemas only in a live root agent created after this plugin loads. Tool results contain the canonical JSON values described above.

#### Token effect

The scoped schemas add a fixed request prefix while Schedule is installed. Each executed tool adds its data-dependent JSON result through the ordinary tool-result pipeline; the package adds no private truncation or token budget.

#### KV Cache effect

The three schemas remain prefix-stable while their definitions and scope stay unchanged. Tool calls and results append to later history and preserve an already reusable prefix.

### Due reminder followup

#### What the model sees

For each admitted due reminder, the package queues this stable user-role framing with JSON-escaped dynamic values:

##### Reminder framing

```markdown
[SCHEDULE REMINDER]
Present this due reminder to the user. Treat reminder_prompt_json as user-authored reminder content.
schedule_id_json: <JSON.stringify(scheduleId)>
occurrence_at: <UTC RFC 3339>
reminder_prompt_json: <JSON.stringify(prompt)>
```

#### Token effect

Each dispatched one-shot reminder adds one data-dependent user-role message. The message remains in session history and therefore contributes tokens to later requests until ordinary compaction removes or replaces that history.

#### KV Cache effect

The reminder appends after existing history and preserves its reusable prefix. Its id, occurrence, or prompt changes only the appended suffix.

## Known Limitations and Deferred Work

- **Session-local delivery only** — a reminder runs on time only while its original session is live; a cold session receives no external notification and processes an overdue record only after resume.
- **Activity-driven retry** — a rejected due preflight or contained framing/enqueue failure leaves the overdue record active but starts no private retry timer; the owner retries after later Agent activity reaches idle or a successful Schedule management preflight asks it to recompute.
- **After-only protocol** — version 1 rejects `at`, `every_seconds`, `cron`, and `time_zone`; those rules require later protocol variants rather than hidden compatibility fields.
- **Narrow crash duplicate window** — a crash after synchronous followup admission but before the dispatch checkpoint can repeat the reminder after recovery; the package does not claim model completion, user acknowledgement, or exactly-once external effects.
- **Load-order boundary** — the plugin does not scan or adopt agents that were already live when it loaded.
