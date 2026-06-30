# session-fork/ — session fork capability family

The session fork capability: a small optional service that validates a live session is at a turn boundary, snapshots its event log as a seed, and creates forked child sessions through the existing `dsh-session` seed primitive. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `session-fork/` | Session fork service: reusable seed snapshot + forked live-session creation | `ctx.sessionFork` |

The interface and implementation live together at `session-fork/session-fork/` because v1 has no swappable backend: all durable behavior is delegated to the existing session store and persistence backends. The decision is recorded in [the session fork service RFC](../../docs/rfc/implemented/feature/2026-06-30-session-fork-service.md).
