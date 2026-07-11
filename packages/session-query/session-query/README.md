# @deepseek-ai/dsh-session-query

Provider-neutral session-history retrieval (`ctx.sessionQuery`). The service presents live `ctx.sessions` state and, when mounted, `ctx.sessionPersistence` state as one logical corpus. A matching id produces one record: live events win, while independent `live` and `persisted` flags report both source availabilities. Conflicting immutable headers fail with `SESSION_QUERY_SOURCE_CONFLICT` instead of silently merging unrelated histories.

This is trusted context-wide infrastructure. It performs no caller authorization; a future model tool or UI must constrain which sessions its caller may inspect.

## Reads and traces

- `listSessions()` returns cloned lightweight records in deterministic newest-first order.
- `listEvents(sessionId)` classifies each raw event as `current`, `shadowed`, or `log-only` using the shared `dsh-session` surface fold.
- `readEvent(request)` returns the cloned target and a bounded raw-seq window. `before` and `after` default to zero and may not exceed `readWindowMax` (default 50).
- `traceSession(sessionId)` returns nearest-first parents, a known root or explicit unresolved parent id, and the complete deterministic descendant tree. A connected lineage cycle fails with `SESSION_QUERY_INVALID_LINEAGE`.
- `traceEvent(sessionId, seq)` returns direct provenance references and reverse references, direct shadows, the immediate replacer, and the transitive replacement chain toward the current surface node. Related nodes stay seq links; callers use `readEvent()` for content.

An installed persistence backend is optional and may mount or unmount dynamically. Cross-session operations fail with `SESSION_QUERY_PERSISTENCE_FAILED` while installed persistence is unreadable. A read targeting a known live session never depends on persistence health. Provider-side persisted rows are deactivated rather than deleted when persistence is absent.

## Filters

`filterSessionResults()` and `filterEventResults()` are pure generic transforms over records or richer hits. Each discriminated filter is serializable. Values within one filter are OR alternatives; filters in the supplied array are an AND chain. The functions preserve order and item identity and return a fresh array.

Session filters cover id, exact cwd, inclusive creation time, parent id/root, and live/persisted availability. Event filters cover inclusive seq/time, event type, and surface status. Search requests accept the same specs as pre-ranking filters. Applying the pure functions to a materialized provider page is a post-filter: it never fetches replacement hits to refill the page.

## Full-text providers

`registerSearchProvider(provider)` is effect-scoped and ids are unique. Its async disposer removes the provider from selection immediately, lets already accepted transactions finish, and settles after they drain. Without `searchProvider`, exactly one locally available provider must be registered; explicit selection fails loudly when the named provider is missing or unavailable. Search pages default to 20 hits and reject limits above 100; a provider returning more hits than the normalized request limit fails with a typed provider error rather than silently dropping cursor-addressable results. Provider scores never cross the public API: event hits carry a plain snippet, while each session hit carries exactly one best matching event.

The service feeds providers two independent layers: a durable persisted base (`persistedInventory`, `replacePersisted`, `removePersisted`, `setPersistedActive`) and an ephemeral live override (`replaceLive`, `removeLive`). A search waits for the relevant source state observed before its call: the whole corpus for session search, only the target for a live event search. Failed derived updates do not fail session writes; affected searches receive `SESSION_QUERY_INDEX_FAILED`, and a later search retries the dirty state. `AbortSignal` lets a caller stop waiting and is also passed to provider search.

Persisted snapshots carry a SHA-256 fingerprint over canonical header/events plus the versions of relevant extractors. Reconciliation still loads and hashes canonical logs, but a provider replacement occurs only for a new or changed fingerprint; stale durable inventory entries are removed only while persistence is active and authoritative.

Providers receive resolved `SessionSearchSpec` and `SessionEventSearchSpec` values whose `limit` is required after service defaulting and validation. Public service callers use `SessionSearchRequest` and `SessionEventSearchRequest`, where `limit` remains optional.

## Errors

`SessionQueryError.code` is the closed `SessionQueryErrorCode` union: `SESSION_QUERY_ABORTED`, `SESSION_QUERY_DUPLICATE_EXTRACTOR`, `SESSION_QUERY_DUPLICATE_PROVIDER`, `SESSION_QUERY_EVENT_NOT_FOUND`, `SESSION_QUERY_INDEX_FAILED`, `SESSION_QUERY_INVALID_CONFIG`, `SESSION_QUERY_INVALID_EXTRACTOR`, `SESSION_QUERY_INVALID_FILTER`, `SESSION_QUERY_INVALID_LIMIT`, `SESSION_QUERY_INVALID_LINEAGE`, `SESSION_QUERY_INVALID_QUERY`, `SESSION_QUERY_INVALID_SURFACE`, `SESSION_QUERY_INVALID_WINDOW`, `SESSION_QUERY_PERSISTENCE_FAILED`, `SESSION_QUERY_PROVIDER_AMBIGUOUS`, `SESSION_QUERY_PROVIDER_CONFIGURED_MISSING`, `SESSION_QUERY_PROVIDER_CONFIGURED_UNAVAILABLE`, `SESSION_QUERY_PROVIDER_ERROR`, `SESSION_QUERY_PROVIDER_UNAVAILABLE`, `SESSION_QUERY_SESSION_NOT_FOUND`, and `SESSION_QUERY_SOURCE_CONFLICT`.

## Text extractors

Core extraction indexes semantic message text and reasoning, tool names/arguments/results, blocked prompts, context and steering, todos, and error/status detail. Stream chunks, request headers, and structural-only events contribute no document. Unknown event and content-block types contribute no text until their owner registers a versioned extractor with `registerEventTextExtractor()` or `registerContentTextExtractor()`.

Extractor registrations are unique per discriminant and effect-scoped. Their stable versions participate in fingerprints, so changing extraction semantics invalidates only sessions whose indexed source uses that extractor.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `searchProvider` | omitted | Explicit provider id; omission requires exactly one available provider. |
| `defaultLimit` | `20` | Search page size when the request omits `limit`. |
| `maxLimit` | `100` | Maximum accepted search page size; must be at least `defaultLimit`. |
| `readWindowMax` | `50` | Maximum `before` or `after` raw-event count. |

The package ships no full-text backend and no model-facing tool. The proposed SQLite implementation is a later, independent phase described in the [SQLite provider RFC](../../../docs/rfc/proposed/feature/2026-07-10-sqlite-session-query-provider.md).
