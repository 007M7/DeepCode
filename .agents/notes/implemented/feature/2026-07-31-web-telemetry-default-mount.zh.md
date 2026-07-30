# Agent Note: dsh web 组合默认挂载会话遥测（OTel 上报）

Status: implemented

[English](2026-07-31-web-telemetry-default-mount.md) | 中文

## Problem

遥测 seam 与 OTel backend（[revival Note](2026-07-23-session-telemetry-otel-revival.md)）自完成以来从未接入任何部署组合：没有 roster 行、没有开关、没有节奏口径，内部部署对用户会话零可观测。需要一个部署决策：哪些 surface 上报、报到哪、什么节奏、怎么关、CI 怎么隔离。

## Decision

`dsh` 共享核心（`apps/cli/config/base.cordis.yml`）默认挂载 `telemetry-otel` 行，内置生产 endpoint，因此所有 surface——TUI、web、headless——都上报；这是**内部测试期的部署立场**——有 endpoint 就报，用户可经环境变量退出。各 surface 的退出路径都会排空队列：web/headless 在 SIGINT/SIGTERM 上 dispose（headless 的信号处理是本次补上的），TUI 的正常退出走 `disposeRootAndExit`（根 dispose，5s 兜底——高于此处配置的 ~1s drain 上界），其 `/resume` 移交也在 `execve` 前 dispose 根。

| 决策项 | 取值 | 理由 |
|---|---|---|
| 挂载面 | base.cordis.yml（TUI + web + headless） | 所有 surface 一个部署立场；按 surface 分化需要理由，而当前没有 |
| endpoint | `DSH_TELEMETRY_OTLP_URL`，缺省 `https://harness-telemetry.deepseeksvc.com/v1/logs` | 内部 collector；env 覆盖供本地/联调 |
| 退出开关 | `DSH_TELEMETRY_DISABLED` 非空（含 `0`/`false`）即关 | 隐私向开关取「宁关勿误开」；行级 disable 只能在 AppCLIEntry 的 patch 层做（config 无 disable 语义，且必须先于 `exporter.url` 的加载期校验生效） |
| 上报节奏 | `processor.scheduledDelayMillis: 10000`（10s/批） | 流式回流，非退出才报；崩溃至多丢最后一个未导出间隔 |
| 退出 drain 上界 | `exporter.timeoutMillis: 1000` + `maxExportBatchSize: 2048（== maxQueueSize）` + `exportTimeoutMillis: 1500` | collector 不可达时 dispose 必须 ~1s 内放行：timeoutMillis 同时是单次 socket 超时与重试 deadline（1s 等效关掉 SDK 5 次 backoff），批大小对齐队列上限使 drain 恒为单批；默认参数下最坏可卡 40s+ |
| 压缩 | `compression: gzip` | 事件 body 含全文，跨机房带宽 |
| CI 隔离 | 全部 8 个 GitHub workflow 顶层 `env: DSH_TELEMETRY_DISABLED: '1'` | CI 启动 web 组合的所有通道（e2e/snapshot/built smoke）不得向生产 endpoint 泄测试会话 |

集成测试 `apps/cli/tests/telemetry-web.e2e.ts`（keyless）钉住部署级行为：测试内 OTLP collector + mock LLM，真启动 `dsh web`，断言 ledger 覆盖、seq 单调、chunk 首条投影、以及 SIGINT drain 后 ops `shutdown` 标记到达。

## Alternatives considered

**默认不挂载，部署方自行加行（SDK 立场的延续）。** 否决于当前阶段：本仓的 web/headless 组合就是内部部署本身，「上报默认开」是这个部署的产品要求；SDK 立场仍由 seam 包保持（不挂 = 零外发）。

**开关做成 config 字段而非 env patch。** 不可行：cordis 行没有 config 层的 disable 语义，且 `exporter.url` 校验在插件构造期 fail-loud，开关必须在 Loader 之前生效——AppCLIEntry patch 层是唯一落点。

**退出时 `Promise.race` 兜底超时。** 暂缓：参数组合已把最坏 drain 压到 ~1.5-3s（典型 <100ms），实测 SIGINT→退出 110ms-1.1s；drip-feed 慢滴响应的无界等待风险留观，出现实证再在 backend `shutdown()` 内加 race（不放 coordinator——那会替所有 backend 决定丢失语义）。

## Consequences

- 无本地 collector 的开发者跑 `dsh web` 会对生产 endpoint 每 10s 发一次 POST（联不通则静默失败，OTel diag logger 未注册）；本地开发设 `DSH_TELEMETRY_DISABLED=1` 或 `DSH_TELEMETRY_OTLP_URL` 指本地。
- **当前零脱敏规则挂载**：导出即原始捕获副本（用户/助手消息全文、工具参数与结果、system prompt、`session.cwd` 本地路径）。跨信任边界前必须挂 `telemetry/record` 规则——脱敏规则、身份 Resource 维度（hostname/匿名 user id/surface）、使用数据 metrics 轨三件是本决策明确的后续工作。
- 复用这棵树的测试载具（如 `apps/web/tests/scaffold.ts`）须显式关停该行，否则 fixture 会话会流向 env 里碰巧存在的 collector。
