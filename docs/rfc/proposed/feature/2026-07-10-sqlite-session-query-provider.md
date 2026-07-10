# RFC: SQLite FTS5 session-query provider

Status: proposed

## Problem

The provider-neutral session-query service defines full-text scopes and synchronization but deliberately ships no index. A first backend must search semantic event documents across large persisted histories without rebuilding unchanged sessions at every process start, while keeping unflushed live overrides current and disposable. It also needs deterministic ranking and pagination semantics strong enough for model tools and UI clients to continue a result set safely.

Using the canonical session-persistence database directly would couple two failure domains and schemas: query rows are derived and rebuildable, while session logs are authoritative. A query schema reset, corrupt index, or experimental tokenizer must never endanger durable conversation history.

## Proposal

Add an `@deepseek-ai/dsh-session-query-sqlite` implementation in a separate phase-two pull request after the provider-neutral phase is complete. It will register one `SessionSearchProvider` on `ctx.sessionQuery` and own a separate derived SQLite database. Persisted event documents survive provider restarts; live overrides remain connection-local and disappear when the provider closes.

The provider will use SQLite FTS5 with the trigram tokenizer. A query splits on whitespace and requires every term. Terms shorter than three characters fail with a typed provider error rather than silently changing matching semantics. Each searchable event is one document, including current, shadowed, and log-only states by default. Event search ranks documents within one session; session search groups by session and ranks it by exactly one strongest matching event. Ties are deterministic, public hits contain plain-text snippets, and numeric FTS scores remain internal.

## Storage and reconciliation

The database path, journal mode, page/result limits, and snippet length are validated configuration. Durable tables store provider schema version, persisted-session fingerprints, lightweight session metadata, event metadata, text, and the FTS virtual table. A provider-schema mismatch is the exceptional full reset; ordinary startup calls `persistedInventory()` and lets the service replace only new or changed sessions and remove canonical deletions.

The live layer uses temporary or connection-local tables with the same searchable shape. A live snapshot shadows every persisted document for that session. Removing the override reveals the active persisted base. `setPersistedActive(false)` excludes durable rows from results without deleting their fingerprint cache. Reopening the database proves that persisted rows remain and live rows do not.

## Query and cursor semantics

Search request filters compile to parameterized metadata predicates before FTS ranking. Query terms are escaped as data, never interpolated into FTS syntax. Snippets are plain text with bounded length and no provider-specific markup contract.

Opaque cursors bind to the normalized request shape and a generation. Session-search cursors bind to the global logical-corpus generation. Event-search cursors bind only to the target session generation. A relevant change makes the cursor stale and produces a typed error; unrelated session changes do not invalidate an inner-session cursor. Stable tie fields are encoded after rank so resumed pages neither duplicate nor skip hits.

Provider update operations are transactional. An index write failure leaves the prior committed generation queryable only after the owning service has successfully retried the dirty update; affected searches fail rather than returning a knowingly stale page. Abort signals interrupt waits and SQLite query work where the runtime permits.

## Alternatives considered

- **Use the session-persistence SQLite database and add FTS tables there** — rejected because derived-index schema churn, resets, and corruption recovery must not share the authoritative log's transaction or failure boundary.
- **Persist live overrides immediately** — rejected because live events are not canonical until the existing persistence checkpoint commits. Ephemeral overlay rows preserve read-your-writes without inventing a second durability path.
- **Use the default FTS5 unicode tokenizer** — rejected for the first backend because substring-oriented history recall is a core use case. Trigram search gives predictable mid-token matching at the accepted cost of rejecting sub-three-character terms.
- **Return raw BM25 scores** — rejected because scores are provider-specific and unstable across corpus changes. Ranking is observable; numeric scale is not part of the service API.
- **Keep cursors valid across index changes** — rejected because rank and grouping can move after a relevant write, making continued pages duplicate or omit hits.

## Acceptance criteria

- Restart tests prove an unchanged persisted fingerprint performs no FTS replacement, while new, changed, and deleted sessions reconcile correctly.
- Reopening proves persisted rows survive, live rows disappear, removing a live override reveals its persisted base, and the provider works with no persistence service.
- Tests cover both search scopes, all metadata filters, surface defaults, snippets, AND-term escaping, short-term rejection, deterministic ties, pagination, request-bound cursors, scoped stale generations, cancellation, and recovery after a failed index update.
- A provider-schema mismatch resets only the derived database. Normal source changes never trigger a full reset.
- A keyless end-to-end restart test combines a real persistence backend with the real SQLite query provider.
- The implementation, package wiring, and tests land only in the separate phase-two pull request; phase one contains this proposal but no SQLite query code.

## Risks

Trigram indexes use more space than word-token indexes, and loading canonical logs to recompute fingerprints still has startup I/O cost even when FTS replacement is skipped. FTS5 ranking and snippet behavior can differ across SQLite runtime versions, so deterministic tie fields and provider-owned snippet tests must pin only the contract the package controls. A global generation makes cross-session cursors conservative: any corpus change invalidates them. The separate derived database adds configuration and lifecycle work, but it preserves the authoritative store's safety boundary.
