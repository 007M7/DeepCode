# session-query/ — session retrieval capability family

Trusted exact reads and relationship traces over live and durable session logs. The family contains one interface package that owns `ctx.sessionQuery`, logical-corpus precedence, title folding, surface classification, bounded event reads, lineage, and direct event relationships.

| Package | Role | ctx key |
|---|---|---|
| [`session-query/`](session-query/README.md) | Logical-corpus title, event, lineage, and relationship reads | `ctx.sessionQuery` |

The family is independent of compaction: it reads canonical lineage, surface operations, and logged provenance but does not participate in compaction policy or execution. Full-text search remains a proposed SQLite package rather than a speculative provider seam in this interface package.
