# session-persistence/ — persistence capability family

The durable session-persistence seam and its storage backends. The interface package owns the abstract `SessionPersistence` service and the shared write coordinator; the backends are concrete implementations that register on `ctx.sessionPersistence`. All **product** packages.

| Package | Role | ctx key |
|---|---|---|
| `session-persistence/` | Persistence seam + shared write coordinator | `ctx.sessionPersistence` |
| `session-persistence-jsonl/` | JSONL-sidecar persistence backend | (registers `ctx.sessionPersistence`) |
| `session-persistence-sqlite/` | SQLite persistence backend | (registers `ctx.sessionPersistence`) |

The interface lives at `session-persistence/session-persistence/`; backends are flat siblings. A new storage backend joins here and registers on `ctx.sessionPersistence`. See [session persistence](../../docs/rfc/implemented/architecture/2026-06-14-session-persistence.md).
