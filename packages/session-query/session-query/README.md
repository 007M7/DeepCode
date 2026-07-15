# @deepseek-ai/dsh-session-query

Session-history query contracts and provider-independent helpers. The concrete `ctx.sessionQuery` service presents live `ctx.sessions` and an optional, dynamically mounted `ctx.sessionPersistence` as one logical corpus for exact reads and semantic scans. The abstract `ctx.sessionSearch` service defines full-text search without introducing a provider registry.

## Reads

- `listSessions()` reads current persistence metadata, merges live records with live precedence, and returns cloned records in deterministic newest-first order.
- `filterSessions(filters)` applies provider-independent session metadata and availability predicates to that same cloned logical corpus.
- `listEvents(sessionId)` loads the live-preferred raw log and classifies each event as `current`, `shadowed`, or `log-only` with the shared `dsh-session` surface fold.
- `filterEvents(sessionId, filters)` extracts first-party semantic documents and applies provider-independent metadata and literal-text predicates in ascending seq order.
- `readEvent(request)` returns a cloned header, the full target event, and a bounded raw-seq window. `before` and `after` default to zero and may not exceed `readWindowMax`.

Persistence is optional and may mount or unmount dynamically. A cross-corpus list fails with `SESSION_QUERY_PERSISTENCE_FAILED` while mounted persistence is unreadable. A read targeting a known live session does not consult persistence, so durable backend health cannot make current in-memory history unreadable. Persisted exact reads list before loading, and reject a metadata mismatch rather than combining inconsistent observations.

## Filtering and extraction

`SessionResultFilter` covers id, nullable cwd, created-at range, nullable parent, and source availability. `SessionEventResultFilter` covers seq/time ranges, event type, surface, and semantic text. Filter arrays are ANDed; values within one list clause are ORed. Empty list values match nothing, ranges are inclusive, and malformed ranges or closed-union values fail with `SESSION_QUERY_INVALID_FILTER`.

The text clause is deliberately independent of FTS providers: caller text is escaped into a Unicode, case-insensitive regular expression, and each whitespace run matches one or more whitespace characters. It is a literal semantic-text scan, not a full-text query. `extractSessionEventText()` and `buildSessionEventSearchDocuments()` define the shared first-party document projection; structural boundaries, stream chunks, request headers, and unknown declaration-merged variants produce no document.

## Full-text seam

`SessionSearchService` owns the independent `ctx.sessionSearch` key. `searchSessions(request, exec?)` groups the logical corpus by strongest matching event; `searchEvents(request, exec?)` searches one logical session. Both return pages whose continuation is an owned branded `SessionSearchCursor`, accept optional cancellation, and expose snippets without provider-specific numeric scores. Search requests accept only metadata event filters, because literal-text filtering is the scan path described above.

The package has no provider coordinator or registration protocol. A concrete backend owns observation, reconciliation, ranking, cursor generations, and query execution as one lifecycle; the first implementation is [`@deepseek-ai/dsh-session-query-sqlite`](../session-query-sqlite/README.md).

`SessionQueryError.code` is a closed union covering request validation, missing targets, malformed surfaces, source conflicts, persistence/index failures, cancellation, and invalid or stale cursors; the exact literals are defined in [`src/config.ts`](src/config.ts).

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `readWindowMax` | `50` | Maximum `before` or `after` raw-event count. |

## Model Experience

None, as this trusted query service returns cloned session records only to its callers and registers no model-facing prompt, schema, tool, or message.

## Known Limitations and Deferred Work

- **No caller authorization** — this is trusted context-wide infrastructure; a future model tool or UI must constrain which sessions its caller may inspect.
- **No traversal or provider registry** — lineage/provenance traversal, extractor and search-provider registries, index synchronization, and a model-facing tool are absent. SQLite ownership and tokenizer decisions are recorded in the [implemented search RFC](../../../docs/rfc/implemented/feature/2026-07-10-sqlite-session-query-provider.md).
