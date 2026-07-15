# @deepseek-ai/dsh-session-query-sqlite

SQLite FTS5 implementation of `ctx.sessionSearch`. The service searches the live-preferred logical session corpus and groups cross-session results by their strongest event.

## Search contract

`searchSessions(request, exec?)` returns `SessionSearchHit` pages across the corpus; `searchEvents(request, exec?)` returns `SessionEventSearchHit` pages within one session. Queries are required, trimmed, whitespace-normalized literal phrases. FTS5 syntax such as quotes, `OR`, `NEAR`, and `*` is treated as data rather than executable MATCH syntax. Metadata filters are parameterized SQL predicates applied before ranking.

Relevance is source-comparable across persistent and TEMP tables: actual FTS5 highlighted-match span count descending, then stored document code-point length ascending. Event time, session id where applicable, and seq break remaining ties. Cross-session results expose the selected event as `bestMatch`; both scopes derive whitespace-normalized plain text from FTS5 highlight positions and bound it in Unicode code points. Cursors are opaque branded values, bind to the normalized request and service instance, and fail when the relevant generation changes. A within-session cursor survives unrelated-session changes; a cross-session cursor does not.

All three surfaces (`current`, `shadowed`, and `log-only`) are searchable by default. Pass a surface filter to narrow them.

## Source and index lifecycle

The service requires `ctx.sessions` and observes optional `ctx.sessionPersistence` dynamically. One serialized state machine compares source-qualified lightweight durable snapshot revisions, loads only new or changed logs, extracts shared semantic documents, reconciles changes transactionally, and runs the query. Repeated queries and unchanged same-store reopen load no full durable logs; switching stores, or observing new, changed, deleted, or load-repaired sources, reconciles on the next stable observation. Source or transaction failure commits nothing, and the next search retries.

Persisted FTS rows live in a dedicated derived database. Connection-local TEMP tables hold live rows, which shadow the durable base for the same session and reveal it when the live owner disappears. Unmounting persistence hides durable rows without discarding the cache; remounting reconciles it. Closing or reopening the database drops every live overlay while retaining persisted rows.

The database is disposable but reset is guarded: a recognized incompatible search schema rebuilds in place, while an unrelated or canonical database is refused before mutating journal mode. Never point `path` at the session-persistence database. Exactly one service in one process owns a derived-index path; external writers or a second process are unsupported because generations and TEMP shadow state are connection-owned.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `path` | required | Dedicated derived-index SQLite path; `:memory:` is supported. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`. |
| `defaultLimit` | `20` | Page size when a request omits `limit`. |
| `maxLimit` | `100` | Largest accepted request page size. |
| `snippetChars` | `240` | Maximum snippet length in Unicode code points. |

## Tokenizer and limits

The index uses FTS5 `unicode61`. In the implementation experiment it supported the two-character query `AI` and produced an index about 2.1× smaller than the trigram alternative. The trade-off is token/phrase recall rather than arbitrary substring recall: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required. NUL is rejected in queries; reserved highlight markers and NUL in documents are normalized before indexing so presentation markers cannot collide with source text.

Abort signals stop queued work and caller waits around asynchronous source observation. Node's synchronous `DatabaseSync` API cannot interrupt a MATCH statement already executing on the JavaScript thread; the signal is checked immediately before and after the serialized observation/reconciliation boundary.

## Model Experience

None, as this trusted search backend returns hits only to callers and registers no model-facing prompt, schema, tool, or message.

## Known Limitations and Deferred Work

- **No caller authorization** — this is a trusted context-wide service; a model tool or UI must enforce its own access policy.
- **Synchronous query execution** — `DatabaseSync` blocks the JavaScript thread during MATCH execution and cannot interrupt a statement already running.
- **Token recall, not arbitrary substrings** — the `unicode61` tokenizer does not match substrings inside a larger token; use `filterEvents()` for literal scans.
- **Single-owner derived index** — one service in one process must own each index path; external writers and multi-process sharing are unsupported.
