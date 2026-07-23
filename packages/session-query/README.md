# session-query/ — session retrieval capability family

Trusted exact reads, relationship traces, provider-independent semantic filtering, and SQLite full-text search over live and durable session logs.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Combined service contract with concrete logical-corpus reads, traces, and semantic filters plus abstract full-text methods | `ctx.sessionQuery` |
| [`session-query-sqlite/`](session-query-sqlite/README.md) | Concrete service backend with SQLite FTS5 persistent bases and live overlays | `ctx.sessionQuery` |

The family is independent of compaction: it reads canonical lineage, surface operations, logged provenance, and semantic event text but does not participate in compaction policy or execution. One abstract service combines every query operation, and one concrete backend owns the full-text lifecycle without a provider registry or coordinator.
