# @deepseek-ai/dsh-session-query-sqlite

SQLite FTS5 implementation of `ctx.sessionSearch`. The service searches the live-preferred logical session corpus, groups cross-session results by their strongest event, and keeps provider-specific BM25 scores private.

## Search contract

`searchSessions(request, exec?)` returns `SessionSearchHit` pages across the corpus; `searchEvents(request, exec?)` returns `SessionEventSearchHit` pages within one session. Queries are required, trimmed, whitespace-normalized literal phrases. FTS5 syntax such as quotes, `OR`, `NEAR`, and `*` is treated as data rather than executable MATCH syntax. Metadata filters are parameterized SQL predicates applied before ranking.

Ordering is deterministic: relevance first, then event time, session id where applicable, and seq. Cross-session results expose the selected event as `bestMatch`; both scopes return plain-text snippets bounded in Unicode code points. Cursors are opaque, bind to the normalized request and service instance, and fail when the relevant generation changes. A within-session cursor survives unrelated-session changes; a cross-session cursor does not.

All three surfaces (`current`, `shadowed`, and `log-only`) are searchable by default. Pass a surface filter to narrow them.

## Source and index lifecycle

The service requires `ctx.sessions` and observes optional `ctx.sessionPersistence` dynamically. One serialized state machine observes complete sources, extracts shared semantic documents, reconciles changes transactionally, and runs the query. Stable fingerprints preserve unchanged persisted rows and generations; new, changed, and deleted durable sessions reconcile on the next search. Source or transaction failure commits nothing, and the next search retries.

Persisted FTS rows live in a dedicated derived database. Connection-local TEMP tables hold live rows, which shadow the durable base for the same session and reveal it when the live owner disappears. Unmounting persistence hides durable rows without discarding the cache; remounting reconciles it. Closing or reopening the database drops every live overlay while retaining persisted rows.

The database is disposable but reset is guarded: a recognized incompatible search schema rebuilds in place, while an unrelated or canonical database is refused. Never point `path` at the session-persistence database.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `path` | required | Dedicated derived-index SQLite path; `:memory:` is supported. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist`. |
| `defaultLimit` | `20` | Page size when a request omits `limit`. |
| `maxLimit` | `100` | Largest accepted request page size. |
| `snippetChars` | `240` | Maximum snippet length in Unicode code points. |

## Tokenizer and limits

The index uses FTS5 `unicode61`. In the implementation experiment it supported the two-character query `AI` and produced an index about 2.1× smaller than the trigram alternative. The trade-off is token/phrase recall rather than arbitrary substring recall: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required.

Abort signals stop queued work and caller waits around asynchronous source observation. Node's synchronous `DatabaseSync` API cannot interrupt a MATCH statement already executing on the JavaScript thread; the signal is checked immediately before and after the serialized observation/reconciliation boundary.
