# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

Replay-aware token measurement through the singleton `ctx.tokenMeter` service. It advances one isolated fold per session from the durable log, so compaction and other pressure-sensitive plugins can share accounting without depending on `CompactService`.

## Configuration

The estimator has no settings. It intentionally uses one fixed heuristic: four characters per token plus structural overhead for roles, blocks, and request-envelope fields. Any key is rejected, including the obsolete global `contextWindow`; model capacity belongs to the adapter that owns an exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`.

## Measurement contract

`ctx.tokenMeter` directly exposes two operations:

- `measure(session, requestHeader?)` returns request pressure and the current priced surface at one consumed-log revision.
- `estimateMessage(message)` prices one message with the fixed heuristic.

`measure()` synchronizes once and returns one detached, deeply immutable snapshot. `totalTokens` is request-and-response pressure, while `surfaceTokens` is the surface-only heuristic total and equals the sum of `nodes[].tokens`. A `requestHeader` override affects pressure fields only; the surface fields still describe the current session. Every call clones the positional nodes, so measurement is O(surface).

The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and assistant-chunk provenance. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full heuristic anchor; a later success replaces the earlier anchor. Otherwise the complete current envelope and surface are estimated. Surface changes remain signed relative to a matching anchor, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty provenance list means a known empty provider stream, while absent legacy provenance conservatively treats the durable assistant output as provider output.

## Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers two units through an optional child fiber.

`tokenUsage` carries the complete durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Usage chunks are counted even when a request later fails; a final assistant-message usage for the same `(turn, step)` replaces that sample instead of double-counting it. Reasoning remains an output subdivision. The single last-sample slot relies on a session-log ordering property: once a later step reports usage, a legal log never reports usage for an earlier step again.

`contextPressure` carries optional `pressureTokens` — the newest provider-reported prompt size, summing uncached input plus cache reads and writes — and optional `contextWindow` from the newest `request/context` record. Pressure stays absent until a provider reports usage; capacity stays absent for a route whose adapter advertises none. Output is excluded, so the numerator holds still while a turn streams and steps forward when the next request reports its usage.

Both units use the standard projection baseline, live frame, higher-seq-wins store, and JSON checkpoint paths. Unloading token-meter removes both keys. A headless or TUI composition without the projection seam keeps the measurement service's existing behavior.

### Context occupancy is an approximation, by design

`pressureTokens` and `contextWindow` are independent last-wins fields and are **not** one atomic observation of a single request. Switching models pairs the fresh capacity with the previous route's pressure until the next request reports usage, and `pressureTokens` describes the last request rather than the surface as it stands right now.

This is deliberate. An occupancy percentage is a user-facing reference figure, not a billing record or a gating input — nothing in the harness makes decisions from it, and compaction reads `measure()` instead. The TUI status line has always computed occupancy the same way, dividing a `measure()` total by a separately-resolved capacity for the selected model.

Making the pair atomic was tried and rejected: it required a transient non-replayable wire frame, which needed lifecycle fencing against cross-stream reordering and left occupancy blank after every reconnect. The [Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) records that comparison. Consumers that need an exact same-boundary figure should call `measure()` at their own request boundary rather than read this projection.

## Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compact-basic'
```

Both plugins have usable defaults. The meter remains independent of model routing and optional compaction. A deployment configures capacity on its LLM adapter and compaction policy on `dsh-compact-basic`.

## Model Experience

Indirectly, through consumers such as `dsh-compact-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The fixed heuristic is approximate** — content without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer.
- **Every measurement clones the current surface** — coherent immutable snapshots make reads O(surface), including below-threshold pressure checks.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation.
- **Legacy provenance is conservative** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
- **The TUI and browser fixture retain parallel folds** — `tokenUsage` owns durable session-projection semantics; the TUI keeps its live per-step map because its composition does not mount the generic projection seam, while the browser fixture mirrors the unit for standalone demo data.
