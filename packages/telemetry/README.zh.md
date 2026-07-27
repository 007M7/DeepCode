# telemetry/

[English](README.md) | 中文

面向外部的会话上报：遥测（telemetry）seam 及其 OpenTelemetry 后端。整套设计归档于[复活 Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md)：边界公理（harness 的职责止于 `emit()`，投递由上报 SDK 负责）、`telemetry/record` waterfall（瀑布式事件；脱敏规则由部署方挂载，seam 自身不带任何规则）、固定分片投影、handoff 游标，以及运维记录通道。

| 包 | 职责 |
|---|---|
| [`@deepseek-ai/dsh-session-telemetry`](session-telemetry/) | seam 本体：捕获点、投影、脱敏、handoff 游标、运维信号，以及最小后端契约（`emit`/`flush?`/`shutdown`）。 |
| [`@deepseek-ai/dsh-session-telemetry-otel`](session-telemetry-otel/) | 部署方要加载的后端：OTel JS SDK 的日志流水线（`LoggerProvider` + `BatchLogRecordProcessor` + OTLP/HTTP 导出器），经透传（passthrough）原样配置。 |
