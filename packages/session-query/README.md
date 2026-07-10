# session-query/ — session retrieval capability family

Trusted read-model infrastructure over live and durable session logs. The interface package owns `ctx.sessionQuery`, logical-corpus resolution, filters, traces, text extractors, and the full-text provider contract. A search backend is a separate implementation package; a model tool or UI remains a separate consumer.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Retrieval service and provider contract | `ctx.sessionQuery` |

The family is independent of the [compaction capability](../compact/README.md): it reads compaction provenance from the canonical session log but does not participate in compaction policy or execution. The provider-neutral decision is recorded in the [session-query RFC](../../docs/rfc/implemented/feature/2026-07-10-session-query-service.md); the first proposed backend is specified separately in the [SQLite provider RFC](../../docs/rfc/proposed/feature/2026-07-10-sqlite-session-query-provider.md).
