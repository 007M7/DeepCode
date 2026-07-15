# session-query/ — session retrieval capability family

Trusted exact reads, provider-independent semantic filtering, and SQLite full-text search over live and durable session logs.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Logical-corpus reads, semantic extraction/filtering, and the abstract search seam | `ctx.sessionQuery`, `ctx.sessionSearch` |
| [`session-query-sqlite/`](session-query-sqlite/README.md) | SQLite FTS5 search with persistent bases and live overlays | `ctx.sessionSearch` |

The family is independent of compaction: it reads the canonical session log but does not participate in compaction policy or execution. Search uses one abstract service and one concrete owner, not a provider registry or coordinator.
