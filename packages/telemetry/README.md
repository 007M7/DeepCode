# telemetry/

English | [中文](README.zh.md)

Outbound session reporting: the telemetry seam plus its OpenTelemetry backend. The design — the boundary axiom (the harness's aspect ends at `emit()`; delivery is the reporting SDK's), the `telemetry/record` waterfall (deployment-mounted redaction rules; the seam ships none), the fixed chunk projection, the handoff cursor, and the operational-record channel — is pinned in [the revival Agent Note](../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md).

| Package | Role |
|---|---|
| [`@deepseek-ai/dsh-session-telemetry`](session-telemetry/) | The seam: capture points, projection, redaction, handoff cursor, ops signals, and the minimal backend contract (`emit`/`flush?`/`shutdown`). |
| [`@deepseek-ai/dsh-session-telemetry-otel`](session-telemetry-otel/) | The backend a deployment loads: the OTel JS SDK's log pipeline (`LoggerProvider` + `BatchLogRecordProcessor` + OTLP/HTTP exporter), configured verbatim through passthroughs. |
