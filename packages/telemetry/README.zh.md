# telemetry/

[English](README.md) | 中文

面向外部的会话上报：遥测（telemetry）seam 及其 OpenTelemetry 后端。边界公理、脱敏 waterfall（瀑布式事件）、固定分片投影、handoff 游标及运维记录通道的决定见[复活 Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md)；即时、反馈门控及禁用投递由[模式决策](../../.agents/notes/implemented/feature/2026-08-05-feedback-gated-session-telemetry.md)统一规定。

| 包（package） | 职责 |
|---|---|
| [`@deepseek-ai/dsh-session-telemetry`](session-telemetry/) | seam 本体：捕获点、投影、脱敏、实时或按需捕获、游标、运维信号，以及最小后端契约（`emit`/`flush?`/`shutdown`）。 |
| [`@deepseek-ai/dsh-session-telemetry-otel`](session-telemetry-otel/) | 部署方要加载的后端：围绕 OTel JS SDK 日志流水线实施 `FULL`、`FEEDBACK_ONLY` 或 `DISABLED` 策略。 |
