# Agent Note: Projected token usage and request context

Status: implemented

English | [中文](2026-07-29-projected-token-usage-and-request-context.zh.md)

## Problem

A Web stats line derived from the currently loaded conversation nodes is window-dependent under pagination. Compaction can replace visible content without preserving historical usage. Conversely, context occupancy describes one real request boundary: a selected model is only an intention, and combining token pressure from one moment with capacity resolved for another route creates a false percentage.

These two values therefore have different lifetimes. Provider-reported billing is durable, replayable session state. Request pressure and registration-bound capacity are an opportunistic live observation that must disappear across a connection generation.

## Decision

`@deepseek-ai/dsh-token-meter` registers the generic `tokenUsage` session projection when `ctx.sessionProjections` is present. The projection folds the complete durable log into uncached input, output, cache-read, and cache-write buckets. An `assistant/chunk` usage sample survives a later failed request; an `assistant/message` usage value replaces the earlier value for the same `(turn, step)` instead of being counted twice. Reasoning tokens remain an output subdivision and are not added again. Compaction and surface replacement do not erase earlier billing.

The projection uses the standard projection lifecycle and wire path. History tail baselines, `session/projection` live frames, higher-seq-wins client storage, JSON checkpoints, cache recovery, and unit unload all remain generic. There is no token-specific history field, mux frame, projector, revision counter, or client fence.

`LlmService.prepareCall()` retains context metadata from the exact lookup that also validates reasoning and captures the adapter registration. After the outer stream call returns its handle and before iteration begins, AgentLoop emits one contained `agent/model-request` notification. Preparation or a synchronous outer waterfall failure emits nothing; short-circuit handles and later iterator construction, iteration, or abort failures still count as an observed request attempt.

ApiProxy handles that notification synchronously. It reads `tokenMeter.measure(agent.session).totalTokens` once when the optional service is present and combines the result with the same prepared call's registration-bound `contextWindow`. It broadcasts one atomic `session/model-request` frame containing the route, turn, step, and whichever of `contextTokens` and `contextWindow` are available. Measurement failure omits only the numerator. The frame goes only to mux connections already open at that instant; history, subscription baselines, reconnect, and restore never replay it.

The client stores the complete latest request frame as `ConversationSnapshot.modelRequest`. Every later frame replaces the entire snapshot, so omitted fields clear earlier values. `SessionManager` temporarily holds a pre-instantiation frame, while a new subscription generation, disconnect, or session removal clears both resident and pending values. Model selection alone does not change this snapshot.

The Web `StatsLine` reads `tokenUsage` through the standard `useProjection` hook and reads request telemetry plus visible nodes through `useSession`. It renders uncached input, output, and cache reads separately, computes cache hit as `cacheRead / (uncachedInput + cacheRead)`, and shows context occupancy only when one request snapshot contains both numerator and capacity. Visible nodes continue to supply only turn and step counts. The existing inline text UI is retained; the model selector gains no circle or other accessory.

## Alternatives considered

**A custom session metrics history field and mux frame.** This duplicated the generic projection protocol, cache, recovery, and seq fencing while coupling durable billing to transient request pressure.

**Fold the loaded node window in React.** This cannot survive pagination or compaction and makes a presentation package reconstruct log semantics.

**Publish usage only with final assistant messages.** A request that reports a usage chunk and then fails would lose provider billing.

**Query capacity from the selected model.** Selection may never produce a request, and a second metadata lookup can disagree with the registration-bound lookup used by the actual call.

**Persist or replay the latest request snapshot.** A request from a prior connection would appear current after restore even though no new request was observed.

**Add a context circle beside the model selector.** That placement suggests selected-model state. The existing stats line expresses the request-scoped semantics without introducing a duplicate UI or data path.

## Consequences

Token totals stay stable across pagination, compaction, replay, and reconnect because they are ordinary durable projection state. Context occupancy is deliberately unknown after reconnect until a new real request is observed. Deployments without token-meter or without model capacity still publish the request route and clear stale optional fields instead of fabricating a percentage.

ApiProxy performs one synchronous optional measurement and one frame conversion per observed request. It owns no per-session metrics cache or refresh queue. The browser keeps one generic projection value plus one small connection-local request snapshot, and streaming text deltas do not force the stats line to recompute.
