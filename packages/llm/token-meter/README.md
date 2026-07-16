# @deepseek-ai/dsh-token-meter

Replay-aware token measurement through the singleton `ctx.tokenMeter` service. It advances one isolated fold per session from the durable log, so compaction and other pressure-sensitive plugins can share accounting without depending on `CompactService`.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `contextWindow` | `128000` | Positive integer service-wide context capacity. |

The estimator intentionally uses one fixed heuristic: four characters per token plus structural overhead for roles, blocks, and request-envelope fields. `contextWindow` is the only deployment setting. Direct construction validates it; Loader mounts first apply the package's Schemastery shape validation. Unrecognized top-level keys are rejected.

## Measurement contract

`ctx.tokenMeter` directly exposes three operations:

- `measure(session, requestHeader?)` returns scalar request pressure at one consumed-log revision.
- `measureSurface(session)` returns current surface nodes and their per-node prices at the same kind of revision.
- `estimateMessage(message)` prices one message with the fixed heuristic.

Measurements are detached and deeply immutable. A caller that needs a consistent scalar/surface decision compares their `logRevision` values instead of copying the full history on every read.

The fold tracks request headers and deltas, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and assistant-chunk provenance. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope; a later success replaces the earlier anchor. Otherwise the complete current envelope and surface are estimated. Surface changes remain signed relative to a matching anchor, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty provenance list means a known empty provider stream, while absent legacy provenance conservatively treats the durable assistant output as provider output.

## Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compact-basic'
```

Both plugins have usable defaults. A deployment with a different capacity configures the meter once:

```yaml
- name: '@deepseek-ai/dsh-token-meter'
  config:
    contextWindow: 32768
```

## Model Experience

Indirectly, through consumers such as `dsh-compact-basic`; the service itself adds no prompt, message, schema, tool, or model call.

## Known Limitations and Deferred Work

- **The fixed heuristic is approximate** — content without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, model, or call-config changes deliberately fall back to full heuristic estimation.
- **Legacy provenance is conservative** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
