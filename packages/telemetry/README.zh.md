# telemetry/：会话遥测能力家族

[English](README.md) | 中文

本家族将会话活动投影为外发遥测，并将投递委派给配置的上报后端。

| 包 | 职责 |
|---|---|
| [`session-telemetry/`](session-telemetry/README.md) | 定义捕获、脱敏、投影和后端投递 |
| [`session-telemetry-otel/`](session-telemetry-otel/README.md) | 通过 OpenTelemetry 日志投递遥测 |

[遥测决策](../../.agents/notes/implemented/feature/2026-07-23-session-telemetry-otel-revival.md)记录了上报边界。
