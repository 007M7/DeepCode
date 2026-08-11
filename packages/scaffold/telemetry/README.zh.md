# `@deepseek-ai/dsh-telemetry`

[English](README.md) | 中文

用于 dsh-sdk 工具链的启动器侧 telemetry 原语。这是启动器在执行每个命令时导入的普通库；它不是 Cordis 插件，因为 `build` 与首次初始化的 `create` 从不启动 Cordis。将 reporter 接入启动器命令分发属于其所在包的职责。

| 导出 | 职责 |
|---|---|
| `SecretRedactor` | 保守的安全后备：在已解析值（`redactValue`）与原始文本（`redactText`）中，将形似密钥的值（疑似密钥的键名、已知 token 格式、PEM 块、URL 凭据、高熵不透明 token）替换为占位符。绝不删除字段或行。 |
| `resolveTelemetryConsent` | 读取共享的 `DSH_TELEMETRY_MODE`；只有 `FULL` 允许启动器上报，`FEEDBACK_ONLY`、`DISABLED`、未设置和空值都会拒绝。 |
| `buildTelemetryPayload` | 组装 `{command, durationMs, success, cordisYmlContent, packageJsonContent}`，对完整的 `cordis.yml` 与 `package.json` 文本运行 redactor。绝不读取 `.env`；发送 `package.json` 的前提是同时存在 `cordis.yml`，因此在非 SDK 目录运行的命令不会上传该目录中无关的 manifest（元数据清单）。 |
| `getOrCreateAnonymousId` | 将随机 UUID 持久化到 [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) 解析出的 harness home（`$DSH_HOME` > `~/.dsh`）；其范围限定为该 home，而不是整台机器，且绝不从 git 派生。 |
| `TelemetryReporter` | 即发即弃发送：`report()` 绝不阻塞或抛出；无论经过哪条路径，发送操作最终都会结束；`flush()` 可以在上限内排空进行中的发送。 |

`DSH_TELEMETRY_MODE` 是会话与启动器 telemetry 的唯一正向授权配置。`FULL` 启用该启动器数据流；`FEEDBACK_ONLY` 保持命令 telemetry 关闭，只允许由反馈触发的 Session Log 共享；其他受支持的状态都会保持该数据流关闭。调用方必须在执行命令前从启动环境解析授权，因为命令可能加载项目 `.env` 或修改 `process.env`；`@deepseek-ai/dsh-scripts` 中的启动器接线会在命令执行前冻结该决定。

收集端点是固定常量（`DSH_TELEMETRY_ENDPOINT`）。

## 模型体验

无。reporter 从启动器发送开发周期 telemetry，绝不会进入模型请求。

#### KV Cache 影响

无；此包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **占位端点**：`DSH_TELEMETRY_ENDPOINT` 指向 `.invalid`，直到设置真实端点。
- **脱敏依赖启发式规则**：这只是保守后备，不是保证；密钥应存放于 `.env`，而该文件绝不会被读取或上报。
