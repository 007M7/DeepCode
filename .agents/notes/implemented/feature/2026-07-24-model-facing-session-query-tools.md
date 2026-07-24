# Agent Note: Model-facing session query tools

Status: implemented

English | [中文](2026-07-24-model-facing-session-query-tools.zh.md)

## Problem

The unified `ctx.sessionQuery` service exposes exact reads, filters, relationship traces, and full-text search over live-preferred session logs, but models cannot use that service directly. Giving a model the provider request types would also expose unstable pagination cursors, trusted corpus scope, storage-shaped time values, and result records that are more convenient for programmatic consumers than for reasoning. Large traces and event payloads introduce a separate output-size concern, but solving that concern inside this consumer would duplicate the harness-wide spill mechanism and make session-query tools disagree with other tools.

## Decision

`@deepseek-ai/dsh-tool-session-query` is the model-facing consumer of `ctx.sessionQuery`. It registers five narrow read-only tools: `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read`. The package imports the interface rather than the SQLite implementation, owns model argument validation and readable text rendering, and contributes one concise prompt section that teaches the prior-history search and search-to-trace/read workflow.

`session_search` groups full-text matches by session and exposes typed session and event metadata filters. `session_event_search` searches one session, defaulting to the caller's current session. `session_trace` returns the complete authorized ancestor chain and recursive descendant trees. `session_event_trace` returns every known positional replacement and direct provenance relationship for one event. `session_event_read` returns the exact target event as unabridged JSON and optionally summarizes a bounded raw-event window; omitted `before` and `after` values mean target-only.

Model-facing filters use flat snake-case fields. Timestamps are timezone-qualified ISO 8601 strings at the tool boundary, convert to inclusive epoch-millisecond ranges for the service, and render as UTC ISO 8601. List values are ORed inside one filter while separate filters are ANDed. Parent ids and the root-session marker share one parent clause. Event type strings remain open because `SessionEventMap` is merge-extensible; availability and event surface use closed values.

## Workspace authority

Every executor derives its caller from immutable `ToolExecution.exec.agent` identity and never accepts a model-supplied workspace. A target is authorized only when its observed `cwd` exactly equals the caller session's `cwd`. Cross-session search always adds that workspace filter. Direct operations preflight the target and then validate the header returned from the same service observation as every event-search page, event trace, event read, lineage target, or folded title before rendering its payload. This prevents a live or persisted target replacement between the check and use from crossing the workspace boundary. Lineage rendering stops at an unauthorized ancestor or descendant subtree without revealing the hidden session id. A caller whose session has no `cwd` can inspect only its own session; missing agent identity fails closed.

The search tools expose prior work rather than the operation that is performing the search. `session_search` omits the caller's session. When `session_event_search` targets the caller's session, it intersects the requested sequence range with the event immediately before the current `step/start`, excluding the current assistant message and tool call as well as the query arguments indexed from that call.

## Cursor-free results and spill

Neither search tool exposes a cursor, offset, page size, or model-controlled result limit. One execution follows provider cursors while the observed generation remains valid and collects up to the configured `maxSearchResults`, which defaults to 100. A capped result tells the model to narrow its query or filters; a generation change reports that the whole search must be retried. Search execution carries a configurable `searchTimeoutMs`, defaulting to 30 seconds, through the tool deadline and the service abort signal.

Trace and read tools likewise expose no lineage or character pagination. Canonical results are plain text and remain complete within the service's existing event-window and search-count resource bounds. The generic `tools/post-execute` spill policy owns inline byte retention: when a configured deployment receives oversized text, it replaces that text with a bounded preview plus an opaque locator and retrieval hint while preserving the complete result in its spill store. The session-query consumer neither imports `ctx.spillStore` nor implements a second truncation format.

Session-level results include the latest folded title when available. Each tool execution batches its unique title ids through one live-preferred corpus observation with at most four persisted-inspection workers and passes the exact tool-execution signal through persisted listing and inspection. Live sources fold directly; each persisted worker folds its completed source to a detached header/title observation and releases the full log before dequeuing another id, so the batch retains only small projected values. For the search tools, the execution signal carries the configured search deadline. Cancellation starts no queued title inspections and rejects the complete tool execution after already-started inspections settle; a missing, malformed, or operationally failed title remains isolated to that id, preserves the base result, renders an unavailable marker, and logs the underlying error, while an authorization mismatch fails closed. Search results include the strongest matching event and provider excerpt, traces include complete authorized relationships, and event reads keep neighbor presentation readable while reserving exact JSON for the requested target.

## Host composition

The shipped ACP, TUI, and Web compositions all mount the consumer beside `ctx.sessionQuery`. TUI and Web use their existing timeout and spill policies. ACP mounts the same timeout policy and private local spill backend with the shared 50,000-byte inline threshold, so the five tools have one model-facing contract across hosts. Web also mounts the SQLite query backend at its persistence root; generic tool presentation requires no session-query-specific client plugin.

## Alternatives considered

- **Expose provider cursors to the model** — rejected because recording a tool result or starting the next model step changes the relevant session or global generation, so a cursor is usually stale before the model can reuse it.
- **Add tool-local truncation, offsets, or spill files** — rejected because the post-execute spill policy already owns complete-result retention and retrieval across tools.
- **Allow every persisted session or model-supplied workspace filters** — rejected because `ctx.sessionQuery` is a trusted service and the model-facing consumer must enforce the caller's authority boundary.
- **Combine search, tracing, and exact reads into one operation selector** — rejected because narrow names give the model clearer schemas, defaults, presentation intents, and follow-up choices.
- **Return only one lineage hop** — rejected because spill removes the inline-size motivation while one-hop output would omit relationships with no continuation path.

## Verification

Package tests pin argument validation, filter translation, timestamp normalization, exact-workspace authorization, changed-observation rejection, missing-identity behavior, hidden-boundary pruning, current-step exclusion, internal provider paging, count caps, cancellation, one-scan bounded batch title enrichment, projection-before-dequeue ordering, queued-work suppression, started-worker quiescence, per-header validation, title fallbacks, representative search/trace/read rendering, generic presentation, and disposable registration. Integration coverage uses the real SQLite FTS provider over live and persisted sessions. Loader and assembled-host coverage proves that ACP, TUI, and Web register the tools with timeout and spill support, while keyless assembled ACP snapshots pin the prompt guidance and schemas plus path-independent exact event-read spill and retention behavior.

## Consequences

Models gain provider-independent access to prior session work without receiving storage authority or continuation state. Search has a finite per-call work bound and may require a narrower query to reach matches beyond the first 100; complete traces and event payloads may become spill references instead of inline text. Exact string `cwd` equality favors a conservative security boundary over resolving symlink-equivalent paths. Custom compositions may mount the tool without spill, but then they explicitly accept complete inline trace and read results.
