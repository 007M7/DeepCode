# @deepseek-ai/dsh-session-telemetry-otel

[English](README.md) | 中文

[遥测（telemetry）seam](../session-telemetry/) 的 OpenTelemetry 后端，也是部署方唯一要加载的条目。其 `mode` 决定 seam 是立即交接记录、仅在记录反馈时释放记录，还是将遥测留在本地。上传模式会原样组合 OTel JS SDK（`LoggerProvider` → `BatchLogRecordProcessor` → OTLP/HTTP 日志导出器），把每条已交接记录映射到 `logger.emit()`，并使用两个插桩作用域（instrumentation scope）：ledger 记录挂在 `@deepseek-ai/dsh-session-telemetry-otel` 下，运维记录挂在 `@deepseek-ai/dsh-session-telemetry-otel/ops` 下。资源身份（`service.name`/`service.version`）来自 `dsh-llm` 的 `APP_IDENTITY`，与归因标头同源。

## 配置

```yaml
- id: telemetry-otel
  name: '@deepseek-ai/dsh-session-telemetry-otel'
  config:
    mode: FULL                # FULL (default), FEEDBACK_ONLY, or DISABLED
    exporter:                # passed verbatim to the SDK's OTLP/HTTP log exporter
      url: https://collector.example.com/v1/logs
      headers:
        authorization: !!js `Bearer ${process.env.OTLP_TOKEN}`
    processor: {}            # optional; passed verbatim to BatchLogRecordProcessor
```

| `mode` | 行为 |
|---|---|
| `FULL` | 默认值。每条已投影记录都立即交给 OTel SDK，包括生命周期运维记录。 |
| `FEEDBACK_ONLY` | 每个 `feedback/record` 都会释放截至该事件的已脱敏、已投影会话前缀。后续记录等待下一个反馈事件；如果没有后续反馈，则留在本地。 |
| `DISABLED` | 不构造协调器、提供方、处理器或导出器。没有遥测记录会离开进程。`feedback/record` 会记录 `session telemetry is DISABLED; nothing will be shared and this feedback remains local`；该事件留在本地会话日志中。 |

`exporter.url` 在 `FULL` 与 `FEEDBACK_ONLY` 中必填，无默认值，且必须能解析为 `http(s)`；在 `DISABLED` 中可省略且不使用。上传模式也会拒绝不是正整数的 `processor.maxExportBatchSize`，SDK 虽会接受该值，但随后会在关闭时挂起。其余全部是 SDK 自己的选项形态，由 SDK 拥有并在 SDK 文档中说明，两个配置块都整体透传（passthrough）：`OTLPExporterNodeConfigBase` 的每个字段（`headers`、`timeoutMillis`、`compression`、`keepAlive` 等）都会到达导出器；批处理、导出节奏（`scheduledDelayMillis`）、重试、队列上限，以及持续失败下的丢失策略，都是 SDK 的文档化行为，经 `processor` 透传调优。该后端刻意不实现 `flush()`：批处理器是进程内唯一执行 flush 的组件，`shutdown()` 的排空正因如此才是完整的。

## 哪些数据会离开本机

在上传模式中，记录携带完整的 `event.data`，内容以 seam 的 `telemetry/record` waterfall（瀑布式事件）返回的结果为准：用户与 assistant 消息内容、工具参数与工具结果（命令输出、文件内容）、完整的系统提示词与工具 schema（`request/header`）、todo 文本、压缩（compaction）摘要、钩子的 `stderrSummary`、反馈文本，以及会话 `cwd`（一个本地路径）。seam 不带任何脱敏规则：未挂载 `telemetry/record` 监听器时，导出的就是捕获原样的副本，因此向可信边界之外导出的部署方要挂载自己的规则（见 [seam README](../session-telemetry/README.md#the-redact-waterfall)）。无论如何，提供方凭据都不会出现：适配器的 API key 是构造函数参数而非会话事件，因此它们在结构上就不存在于日志中，也就不存在于遥测中。`DISABLED` 不会构造 SDK 流水线，也不会将任何捕获内容交给后端。

## 字段映射

seam 记录 → SDK 日志记录：`time` → `timestamp`/`observedTimestamp`；`severity` → `severityNumber`/`severityText`（INFO 9 / WARN 13 / ERROR 17）；`body` → 结构化日志 body；`attributes` 原样照搬。接收端基于 `(session.id, event.seq)` 去重，并按严重级别告警。在 `FULL` 中，接收端还可通过缺少 `shutdown` 记录检测崩溃：该标记在会话自身 dispose（资源释放）或应用关闭时发出；标记之后出现更多事件，说明遥测发生了重载。在 `FEEDBACK_ONLY` 中，已释放的前缀通常不包含随后的 `shutdown` 标记，因此缺少该标记不是崩溃信号。跨谱系（lineage）的流并不自足：恢复的会话在其自身 id 的流上从上一个进程停止之处继续；fork 出的会话的流从继承边界开始，其前缀位于父会话的流中，由接收端基于 `session.parent_id` + `session.seed_length` 拼接。恢复后的本地日志可能包含从未导出的合成关闭事件；协议流忠实于实际交给 SDK 的记录。

## 模型体验

无。该后端只把 seam 脱敏后的记录转发进 OTel SDK 流水线；它绝不向模型请求贡献任何内容。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **上游实验性源码树**：`@opentelemetry/sdk-logs` 仍从上游实验性（experimental）源码树发布；SDK API 的变动只会落在本包，也仅落在本包；seam 契约不动。
- **无真实 collector 覆盖**：所有测试都导出到本地 mock collector；无密钥的 Loader 组合 e2e（`tests/loader-composition.e2e.ts`）在每次运行中都覆盖协议格式（wire format）形态，而面对真实 OTLP 部署的行为（认证、TLS、限流）属于 SDK 导出器文档的职责范围。
- **仅反馈模式的内存占用**：每个会话都会在内存中保留已深拷贝、已脱敏的投影记录，直到反馈将其释放或会话变得不可达。反馈前不存在持久化 spool；如果在反馈前崩溃，则什么都不上传。
