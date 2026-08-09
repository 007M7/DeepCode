# Session-local Schedule

English | [中文](schedule.zh.md)

Schedule owns durable reminders that return to the original live Session as ordinary later conversation turns. The [durable Schedule Agent Note](../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) owns the persistence and lifecycle decisions, and [conversational delivery](../../.agents/notes/implemented/simplification/2026-08-09-conversational-schedule-delivery.md) owns the no-receipt boundary. This page records the durable and model-facing shapes from [`packages/schedule/tool-schedule/src/types.ts`](../../packages/schedule/tool-schedule/src/types.ts); the [package README](../../packages/schedule/tool-schedule/README.md) owns composition, tool behavior, and the exact reminder framing.

## Durable records

`ScheduleId` is a [branded id](core.md#branded-ids), unique and never reused within one Session. Version 1 initially supports a positive safe-integer `after_seconds` selector. Creation canonicalizes the selected target into a four-digit-year RFC 3339 UTC `scheduledAt`; the submitted delay remains in the record so list results explain the rule that produced it.

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator; v1 supports only delayed one-shot reminders. */
  readonly kind: 'after'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** The v1 durable reminder record union. */
type ScheduleRecord = AfterScheduleRecord
```

## Durable changes and replay

The version-1 `schedule/change` Session event is the only durable Schedule authority. Create stores the complete record. Delete and dispatch are terminal id-only transitions for one-shot reminders; dispatch means the follow-up was synchronously queued, not that a model answer succeeded or the user read it.

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface ScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Strict version-1 durable Schedule mutation union. */
type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange
```

The strict decoder and fold reject unknown versions, extra fields, reused ids, and delete or dispatch transitions against inactive records. A normal Session folds its complete event stream. A fork folds only events at or after `SessionHeader.seedLength`, so it retains history without adopting the parent Session's active reminders. The `schedule/change` declaration and source location are also indexed in the [persistence catalog](../persistence-catalog.md#schedulechange--log-only).

## Active views and management

Tool values combine the durable record with delivery state derived from the current wall clock. `session-local` means the original Session must be live: no external notification channel or cold-session scheduler exists.

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Fixed v1 delivery boundary: the original session must be live. */
type ScheduleDeliveryMode = 'session-local'
```

```ts type-equiv
/** Complete model-facing view of one active after reminder. */
interface ScheduleView extends AfterScheduleRecord {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}
```

The generated [tool catalog](../tool-catalog.md#deepseek-aidsh-tool-schedule) owns the argument and result schemas for `schedule_create`, `schedule_list`, and `schedule_delete`. Management calls serialize with due work in one Agent-scoped queue. Every read or decision first waits for the shared Session persistence barrier; create and an actual delete wait again after appending. A barrier failure reports `persistence_uncertain` instead of guessing whether an eager write committed. The other stable error codes are `invalid_prompt`, `invalid_selector`, `invalid_rule`, `time_out_of_range`, `corrupt_schedule_log`, and `internal_error`.

## Live delivery

The process-local owner derives its earliest timer from the durable fold and rereads the wall clock after every bounded wait. Cold Sessions do no work; reopening one reconstructs timers and makes a past target overdue. An overdue reminder waits for the Agent to become fully idle and claims the maintenance phase before it refolds state, queues `followup()`, and appends dispatch. It never calls `steer()` and never interrupts a current turn.

The admitted follow-up starts one normal later turn and appears only through the ordinary conversation transcript; Schedule has no independent durable Web receipt or browser renderer. If framing or synchronous queue admission fails, no dispatch is recorded and the reminder stays active. The narrow crash interval after admission but before durable dispatch can repeat the reminder after recovery, so the boundary is best-effort at-least-once rather than exactly-once delivery.
