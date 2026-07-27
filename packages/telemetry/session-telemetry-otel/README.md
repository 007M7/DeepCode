# @deepseek-ai/dsh-session-telemetry-otel

English | [中文](README.zh.md)

The OpenTelemetry backend for [the telemetry seam](../session-telemetry/) — the only entry a deployment loads. It composes the OTel JS SDK as-is (`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP log exporter) and maps each record the seam hands over onto `logger.emit()`, under two instrumentation scopes: ledger records on `@deepseek-ai/dsh-session-telemetry-otel`, operational records on `@deepseek-ai/dsh-session-telemetry-otel/ops`. Resource identity (`service.name`/`service.version`) comes from `dsh-llm`'s `APP_IDENTITY`, the same source the attribution headers use.

## Config

```yaml
- id: telemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; passed verbatim to BatchLogRecordProcessor
```

`exporter.url` is the one field this package validates itself — required, no default, must parse as `http(s)` — so a missing endpoint fails at plugin load (as does a non-positive-integer `processor.maxExportBatchSize`, which the SDK accepts but then hangs on at shutdown). Everything else is the SDK's option shape, owned and documented by the SDK, and both blocks pass through whole: every `OTLPExporterNodeConfigBase` field (`headers`, `timeoutMillis`, `compression`, `keepAlive`, …) reaches the exporter, and batching, export cadence (`scheduledDelayMillis`), retry, queue bounds, and loss policy under sustained failure are the SDK's documented behavior, tuned through the `processor` passthrough. The backend deliberately implements no `flush()`: the batch processor is the only flusher in the process, which is what makes `shutdown()`'s drain complete. Removing this block from `cordis.yml` is the opt-out: no residual state, no `enabled` flag.

## What leaves the machine

Records carry the complete `event.data` as the seam's `telemetry/record` waterfall returns it — user and assistant message content, tool arguments and results (command output, file contents), the full system prompt and tool schemas (`request/header`), todo text, compaction summaries, hook `stderrSummary`, and the session `cwd` (a local path). The seam ships no redaction rules: with no `telemetry/record` listener mounted, that is the raw captured copy, so a deployment exporting beyond a trusted boundary mounts its own rules (see [the seam README](../session-telemetry/README.md#the-redact-waterfall)). Provider credentials never appear regardless: adapter API keys are constructor parameters, not session events, so they are structurally absent from the log and therefore from telemetry.

## Field mapping

Seam record → SDK log record: `time` → `timestamp`/`observedTimestamp`; `severity` → `severityNumber`/`severityText` (INFO 9 / WARN 13 / ERROR 17); `body` → the structured log body; `attributes` verbatim. Receivers dedupe on `(session.id, event.seq)`, alert on severity, and detect crashes by `shutdown`-record absence (a session with activity, no `shutdown` ops record, gone stale ended uncleanly). The marker means telemetry stopped observing the session cleanly — emitted at the session's own disposal, or at application teardown for sessions still running then; a marker followed by more of that session's events is a telemetry reload, not a session restart. Streams are not self-contained across lineage: a resumed session continues its own id's stream from where the previous process left off, and a forked session's stream starts at its inherited boundary — its prefix lives in the parent's stream, stitched via `session.parent_id` + `session.seed_length`. One consequence of continuing rather than replaying: a turn left open mid-stream and never closed marks the previous process dying inside it. The local log is repaired with synthetic closers at resume, but those repairs are never exported — the wire stream stays faithful to what the crashed process actually shipped, and a later clean `shutdown` marker attests only to the resumed process's own exit.

## Model Experience

None, as the backend only forwards the seam's redacted records into the OTel SDK pipeline; it never contributes to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Upstream experimental tree** — `@opentelemetry/sdk-logs` is still published from the upstream experimental tree; SDK API churn lands here and only here — the seam contract does not move.
- **No live-collector coverage** — every test exports to a local mock collector; the keyless Loader-composition e2e (`tests/loader-composition.e2e.ts`) covers the wire shape on every run, and behavior against a real OTLP deployment (auth, TLS, throttling) is the SDK exporter's documented territory.
