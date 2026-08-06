# Session-local Schedule

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into Schedule reminders without changing the shipped default Web composition:

```sh
dsh web --patch examples/web-schedule/cordis.yml
```

The current overlay supports one-shot reminders created with a positive whole-number `after_seconds` or an absolute `at` target. The model manages them through `schedule_create`, `schedule_list`, and `schedule_delete`; every result identifies the delivery mode as `session-local`.

An `at` target is either a strict RFC 3339 date-time with `Z` or a numeric offset, or a local `{ date, time, time_zone? }` value. The overlay loads time-context so the model sees the current date, local time, Session zone, and request-zone relationship before calling the tool. A local value may omit `time_zone` only when the current browser zone agrees with the immutable zone captured when that Session was created.

The browser samples its zone for each create or prompt operation. Resuming the Session from another zone does not overwrite the original default: an omitted local zone then returns `timezone_confirmation_required`, and the model asks which zone to use before retrying explicitly. Older headerless Sessions behave the same way with an unavailable default. Daylight-saving gaps are rejected and overlaps choose the first instant; successful records keep only the resulting UTC target.

The original Session log owns each reminder. A live root Agent waits and retries after it becomes idle, then queues a normal follow-up turn in that conversation. Closing the process or leaving the Session cold stops its in-memory timer without deleting the record; reopening that same Session restores the wait and delivers an overdue reminder. Merely reading cold history never activates it, and a fork does not inherit its parent's reminders.

Create and actual delete operations acknowledge success only after Session persistence confirms their event prefix. Schedule does not provide browser, operating-system, email, SMS, or other external notification. A durable dispatch records that the follow-up was queued; it does not acknowledge model success or user receipt.

Fixed-interval and cron rules are not accepted by this layer.
