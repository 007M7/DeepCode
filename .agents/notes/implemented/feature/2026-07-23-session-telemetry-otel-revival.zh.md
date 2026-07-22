# Agent Note: Session telemetry seam with mandatory redaction and the OTel backend

Status: implemented

[English](2026-07-23-session-telemetry-otel-revival.md) | 中文

## Problem

每个想把 harness 会话接入可观测性体系的部署方都得手写一套会话日志消费端：订阅、生命周期交接、以及最难的脱敏——原始日志携带文件内容与命令输出，可能内嵌凭据。遥测 seam 和 OTel backend 曾在 `session-telemetry-otlp-rfc` 分支（PR #222/#231）上完成过一版，但从未进入 master：该提案将原始会话事件原样导出，法务评审未予通过。捕获侧设计（backend 契约、coordinator、handoff 游标、chunk 投影）本身合理且经过评审；导出侧的立场才是阻塞点。

## Decision

`packages/telemetry/` 以 SDK 立场复活这两个经过评审的包——harness 提供能力，部署方配置上报去向，且任何数据未经脱敏不得跨越 seam：

- **`@deepseek-ai/dsh-session-telemetry`** —— seam 本体。`TelemetryBackend`（`emit`/`flush?`/`shutdown`）、服务注册形态的 `Telemetry`、以及拥有捕获侧的 `TelemetryCoordinator`：带游标回读的收养、逐 append 的 firehose（投影 → `structuredClone` → 脱敏 → `emit`，零 I/O）、固定的每 (turn, step) 首 chunk 投影、`agent/error` 转发、以及 dispose 时的 `shutdown` 记录。
- **`telemetry/redact` waterfall** —— 相对分支版本的增量。每条记录抵达任何 backend 前必经此处；最内层 `next()` 应用保守的内置规则集（凭据形状：API key、GitHub/Slack token、AWS/Google key、JWT、PEM 块、URL userinfo），部署方以监听器堆叠更严规则，抛异常的规则将该记录 fail-closed 扣下。模式列表是安全不变量，刻意不可配置。脱敏只作用于导出副本；canonical log 永不改写。
- **`@deepseek-ai/dsh-session-telemetry-otel`** —— 参考 backend：OTel JS SDK 日志管线（`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP exporter），经 `exporter`/`processor` passthrough 原样配置。`exporter.url` 必填且加载时校验；未挂载或未配置时，任何数据都不会离开进程。

边界公理保持不变：harness 的职责止于 `emit()`。批处理、重试、排队与丢失策略属于 reporting SDK，经 passthrough 配置——投递是尽力而为（崩溃时至多一次），README 对此如实陈述。

## Alternatives considered

**实现 runtime-telemetry RFC 的 outbox（落盘 spool、每 sink 游标、at-least-once、persistence seam 的 `readCommitted` 方法）。** 推迟而非否决：SDK 立场使投递语义归属 reporting SDK，OTel SDK 自身的批处理管线是诚实的默认。outbox 是纯增量层（`emit()` 契约不动）；待某个部署提出遥测必须满足的崩溃丢失要求时再复活。

**不带内置脱敏直接导出，交给接收端 collector processor。** 否决——这正是法务否掉的方案。接收端脱敏是先把秘密发出去再擦除；seam 必须在字节离开进程前擦除，且 waterfall 使脱敏点可审计、可堆叠。

**默认规则的模式列表做成可配置。** 否决：随部署变化的调优项应进 config，但安全不变量不应——削弱底线应当需要改代码而非改 YAML。更严格的规则以 `telemetry/redact` 监听器堆叠。

**映射到 OTel span（GenAI 语义约定）而非日志。** 本次复活否决：分支实现的日志映射已经过评审、形态可交付；span 模型对可 fork、可中断的会话有损，留给将来真正有 span 查询需求的消费者。

## Consequences

部署方在 `cordis.yml` 加一个带 OTLP endpoint 的条目即可把会话流接入任何 OTel 兼容体系；删除条目即退出，无残留状态。即使部署方未配置任何规则，凭据形状的子串也绝不离开进程，代价是捕获路径上每条记录一次同步擦除（对 lossless-JSON body 做字符串正则——受事件大小约束，无 I/O）。导出的 body 在占位符落点处可能与 canonical log 字节不同，接收端不得把遥测当作字节精确副本；日志仍是唯一事实源。崩溃持久性在上述 outbox 决定重启前明确不在范围内。
