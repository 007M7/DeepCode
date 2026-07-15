# @deepseek-ai/dsh-token-meter

Replay-aware token measurement through `ctx.tokenMeter`. The service binds one stable meter to each configured model and advances isolated per-model/per-session folds from the durable session log. Compaction consumes it today; other pressure-sensitive plugins can reuse the same accounting without depending on `CompactService`.

## Profiles and configuration

The built-in `deepseek-v4-flash` and `deepseek-v4-pro` profiles each use a 128,000-token context window and four characters per estimated token. `models` merges overrides field-by-field, so changing only density keeps the built-in window. A custom model requires `contextWindow`; its `charsPerToken` defaults to `4`.

| Key | Default | Contract |
|---|---:|---|
| `models.<built-in>.contextWindow` | `128000` | Positive integer provider capacity. |
| `models.<model>.charsPerToken` | `4` | Positive finite heuristic density. |

Resolving an unknown model throws `TokenMeterError` with code `TOKEN_METER_MODEL_UNCONFIGURED` and preserves the exact model name. Direct-construction profile validation uses `TOKEN_METER_INVALID_CONFIG`; Loader mounts first apply the package's Schemastery shape validation. There is no universal fallback window.

## Measurement contract

`ctx.tokenMeter.resolve(model)` returns a `ModelTokenMeter` with three operations:

- `measure(session, requestHeader?)` returns scalar request pressure at one consumed-log revision.
- `measureSurface(session)` returns current surface nodes and their per-node prices at the same kind of revision.
- `estimateMessage(message)` prices one detached message under that profile.

Measurements are detached and deeply immutable. A caller that needs a consistent scalar/surface decision compares their `logRevision` values instead of copying the full history on every read.

The fold tracks request headers and deltas, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and assistant-chunk provenance. Provider usage is reused only when the handle's model and the canonical request envelope match the successful-call anchor. Otherwise the complete current envelope and surface are repriced under the requested model. Surface changes remain signed relative to a matching anchor, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty provenance list means a known empty provider stream, while absent legacy provenance conservatively treats the durable assistant output as provider output.

## Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compact-basic'
```

Both plugins have usable defaults for the bundled DeepSeek profiles. Custom deployments can override only the fields that differ:

```yaml
- name: '@deepseek-ai/dsh-token-meter'
  config:
    models:
      deepseek-v4-flash:
        charsPerToken: 2
      local-model:
        contextWindow: 32768
```

## Model Experience

Indirectly, through consumers such as `dsh-compact-basic`; the service itself adds no prompt, message, schema, tool, or model call.

## Known Limitations and Deferred Work

- **Heuristic density still needs maintenance** — message content without provider usage is priced by configured character density plus structural overhead, not an exact provider tokenizer. CJK-heavy or provider-specific formats may need profile overrides.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, or call-config changes deliberately fall back to full heuristic repricing.
- **Legacy provenance is conservative** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
