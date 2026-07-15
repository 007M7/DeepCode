# RFC: Replay token meter service

Status: implemented

English | [中文](2026-07-15-replay-token-meter-service.zh.md)

## Problem

Context pressure is useful outside compaction. A compaction backend, an overflow guard, or a future request-policy plugin can all need the same answer: how much of one model's window does the durable request consume? Keeping that fold inside `dsh-compact-basic` duplicates replay logic, makes measurement unavailable without compaction, and encourages callers to reuse accounting from the wrong model.

Provider usage is not a complete answer. It describes one successful call under one exact request envelope, while the current surface can grow, shrink, or be replaced afterward. Sessions also switch models, old logs can lack chunk provenance, and provider fields separate input, cache-read, cache-write, output, and reasoning counts. A useful service therefore combines exact anchors with conservative model-specific repricing and exposes the log revision consumed by each result.

## Decision

### One concrete LLM-family service

`@deepseek-ai/dsh-token-meter` is one concrete package under `packages/llm/` and registers `ctx.tokenMeter`. It is not split into an interface and backend before a second implementation exists. Its public entry point resolves an exact model name to a stable `ModelTokenMeter`; unknown names throw `TokenMeterError` with `TOKEN_METER_MODEL_UNCONFIGURED` instead of inheriting a universal window.

The built-in `deepseek-v4-flash` and `deepseek-v4-pro` profiles use a 128,000-token context window and four characters per estimated token. `models` overrides merge field-by-field. A custom name requires `contextWindow`, while `charsPerToken` defaults to four. Direct construction reports typed profile errors; Loader mounts first apply the package's Schemastery shape validation.

### Model-bound replay folds

Each model/session pair owns an isolated incremental fold. Active folds advance from `session/event`; every read catches up through the durable tail, so listener ordering, seeded sessions, and service reload do not change the answer. The fold tracks canonical request headers and deltas, step boundaries, surface appends and replacements, assistant usage, and assistant-chunk provenance. A malformed next event fails transactionally and remains unread rather than partially mutating state.

`measure(session, requestHeader?)` returns scalar pressure. `measureSurface(session)` returns positional per-node prices for retention and replacement decisions. `estimateMessage(message)` applies the handle's profile without session state. Results are detached, deeply immutable snapshots carrying `logRevision`; a consumer compares scalar and surface revisions before making one decision.

Provider usage is reused only when the handle's model and canonical request envelope equal the successful-call anchor. Any system, prefix, tool, or call-config change causes complete repricing under the requested model. Surface changes remain a signed delta from a matching anchor, including negative values after a shrinking replacement. A success by another model changes the shared surface but never overwrites this model's anchor.

Usage sums the disjoint input, cache-read, cache-write, and output buckets. Reasoning is not added a second time. Every successful model call records an `assistant/message`, including content-less and max-token calls, with its exact earlier chunk seqs. An explicit empty provenance list means a known empty provider stream; absent legacy provenance conservatively treats the durable assistant output as provider output.

### Compact-basic consumes, but does not own, measurement

`dsh-compact-basic` requires `ctx.tokenMeter`; `CompactService` gains no token methods or types. The backend is factored into configuration, automatic triggering, region transaction, and summarizer modules, while `summarize()` remains its sole subclass hook. The conversation model's meter consistently prices pressure, retention, shadowed content, provenance, and non-shrinking-summary rejection.

Every metered model receives a compact policy with defaults: threshold ratio `0.8`, retained tail `floor(contextWindow × 0.16)`, summarization model `''`, maximum summary output `8192`, one extra pressure-compaction attempt, one context-overflow retry, and automatic triggering enabled. Per-model compact overrides merge `thresholdRatio` and `retainTokens`; retention must remain below the resulting threshold. Empty summarization model resolves the latest logged routed model, then `AgentOptions.model`.

Automatic pressure runs at `agent/post-step` and measures the canonical durable envelope under the model actually selected by `agent/request`. A headerless session has no completed routed request to assess and produces no work; a durable unknown routed model remains an exact typed error. Canonical overflow recovery uses the same meter for forced range selection, and retries only after a proven surface replacement.

## Testing

Unit coverage pins profiles, field-wise overrides, custom and unknown models, envelope invalidation, model switching, usage and missing-usage paths, seeded append/replace replay, signed deltas, provenance modes, malformed boundaries, immutable snapshots, listener ordering, reload, compact defaults, actual routing, retention, convergence, forced overflow, and transaction rollback. A real Loader/Include YAML fixture loads the exact zero-config token-meter and compact-basic package names in dependency order.

## Alternatives considered

- **Keep estimation inside `CompactService`** — rejected because measurement has consumers and replay semantics independent of compaction; it would also force every compactor to expose the same unrelated API.
- **Split a token-meter interface from a heuristic backend immediately** — rejected because only one implementation exists. One concrete service preserves the future seam without speculative packages or configuration.
- **Give unknown models a 128,000-token fallback** — rejected because a plausible but wrong capacity can trigger destructive policy at the wrong point. Unknown routed names fail with their exact name.
- **Copy complete history into each scalar result** — rejected because below-threshold reads are common. Immutable revisioned scalars and a separate surface snapshot preserve consistency without an O(history) copy.
- **Treat provider usage as portable between models or envelopes** — rejected because tokenization, context capacity, tools, prefixes, and call config are model/request facts. Mismatch reprices the whole current request.

## Consequences

- Token pressure has one replay-aware owner that compaction and future plugins can share.
- Defaults make the bundled DeepSeek composition usable with two zero-config plugin entries, while custom models must state the one fact that cannot be guessed safely: context capacity.
- Heuristic density and provider usage remain estimates of provider behavior. Maintainers must update built-in profiles and overflow wording as models evolve.
- Measurements fail loudly on malformed durable boundaries. This turns corrupted replay into a named integration failure instead of silently drifting pressure.
- Post-step pressure reads the exact logged routing/tools/prefix boundary; provider overflow classification remains the adapter-maintained backstop for requests rejected before a successful usage anchor.
