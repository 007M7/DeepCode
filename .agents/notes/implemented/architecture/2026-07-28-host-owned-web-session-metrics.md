# Agent Note: Host-owned Web session metrics

Status: implemented

English | [中文](2026-07-28-host-owned-web-session-metrics.zh.md)

## Problem

A Web stats line derived from the currently loaded conversation nodes is window-dependent under pagination. Compaction can replace visible content without preserving historical usage, while the selected model does not prove that a request used its route or capacity. Cache-write tokens also risk being folded into a cache-hit formula whose denominator has different semantics.

## Decision

The Host owns one session-level metrics projection. It incrementally folds the complete durable event log, keys settled usage by `(turn, step)`, and replaces an earlier usage record for the same key instead of double-counting chunk and message forms. Uncached input, output, cache reads, and cache writes remain four disjoint cumulative buckets. Compaction can change the current prompt surface without erasing historical usage.

Current context pressure is the point-in-time `tokenMeter.measure(session).totalTokens`. Capacity instead belongs to the latest model request attempt observed by the current live mux connection. `LlmService.prepareCall()` retains the context metadata obtained by the exact lookup that also validates reasoning/defaults. After the final provider/model is fixed and the outer `llm/stream` call returns a handle, the loop publishes one contained `agent/model-request` notification. This boundary observes an attempt, not proof of provider I/O: preparation or a synchronous outer waterfall failure emits nothing, while short-circuit handles and later lazy adapter construction, iteration failure, or abort still count.

The tail `session.history` response carries durable usage and pressure, while older pages omit them. Live changes use `session/metrics` mux frames. Both forms carry a durable-log revision and a projection revision; the client accepts only nondecreasing revisions and preserves metrics across older-page prepend.

ApiProxy forwards each notification as a distinct `session/model-request` frame only to mux connections already open when dispatch occurs. It never places the frame in `session.history` or a subscription baseline. The client keeps durable `metrics` and transient `modelRequestContextWindow` as separate snapshot fields, replaces or explicitly clears the capacity on the next observed request, and clears both fields on `session/subscribed`; reconnect, restore, and a new subscription therefore start unknown until another request is observed.

The Web stats line joins the durable projection and live capacity only at presentation. It renders uncached input, output, and cache reads separately, computes cache hit as `cacheRead / (uncachedInput + cacheRead)`, and shows current context as a percentage only when the current connection observed a capacity. Cache writes never enter that percentage. Visible nodes continue to supply only turn and step counts.

## Alternatives considered

**Fold the loaded node window in React.** This cannot survive pagination or compaction and duplicates durable-log semantics in a presentation package.

**Send usage only with raw assistant events.** Reconnect and older-page stitching would still need the client to reconstruct a full-log aggregate, and duplicate usage forms would need protocol-specific repair there.

**Reuse one total-token field for cache hit.** Cache reads, cache writes, and uncached input represent distinct provider accounting buckets; combining them would make the displayed rate misleading.

**Query the selected route before dispatch.** Selection may never produce a request, and a second metadata lookup can race the registration-bound lookup that actually validates and dispatches the call.

**Persist or replay the latest request capacity.** That would make a former request look current on reconnect or restore even though the new connection observed no request. The denominator is deliberately live and opportunistic.

## Consequences

Token totals remain stable across pagination, replay, compaction, and browser reconnect. The client stores a small detached durable projection plus one connection-local denominator instead of scanning the conversation window, and the status row remains readable for large histories through compact number formatting.

The Host performs one incremental log fold per session and schedules durable projection updates only for usage, request-header, or surface-changing events; text and reasoning deltas do not publish metrics. A new connection omits the percentage until it observes a request with context metadata. A later request without metadata clears the denominator, while deployments without a token meter still retain the durable counters and label context unavailable instead of fabricating pressure.
