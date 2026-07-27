# Agent Note: Web past-session search

Status: implemented

English | [中文](2026-07-27-web-session-search.zh.md)

## Problem

The Web sidebar exposes session titles and Workspace membership but cannot retrieve a past conversation from words that appear only inside its messages. Scanning histories in the browser would require attaching or loading every session, duplicate the existing indexed-search service, and make cold persisted sessions both slow and easy to omit. The product also needs a predictable failure path: an unavailable derived index must not erase title matches that the client can compute locally.

## Decision

The shared Web/headless composition mounts [`@deepseek-ai/dsh-session-query-sqlite`](../../../../packages/session-query/session-query-sqlite/README.md) with `openAt: first-search` and an in-memory database. The service is ACTIVE at boot, while its `node:sqlite` module and connection-private handle open only on the first content query. This keeps Node 22 startup output free of SQLite's experimental warning before search is used without promising to suppress the warning when search first imports the module. Each service instance owns its index, preserving the SQLite backend's single-owner contract across parallel CLI or Web invocations without leaving process-scoped derived files behind. The database starts empty and lazily reconciles live and persisted sessions on that first query. It remains a disposable derived index, separate from canonical JSONL persistence.

The host gateway exposes `session.search` through the existing typed RPC stack. It derives the authorization set from the same visible summaries as `session.list`, asks `ctx.sessionQuery.searchSessions` for globally ranked current-surface `user/message`, `assistant/message`, and `steering/message` matches in pages capped at 20 hits, and consumes provider pages until it has 20 authorized sessions plus one lookahead or exhausts the stream. Every hit's session id, best-match session id, surface, event type, and snippet type are revalidated before its snippet leaves the Host, and emitted snippets contain at most 240 Unicode code points. Keeping the potentially large authorization set out of SQLite bindings avoids the portable variable ceiling while preserving global ranking. The response remains one bounded page; `hasMore` tells the UI to ask for a narrower query rather than exposing pagination. A stale continuation discards the current attempt's partial results, deduplication entries, and cursors, then restarts from the first page against the original visibility snapshot. Those retries share the limit of 100 provider calls (and therefore at most 2,000 inspected hits); an oversized page, a repeated continuation cursor, or a still-unexhausted stream at that call budget fails closed as an `internal` business error. The carrier signal cancels superseded work, including persistence listing, bounded batches of cold-session metadata stats, and each provider call, and wins over a concurrent stale rejection. A missing query service or an unrecovered indexing/query failure remains a business error and does not mutate the canonical session store.

[`WorkspaceBrowser`](../../../../packages/client/ui-workspace/README.md) keeps metadata and content search deliberately separate. A non-blank query immediately computes case-insensitive title and Workspace substring matches from the Session list, starts a 250 ms debounced content request, aborts the preceding request when the query changes, and ignores stale completions. It merges local matches first in recency order with backend-ranked content-only matches, deduplicates by session id, and renders a flat list regardless of the normal grouping mode. Each row shows the title, Workspace, and an available one-line snippet. Selecting a row opens the Session only and preserves the query; it does not navigate to an exact event.

Content matching inherits the SQLite backend's normalized literal token/phrase semantics. FTS5 operators are inert data, and this surface adds no typo, fuzzy, prefix, or arbitrary-substring expansion. In particular, the `unicode61` tokenizer may treat an uninterrupted Chinese sequence as one token, so a shorter query such as `搜索` is not guaranteed to match inside `会话搜索功能`. Title and Workspace matching remains ordinary client-side substring matching.

## Failure and visibility contract

Search never widens session visibility: cold sessions without a servable cwd are absent for the same reason they are absent from `session.list`, and only provider hits whose ids occur in that baseline can leave the Host. Shadowed and log-only events, tool events outside message content, errors, todos, and other trace records do not produce UI hits.

While the first or a later content request is pending, the UI keeps immediate metadata matches and shows a history-search status. If the backend fails, the same rows remain and a warning explains that content search is unavailable. Zero merged rows produce an explicit empty state. More than 20 candidate rows produce a refine-query hint.

## Alternatives considered

- **Scan every session history in the browser** — rejected because it attaches transport and fold cost to the UI, misses cold logs unless they are loaded, and duplicates the semantic extraction and source reconciliation already owned by `ctx.sessionQuery`.
- **Make trigram or fuzzy search part of the first release** — rejected because it changes index size, ranking, short-query behavior, and product expectations. Trigrams also do not by themselves solve two-character queries. The first release uses the existing backend contract and leaves recall expansion as a separate measured decision.
- **Return event addresses and jump to the exact match** — rejected for this release because conversation virtualization and stable event navigation need a separate UI contract. Session-level navigation is useful without coupling search to that work.
- **Expose cursor pagination in the sidebar** — rejected in favor of a fixed top-20 surface and a narrow-query hint; this keeps the interaction and cancellation state bounded.

## Consequences

Past persisted conversations become discoverable without opening them first, while the host retains one visibility boundary and one semantic-index implementation. Immediate local results hide most request latency, cancellation prevents obsolete queries from repainting the list, and backend failure degrades to the behavior available before content search.

The first content query can take longer because it imports and opens SQLite before paying lazy reconciliation. Search quality is token/phrase recall rather than fuzzy or arbitrary substring recall, including the documented continuous-Chinese limitation. Results are session-level, capped at 20, and have no paging or exact-message navigation. A valid but pathologically unselective or repeatedly stale provider attempt that does not complete within 100 calls takes the metadata-only failure path instead of consuming unbounded work.

## Testing

Host tests pin request validation, visible-session filtering, event/surface filters, result and snippet bounds, the shared provider-call budget, stale-generation restarts, cursor and cross-page deduplication behavior, continuation-page cancellation, and failure mapping. SQLite lifecycle tests pin eager activation, first-search opening and failure, shared readiness, and unopened disposal; a Node 22 compatibility subprocess pins warning-free mount and disposal before the first search. Runtime and UI tests pin stateless delegation, debounce/abort/stale-response behavior, local fallback, merge order, deduplication, row rendering, and navigation semantics. A keyless assembled Web test seeds an unopened persisted conversation, finds it by message content through the lazy SQLite index, captures the sidebar result, opens it, and verifies that the query remains.
