# session-query/ — session retrieval capability family

Trusted exact reads over live and durable session logs. Phase one contains one interface package that owns `ctx.sessionQuery`, logical-corpus precedence, surface classification, and bounded event reads.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Logical-corpus and exact-event read service | `ctx.sessionQuery` |

The family is independent of compaction: it reads the canonical session log but does not participate in compaction policy or execution. Full-text search remains proposed as a phase-two SQLite package rather than a speculative provider seam in this interface package.
