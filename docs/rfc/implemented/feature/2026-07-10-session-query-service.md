# RFC: Provider-neutral session query service

Status: implemented

## Problem

Session logs contain the harness's durable working memory, but the existing services expose them only as live objects or backend-specific persisted records. Consumers that want history search, compacted-event recall, lineage inspection, or another agent's status otherwise have to choose a storage backend, duplicate live-versus-persisted precedence, and reconstruct surface provenance independently. Live state also advances between persistence checkpoints, so treating durable storage as the only query source makes current-turn reads stale.

Search is only one operation in that read model. Metadata filtering must compose without another database round trip, event and session lineage need deterministic graph semantics, and an event read must return exact canonical content rather than a search snippet. Folding all of those responsibilities into one SQLite package would make storage technology the public API and would prevent live-only deployments from using the non-search capabilities.

## Decision

`@deepseek-ai/dsh-session-query` owns `ctx.sessionQuery`, a trusted provider-neutral read model over one logical corpus: live `SessionStore` entries plus an optional, dynamically mounted `SessionPersistence` service. Matching ids resolve to one record. Live events take precedence because they include appends after the latest checkpoint; the record still exposes independent `live` and `persisted` flags. The service compares immutable headers and fails with a typed source-conflict error when the two sources cannot represent the same session.

The service owns source observation, reconciliation, precedence, cloning, filters, tracing, extraction, and provider selection. It exposes lightweight session and event records, bounded exact-event reads, complete known session lineage, event surface/provenance traces, and two full-text scopes. A search backend owns only indexing, ranking, snippets, cursors, and backend-specific query validation.

Persistence is optional. Live-only reads and provider synchronization work without it. Unmounting persistence hides the provider's durable base rather than deleting derived cache rows, so remounting can reuse fingerprints. An installed but unreadable backend fails cross-session operations; a read of a known live session remains independent of that failure.

## Surface and lineage semantics

`dsh-session` exports `foldSurface(events)`, and `SurfaceManager` uses the same transition functions for its incremental cache. The fold returns detached current nodes and each replacement's actual removed seq range. Session-query derives `current`, `shadowed`, and `log-only` classifications and replacement chains from that result, so query and model-history derivation cannot disagree about positional replacement semantics.

Event traces accept any raw event. They return direct `sourceEventSeqs` references, reverse references, nodes directly shadowed by a replacement, its immediate replacer, and the transitive replacement chain toward the current surface. Related content is deliberately not embedded; exact content remains the job of the bounded event read.

Session traces walk parents nearest-first. A complete chain reports its root; a partial corpus reports the first unresolved parent id. Descendants form a complete known tree ordered by creation time and id. A cycle connected to the target is an invalid lineage error rather than a truncated result.

## Filters and public records

Serializable discriminated filter specs cover session identity, cwd, creation time, parent/root, availability, event seq/time/type, and surface status. Alternatives within one spec are OR; specs in a supplied array are AND. The exported generic transforms are pure, preserve order and item identity, and work on base records or richer hits. Search requests accept the same specs before ranking. Applying a transform to one materialized page never triggers a refill.

Public records are intentionally small. `SessionRecord` carries a cloned header and source flags. `SessionEventRecord` carries session id, seq, type, time, and surface status. Search adds a plain snippet to event hits and exactly one best event to session hits; numeric provider scores remain private. Search pages default to 20 and reject limits above 100. Exact event reads default to no neighbors and cap each side with the configurable `readWindowMax`, default 50.

## Lifecycle notifications

Two observe-only Cordis notifications keep derived read models current without joining the write transaction. `session/removed` fires after a live entry leaves `SessionStore`. `session/persisted` fires only after an ordinary append or load-time repair commits and carries the affected seq range. Both snapshot their payloads and contain synchronous dispatch errors and rejected listeners, so observers cannot fail session teardown or durability.

A persistence load preserves an existing live owner in coordinator state. HMR adoption of a torn durable prefix truncates only the uncommitted fragment while the live session remains authoritative; it does not publish a repair notification or synthesize an interrupted turn mid-turn. A later real append produces the ordinary committed notification.

## Provider and extractor contracts

A selected search provider receives separate persisted-base and live-override operations. Persisted reconciliation begins inactive, compares the provider inventory with SHA-256 fingerprints over canonicalized header/events and relevant extractor versions, replaces only changed sessions, removes proven-stale rows, and then activates the base. Live snapshots always replace the matching override; removal reveals an active persisted base. Search waits for relevant queued reconciliation, with corpus scope for session search and target scope for a live event search. A failed update stays retryable and fails affected searches with a typed derived-index error without affecting canonical writes. Caller cancellation stops waiting and reaches provider query work through `AbortSignal`.

Core extractors cover semantic messages, reasoning, tools, todos, blocked prompts, context and steering, and error/status detail. Chunks, request headers, and structural events add no document. Declaration-merged event and content-block owners can install one effect-scoped extractor per type with a stable version; unknown types stay non-searchable.

## Security boundary

The service is context-wide trusted infrastructure, not an authorization layer. A model-facing history tool or human UI applies explicit caller/session scope before invoking cross-session operations. This decision exposes no unscoped model tool and changes no transcript or snapshot surface.

## Alternatives considered

- **Put all query behavior in a SQLite implementation** — rejected because filters, exact reads, source precedence, lineage, and surface provenance are storage-independent, and live-only deployments still need them. It would also let backend details become the public service contract.
- **Query only persisted sessions** — rejected because persistence checkpoints occur at turn boundaries; a current live session would be stale precisely when an agent inspects its latest work.
- **Mirror every live append into persistence before querying** — rejected because query observation must not add durability latency or change the turn checkpoint contract. The live override is an ephemeral derived layer.
- **Express every chained filter as SQL** — rejected because post-filters operate over already materialized pages and must preserve item identity and caller-chosen composition. Serializable pure transforms also remain usable without a search provider.
- **Make session-query part of the compaction capability** — rejected because retrieval reads all session structure and has consumers beyond recall; compaction is one producer of replacement provenance, not the owner of the read model.

## Consequences

Consumers gain one coherent API for current and durable history, deterministic traces, and backend-neutral search. Derived index failures and optional persistence are isolated from canonical session writes, and unchanged persisted sessions can reuse provider rows across restarts.

The service carries non-trivial reconciliation state and performs canonical log loads to validate fingerprints. Cross-session search intentionally waits for whole-corpus synchronization, and live precedence means providers must implement a two-layer model. Authorization remains the responsibility of future consumers. Full-text search is unavailable until an implementation package registers a provider; that implementation is intentionally outside this decision's package.
