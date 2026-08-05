# telemetry/

English | [中文](README.zh.md)

Outbound session reporting: the telemetry seam plus its OpenTelemetry backend. The boundary axiom, redaction waterfall, fixed chunk projection, handoff cursor, and operational-record channel are pinned in [the revival Agent Note](../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md); immediate, feedback-gated, and disabled delivery are owned by [the mode decision](../../.agents/notes/implemented/feature/2026-08-05-feedback-gated-session-telemetry.md).

| Package | Role |
|---|---|
| [`@deepseek-ai/dsh-session-telemetry`](session-telemetry/) | The seam: capture points, projection, redaction, immediate or held handoff, cursor, ops signals, and the minimal backend contract (`emit`/`flush?`/`shutdown`). |
| [`@deepseek-ai/dsh-session-telemetry-otel`](session-telemetry-otel/) | The backend a deployment loads: `FULL`, `FEEDBACK_ONLY`, or `DISABLED` policy around the OTel JS SDK log pipeline. |
