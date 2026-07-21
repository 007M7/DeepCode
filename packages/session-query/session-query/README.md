# @deepseek-ai/dsh-session-query

Exact session-history retrieval and relationship tracing through `ctx.sessionQuery`. The service presents live `ctx.sessions` and an optional, dynamically mounted `ctx.sessionPersistence` as one logical corpus. Matching ids produce one record: live events win, while `live` and `persisted` report both source availabilities. Conflicting immutable headers fail with `SESSION_QUERY_SOURCE_CONFLICT`.

## Reads

- `listSessions()` reads current persistence metadata, merges live records with live precedence, and returns cloned records in deterministic newest-first order.
- `listEvents(sessionId)` loads the live-preferred raw log and classifies each event as `current`, `shadowed`, or `log-only` with the shared `dsh-session` surface fold.
- `readEvent(request)` returns a cloned header, the full target event, and a bounded raw-seq window. `before` and `after` default to zero and may not exceed `readWindowMax`.
- `traceSession(sessionId)` reads the corpus once and returns immediate-to-outward ancestors plus deterministic recursive descendant trees. `complete: false` identifies the first missing parent; a target-connected cycle fails with `SESSION_QUERY_INVALID_LINEAGE`.
- `traceEvent(request)` loads the logical log once and returns direct positional replacements and direct logged provenance. `replacementChain` follows positional replacers to the final replacement; provenance links remain non-transitive.

Persistence is optional and may mount or unmount dynamically. Cross-corpus listing and lineage tracing fail with `SESSION_QUERY_PERSISTENCE_FAILED` while mounted persistence is unreadable. An event read or trace targeting a known live session does not consult persistence, so durable backend health cannot make current in-memory history unreadable. Persisted event operations list before loading and reject a metadata mismatch rather than combining inconsistent observations.

`listEvents()` and `traceEvent()` run the same one-pass `dsh-session` surface fold. A loaded log is valid only when event seqs are zero-based and contiguous, surface markers obey event-type eligibility, provenance arrays are nonempty and duplicate-free, references name earlier events, and each positional replacement names and cites every surface node it removes; every violation fails with `SESSION_QUERY_INVALID_SURFACE`.

`SessionQueryError.code` is a closed union: `SESSION_QUERY_EVENT_NOT_FOUND`, `SESSION_QUERY_INVALID_CONFIG`, `SESSION_QUERY_INVALID_LINEAGE`, `SESSION_QUERY_INVALID_SURFACE`, `SESSION_QUERY_INVALID_WINDOW`, `SESSION_QUERY_PERSISTENCE_FAILED`, `SESSION_QUERY_SESSION_NOT_FOUND`, and `SESSION_QUERY_SOURCE_CONFLICT`.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `readWindowMax` | `50` | Maximum `before` or `after` raw-event count. |

## Model Experience

None, as this trusted query service returns cloned session records only to its callers and registers no model-facing prompt, schema, tool, or message.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No caller authorization** — this is trusted context-wide infrastructure; a future model tool or UI must constrain which sessions its caller may inspect.
- **No search or extraction** — filters, extraction registry, search-provider protocol, index synchronization, and a model-facing tool are absent. The [tracing decision](../../../.agents/notes/implemented/feature/2026-07-13-session-query-tracing.md) owns relationship semantics; content-bearing full-text-search results and their chainable filters belong beside their first implementation in the proposed [SQLite package](../../../.agents/notes/proposed/feature/2026-07-10-sqlite-session-query-provider.md).
