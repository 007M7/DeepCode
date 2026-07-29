# @deepseek-ai/dsh-session-telemetry-otel

[English](README.md) | 中文

[遥测（telemetry）seam](../session-telemetry/) 的 OpenTelemetry 后端，也是部署方唯一要加载的条目。它原样组合 OTel JS SDK（`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP 日志导出器），把 seam 交接过来的每条记录映射到 `logger.emit()`，并使用两个插桩作用域（instrumentation scope）：ledger 记录挂在 `@deepseek-ai/dsh-session-telemetry-otel` 下，运维记录挂在 `@deepseek-ai/dsh-session-telemetry-otel/ops` 下。资源身份（`service.name`/`service.version`）来自 `dsh-llm` 的 `APP_IDENTITY`，与归因标头同源。

## 配置

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

`exporter.url` 是本包（package）唯一自行校验的字段：必填、无默认值、必须能解析为 `http(s)`，因此缺失端点会在插件加载时失败（`processor.maxExportBatchSize` 不是正整数时同样如此：SDK 会接受该值，随后却在关闭时因它挂起）。其余全部是 SDK 自己的选项形态，由 SDK 拥有并在 SDK 文档中说明，两个配置块都整体透传（passthrough）：`OTLPExporterNodeConfigBase` 的每个字段（`headers`、`timeoutMillis`、`compression`、`keepAlive` 等）都会到达导出器；批处理、导出节奏（`scheduledDelayMillis`）、重试、队列上限，以及持续失败下的丢失策略，都是 SDK 的文档化行为，经 `processor` 透传调优。该后端刻意不实现 `flush()`：批处理器是进程内唯一执行 flush 的组件，`shutdown()` 的排空正因如此才是完整的。从 `cordis.yml` 中删除该配置块即为退出方式：无残留状态，也没有 `enabled` 开关。

## 哪些数据会离开本机

记录携带完整的 `event.data`，内容以 seam 的 `telemetry/record` waterfall（瀑布式事件）返回的结果为准：用户与 assistant 消息内容、工具参数与工具结果（命令输出、文件内容）、完整的系统提示词与工具 schema（`request/header`）、todo 文本、压缩（compaction）摘要、钩子的 `stderrSummary`，以及会话 `cwd`（一个本地路径）。seam 不带任何脱敏规则：未挂载 `telemetry/record` 监听器时，导出的就是捕获原样的副本，因此向可信边界之外导出的部署方要挂载自己的规则（见 [seam README](../session-telemetry/README.md#the-redact-waterfall)）。无论如何，提供方凭据都不会出现：适配器的 API key 是构造函数参数而非会话事件，因此它们在结构上就不存在于日志中，也就不存在于遥测中。

## 字段映射

seam 记录 → SDK 日志记录：`time` → `timestamp`/`observedTimestamp`；`severity` → `severityNumber`/`severityText`（INFO 9 / WARN 13 / ERROR 17）；`body` → 结构化日志 body；`attributes` 原样照搬。接收端基于 `(session.id, event.seq)` 去重、按严重级别告警，并通过 `shutdown` 记录的缺失检测崩溃（一个曾有活动、没有 `shutdown` 运维记录、且已然陈旧的会话，就是未干净结束的会话）。该标记的含义是遥测干净地停止了对该会话的观察：它在会话自身 dispose（资源释放）时发出，对于届时仍在运行的会话，则在应用关闭时发出；标记之后又出现该会话的更多事件，说明发生的是遥测重载，而不是会话重启。跨谱系（lineage）的流并不自足：恢复的会话在其自身 id 的流上从上一个进程停止之处继续；fork 出的会话，其流从继承边界开始，前缀位于父会话的流中，由接收端基于 `session.parent_id` + `session.seed_length` 拼接。继续而非回放的一个后果：流中一个开启后再未关闭的轮次，标志着上一个进程死在了该轮次之内。恢复时本地日志会以合成的关闭事件修复，但这些修复绝不导出：导出的流忠实于崩溃进程实际发出的内容，其后干净的 `shutdown` 标记也只证明恢复后进程自身的退出。

## 模型体验

无。该后端只把 seam 脱敏后的记录转发进 OTel SDK 流水线；它绝不向模型请求贡献任何内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **上游实验性源码树**：`@opentelemetry/sdk-logs` 仍从上游实验性（experimental）源码树发布；SDK API 的变动只会落在本包，也仅落在本包；seam 契约不动。
- **无真实 collector 覆盖**：所有测试都导出到本地 mock collector；无密钥的 Loader 组合 e2e（`tests/loader-composition.e2e.ts`）在每次运行中都覆盖协议格式（wire format）形态，而面对真实 OTLP 部署的行为（认证、TLS、限流）属于 SDK 导出器文档的职责范围。
