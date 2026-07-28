# Agent Note: Host-owned Web session metrics

Status: implemented

English | [中文](2026-07-28-host-owned-web-session-metrics.zh.md)

## Problem

A Web stats line derived from the currently loaded conversation nodes is window-dependent under pagination. Compaction can replace visible content without preserving historical usage, and route changes leave the browser without an authoritative context capacity. Cache-write tokens also risk being folded into a cache-hit formula whose denominator has different semantics.

## Decision

The Host owns one session-level metrics projection. It incrementally folds the complete durable event log, keys settled usage by `(turn, step)`, and replaces an earlier usage record for the same key instead of double-counting chunk and message forms. Uncached input, output, cache reads, and cache writes remain four disjoint cumulative buckets. Compaction can change the current prompt surface without erasing historical usage.

Current context pressure is a separate point-in-time value from `tokenMeter.measure(session).totalTokens`. Capacity comes only from `llm.resolveModelInfo(provider, model).context.contextWindow` for the agent's selected route. A route change immediately publishes metrics with capacity absent, then publishes the resolved capacity behind a route generation fence; stale metadata cannot label the new route.

The tail `session.history` response carries the projection, while older pages omit it. Live changes use `session/metrics` mux frames. Both forms carry a durable-log revision and a projection revision; the client accepts only nondecreasing revisions, preserves metrics across older-page prepend, and clears them at a new subscription baseline. Missing measurement or metadata stays absent.

The Web stats line treats the projection as its sole token source. It renders uncached input, output, and cache reads separately, computes cache hit as `cacheRead / (uncachedInput + cacheRead)`, and shows current context as a percentage of the exact route capacity. Cache writes never enter that percentage. Visible nodes continue to supply only turn and step counts.

## Alternatives considered

**Fold the loaded node window in React.** This cannot survive pagination or compaction and duplicates durable-log semantics in a presentation package.

**Send usage only with raw assistant events.** Reconnect and older-page stitching would still need the client to reconstruct a full-log aggregate, and duplicate usage forms would need protocol-specific repair there.

**Reuse one total-token field for cache hit.** Cache reads, cache writes, and uncached input represent distinct provider accounting buckets; combining them would make the displayed rate misleading.

**Keep the previous capacity until the new route resolves.** The old number would temporarily claim the wrong selected model. An explicit unknown state is honest and generation-safe.

## Consequences

Token totals remain stable across pagination, replay, compaction, and browser reconnect. The client stores a small detached projection instead of scanning the conversation window, and the status row remains readable for large histories through compact number formatting.

The Host performs one incremental log fold per session and schedules live projection updates only for usage, request-header, or surface-changing events; text and reasoning deltas do not publish metrics. Exact capacity resolution is asynchronous and may briefly render as unknown. Deployments without a token meter or model context metadata retain the row and label the unavailable value instead of fabricating one.
