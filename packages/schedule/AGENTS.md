# AGENTS.md — Schedule packages

These rules supplement the repository and package instructions for `packages/schedule/*`.

- The owning Session's versioned `schedule/change` stream is the only durable Schedule state. Folds validate every durable JSON boundary and derive active records; timers, waiters, admission reservations, presentation cursors, and tool values remain disposable projections.
- A normal Session folds its complete log. A fork derives active Schedule state only from events at or after `SessionHeader.seedLength`; it never inherits an active parent reminder.
- Every Schedule management operation that reads or decides from the fold first awaits `ctx.sessions.flush(session)`. Create and an actual delete await a second barrier after append; a failed barrier returns the stable uncertainty result instead of inferring durability from the live log.
- Runtime owners attach only to future live root Agents while the plugin is loaded. They do not scan persisted Sessions, adopt already-published roots, wake cold Sessions, register global tools, or delete durable records during teardown.
- Due handling rechecks the wall clock and exact live owner, reserves turn admission through the public Agent seam, constructs the complete escaped framing before `followup()`, appends dispatch only after synchronous enqueue returns, releases the reservation in `finally`, and then awaits durability. A synchronous framing/enqueue failure appends no dispatch; a later model failure does not roll one back.
- Rule math and durable transition logic stay pure and deterministic. Production uses the platform wall clock and segmented timers; tests supply explicit samples or fake timers without adding a production clock service.
- Host and browser presentation is derived from a durability-proven event prefix. Domain view construction belongs to Schedule, generic transport and keyed fallback belong to the Host/client runtime, and the Schedule card belongs to its separate client plugin.
