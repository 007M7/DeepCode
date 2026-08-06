# Durable Web Schedule

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into durable Schedule reminders without changing the shipped default Web composition:

```sh
dsh web --patch examples/web-schedule/cordis.yml
```

The current overlay supports one-shot reminders created with a positive whole-number `after_seconds` or an absolute `at` target, fixed-rate `every_seconds` reminders at intervals of at least 300 seconds, and restricted five-field `cron` reminders paired with an explicit IANA `time_zone`. The model manages them through `schedule_create`, `schedule_list`, and `schedule_delete`; every result identifies the delivery mode as `session-local`.

An `at` target is either a strict RFC 3339 date-time with `Z` or a numeric offset, or a local `{ date, time, time_zone? }` value. The overlay loads time-context so the model sees the current date, local time, Session zone, and request-zone relationship before calling the tool. A local value may omit `time_zone` only when the current browser zone agrees with the immutable zone captured when that Session was created.

The browser samples its zone for each create or prompt operation. Resuming the Session from another zone does not overwrite the original default: an omitted local zone then returns `timezone_confirmation_required`, and the model asks which zone to use before retrying explicitly. Older headerless Sessions behave the same way with an unavailable default. Daylight-saving gaps are rejected and overlaps choose the first instant; successful records keep only the resulting UTC target.

The original Session log owns each reminder. A live root Agent waits, retries after it becomes idle, and records a durable dispatch receipt in the Web conversation. Closing the process or leaving the Session cold stops its in-memory timer without deleting the record; reopening that same Session restores the wait and delivers an overdue reminder. Merely reading cold history never activates it, and a fork does not inherit its parent's reminders.

Fixed-rate reminders remain anchored to their first target. Cron reminders use the stored UTC target as a history-stable baseline while current IANA tzdata determines only newer matches and the next target. A late wake or restart skips the missed backlog and presents only each record's latest due occurrence. All overdue Every and Cron records share one model follow-up when the 300-second recurring gate opens, while each keeps its own durable dispatch, next target, and Web receipt. One-shot reminders bypass that gate.

Create and actual delete operations acknowledge success only after Session persistence confirms their event prefix. A reminder receipt likewise appears only after its dispatch is durable. Schedule does not provide browser, operating-system, email, SMS, or other external notification, and the best-effort model follow-up is not a delivery acknowledgement.

Cron accepts only numeric minute, hour, day-of-month, month, and day-of-week fields using wildcards, integers, increasing lists/ranges, or steps. Day-of-month and day-of-week cannot both be restricted; nominal intervals under five minutes, names, macros, seconds, years, Quartz operators, local defaults, abbreviations, and numeric zone offsets are rejected. DST gaps are skipped, overlaps use the first instant, and the locked calendar evaluator never owns a timer or callback.
