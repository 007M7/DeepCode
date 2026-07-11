# @deepseek-ai/dsh-session-query

Exact session-history retrieval through `ctx.sessionQuery`. The service presents live `ctx.sessions` and an optional, dynamically mounted `ctx.sessionPersistence` as one logical corpus. Matching ids produce one record: live events win, while `live` and `persisted` report both source availabilities. Conflicting immutable headers fail with `SESSION_QUERY_SOURCE_CONFLICT`.

This is trusted context-wide infrastructure. It performs no caller authorization; a future model tool or UI must constrain which sessions its caller may inspect.

## Reads

- `listSessions()` reads current persistence metadata, merges live records with live precedence, and returns cloned records in deterministic newest-first order.
- `listEvents(sessionId)` loads the live-preferred raw log and classifies each event as `current`, `shadowed`, or `log-only` with the shared `dsh-session` surface fold.
- `readEvent(request)` returns a cloned header, the full target event, and a bounded raw-seq window. `before` and `after` default to zero and may not exceed `readWindowMax`.

Persistence is optional and may mount or unmount dynamically. A cross-corpus list fails with `SESSION_QUERY_PERSISTENCE_FAILED` while mounted persistence is unreadable. A read targeting a known live session does not consult persistence, so durable backend health cannot make current in-memory history unreadable. Persisted exact reads list before loading, and reject a metadata mismatch rather than combining inconsistent observations.

`SessionQueryError.code` is a closed union: `SESSION_QUERY_EVENT_NOT_FOUND`, `SESSION_QUERY_INVALID_CONFIG`, `SESSION_QUERY_INVALID_SURFACE`, `SESSION_QUERY_INVALID_WINDOW`, `SESSION_QUERY_PERSISTENCE_FAILED`, `SESSION_QUERY_SESSION_NOT_FOUND`, and `SESSION_QUERY_SOURCE_CONFLICT`.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `readWindowMax` | `50` | Maximum `before` or `after` raw-event count. |

This phase deliberately has no filters, lineage/provenance traversal, extraction registry, search-provider protocol, index synchronization, or model-facing tool. Full-text search belongs beside its first real implementation; the proposed SQLite package and its single transaction/reconciliation owner are described in the [phase-two RFC](../../../docs/rfc/proposed/feature/2026-07-10-sqlite-session-query-provider.md).
