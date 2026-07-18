# RFC: Replay token meter service

Status: implemented

English | [中文](2026-07-15-replay-token-meter-service.zh.md)

## Problem

Context pressure is useful outside compaction. A compaction backend, an overflow guard, or a future request-policy plugin can all need the same answer: how much of the configured context window does the durable request consume? Keeping that fold inside `dsh-compact-basic` duplicates replay logic, makes measurement unavailable without compaction, and encourages callers to reuse stale accounting.

Provider usage is not a complete answer. It describes one successful call under one exact request envelope, while the current surface can grow, shrink, or be replaced afterward. Sessions also switch providers and models, old logs can lack chunk provenance, and usage fields separate input, cache-read, cache-write, output, and reasoning counts. A useful service therefore combines the latest exact anchor with conservative heuristic repricing and exposes the log revision consumed by each result.

## Decision

### One concrete LLM-family service

`@deepseek-ai/dsh-token-meter` is one concrete package under `packages/llm/` and registers `ctx.tokenMeter`. It is not split into an interface and backend before a second implementation exists. `TokenMeterService` itself exposes `contextWindow`, `measure(session, requestHeader?)`, and `estimateMessage(message)`; consumers call the singleton service directly.

The service has one `contextWindow`, defaulting to 128,000 tokens and configurable as a positive integer. Estimation uses a fixed four-characters-per-token heuristic plus structural overhead. There are no model profiles, density settings, tokenizer backends, or language-specific strategies.

### Per-session replay folds

Each session owns one isolated incremental fold. Active folds advance from `session/event`; every read catches up through the durable tail, so listener ordering, seeded sessions, and service reload do not change the answer. The fold tracks canonical full request-header snapshots, step boundaries, surface appends and replacements, assistant usage, and assistant-chunk provenance. A malformed next event fails transactionally and remains unread rather than partially mutating state.

`measure(session, requestHeader?)` synchronizes the fold once and returns scalar pressure together with positional per-node prices. `totalTokens` remains request-and-response pressure; `surfaceTokens` is the surface-only heuristic total and equals the sum of `nodes[].tokens`. A `requestHeader` override changes pressure pricing only, while the surface fields always describe the current session. `estimateMessage(message)` applies the fixed heuristic without session state. Each result is one detached, deeply immutable snapshot carrying one `logRevision`. Every measurement clones the current nodes and is therefore O(surface).

Provider usage is reused only when the measured canonical request envelope equals the latest successful-call anchor. Any provider, model, system, prefix, tool, or call-config change causes complete heuristic repricing. Surface changes remain a signed delta from a matching anchor, including negative values after a shrinking replacement. A later successful request replaces the earlier anchor, including across provider or model switches.

Usage sums the disjoint input, cache-read, cache-write, and output buckets. Reasoning is not added a second time. Every successful model call records an `assistant/message`, including content-less and max-token calls, with its exact earlier chunk seqs. An explicit empty provenance list means a known empty provider stream; absent legacy provenance conservatively treats the durable assistant output as provider output.

### Compact-basic consumes, but does not own, measurement

`dsh-compact-basic` requires `ctx.tokenMeter`; `CompactService` gains no token methods or types. The backend is factored into configuration, automatic triggering, region transaction, and summarizer modules, while `summarize()` remains its sole subclass hook. The singleton service consistently prices pressure, retention, shadowed content, provenance, and non-shrinking-summary rejection.

Automatic compaction uses one unified measurement for each threshold-and-retention decision. The region transaction measures after appending its durable `compact/start` lock and again after asynchronous summarization; any intervening durable append changes `logRevision` and prevents replacement.

Compact policy has service-wide defaults: threshold ratio `0.8`, retained tail `floor(contextWindow × 0.16)`, empty summarization provider/model, maximum summary output `8192`, one extra compaction attempt, and automatic triggering enabled. Top-level `thresholdRatio` and `retainTokens` override the pressure policy; retention must remain below the resulting threshold. `summarizationProvider` and `summarizationModel` must both be set or both be empty; an empty pair resolves the latest logged request target, then the `AgentOptions` pair.

The pre-step trigger measures a provisional envelope: the current prompt and prefix override logged values, while the latest logged header supplies provider, model, tools, and other call config. A router-only agent without a complete provider/model pair skips that provisional check because `agent/request` can route later; any routed target can use the singleton estimator.

## Testing

Unit coverage pins service configuration, fixed estimation, envelope invalidation, latest-anchor replacement across provider/model switches, usage and missing-usage paths, seeded append/replace replay, signed deltas, provenance modes, malformed boundaries, unified snapshot detachment and deep immutability, surface-total equality, listener ordering, reload, compact defaults, routing fallback, one-call automatic decisions, retention, convergence, and log-revision rollback. A real Loader/Include YAML fixture loads the exact zero-config token-meter and compact-basic package names in dependency order.

## Alternatives considered

- **Keep estimation inside `CompactService`** — rejected because measurement has consumers and replay semantics independent of compaction; it would also force every compactor to expose the same unrelated API.
- **Split a token-meter interface from a heuristic backend immediately** — rejected because only one implementation exists. One concrete service preserves the future seam without speculative packages or configuration.
- **Keep model-keyed windows and density profiles** — rejected because the deployment currently has one context policy and one estimator. Model registries, unknown-model failures, and configurable density add branches without a second behavior to select.
- **Keep separate scalar and surface measurements** — rejected because callers would need two reads and revision matching for one decision. A scalar-only read could avoid cloning nodes below threshold, but the split API introduces a caller-side race window; the unified snapshot accepts O(surface) cloning in exchange for coherence.
- **Treat provider usage as portable between envelopes** — rejected because model, tools, prefixes, and call config are request facts. Mismatch reprices the whole current request.

## Consequences

- Token pressure has one replay-aware owner that compaction and future plugins can share.
- The default makes the bundled composition usable with two zero-config plugin entries; deployments override one context capacity when needed.
- Fixed heuristic pricing remains an estimate of provider behavior and is not an exact tokenizer or request serializer.
- Every measurement clones the current positional surface and therefore costs O(surface), including pressure checks that finish below threshold.
- Measurements fail loudly on malformed durable boundaries. This turns corrupted replay into a named integration failure instead of silently drifting pressure.
- The pre-step compact integration can skip a router-only first check and can miss tool or routing changes applied later in request middleware.
