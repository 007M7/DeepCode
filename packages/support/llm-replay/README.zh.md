# @deepseek-ai/dsh-llm-replay

[English](README.md) | 中文

用于无密钥快照测试的回放 LLM 插件。它从已记录的**会话 JSONL** fixture 重建模型流，使测试可以在无 API 密钥的情况下使用固定模型 transcript 启动真实 agent。配置 `providers` 后，它会注册仅回放适配器，其目录可供测试模型发现的场景使用；没有 `providers` 时，它会安装不需要发现的测试所用 catch-all `llm/stream` waterfall。

其消费方是 ACP、headless `stream-json` 和 TUI 快照套件，以及 web 浏览器 e2e lane。Loader 驱动套件使用此插件替换真实 LLM 适配器；web lane 直接安装它，以保留拆卸消费句柄。将派生和回放逻辑保留在此处，可使其受 `packages/*/src` 上每文件 100% 覆盖率门禁约束。

## Fixture 的工作方式

Fixture 就是持久化会话日志（`<scenario>/session.jsonl`）。其 `assistant/chunk` 事件携带每个 `StreamChunk`，因此按 `(turn, step)` 对其分组可重建每次 `stream()` 调用的分片序列（每个 loop 步骤一次模型调用）。因此，录制操作是「运行一次真实 agent 并收集 `.jsonl`」，由快照 harness 完成；该插件不执行录制。Fixture 的 `request/header` 内容可能被 token 化为 `{{system}}`/`{{tools}}`（harness 在一个场景中固定该内容，并擦除其余场景）；回放对此并不关心，因为派生只读取 `assistant/chunk` 事件和第 0 行会话 header。

有两种失败 mode 无法仅从 `assistant/chunk` 重建：在任何分片前纯抛出（例如 HTTP 401，日志只包含 `turn/end {error}` 而没有分片），以及 cancel/hang（是时序，而非分片内容）。需要这些的场景提供可选 sidecar（`<scenario>/replay.override.json`），它要么替换派生脚本（裸 `ReplayEntry[]`），要么增补派生脚本（`{ patches: [{ at, entry }] }`：保留全部由 JSONL 派生的调用，仅在点名的调用索引处换入，索引从 0 计；`at` 等于派生长度时为追加，正是注入的瞬态抛出之后那次重试尝试所占的槽位）。Patch 索引必须互不重复。覆写文档、每个 patch 与每个条目，以及每个分片的判别字段都会在文件加载时接受校验。`hang` 条目可以指定 `readyFile`；在其前缀分片到达 loop 后、等待取消前，回放会写入该空标记，使外部驱动器可以在不观察展示更新的情况下确定性取消。

## 嵌套 agent：每会话键控

父 agent 委托给进程内 subagent 的场景会记录多个日志：父级（`session.jsonl`）和每个子级各一个（`session.1.jsonl`等）。每个 agent 在同一上下文中作为自己的 `Session` 运行，因此回放必须为每个 agent 提供自己的脚本。

回放按调用会话 id 为每次调用建键（由 agent loop 标记的 `GenerateOptions.sessionId`）。实时会话 id 在每次运行中都是新的随机值，绝不等于已记录值，因此实时会话通过**首次调用顺序** 绑定到已记录脚本：脚本按 header `createdAt` 排序（父级在前，因为它必须先进行流式输出才能委托）；第一个进行任何调用的实时会话领取第一个脚本，下一个新会话领取下一个，以此类推。然后，每个会话推进自己的游标。没有 `sessionId` 的调用是绑定到主脚本的单一匿名会话，因此单会话场景与以前完全相同。实时会话数超过已记录脚本数时快速失败。

## 配置

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `file` | string | `$DSH_SNAPSHOT_FILE` | 主（父）`session.jsonl` fixture 的路径。必需（配置或 env）。 |
| `overrideFile` | string | `$DSH_SNAPSHOT_OVERRIDE` | 主会话的可选 `ReplayOverrideDoc` sidecar：裸 `ReplayEntry[]` 替换其派生脚本，`{ patches }` 则按调用索引增补该脚本。 |
| `childFiles` | string[] | `$DSH_SNAPSHOT_CHILD_FILES` (path-delimited) | 嵌套场景中已记录的 subagent 子会话日志；单会话场景为空。 |
| `providers` | `ReplayProviderConfig[]` | 无 | 可选的仅回放提供方和模型目录。每个模型可以发布 `contextWindow`；已配置路由通过回放适配器分派，绝不执行提供方 I/O。 |
| `paceMs` | number | 无（突发） | 可选的每分片毫秒延迟，使下游传输（例如真实浏览器观察的 web SSE mux）看到真正的增量传递。它只是仿真开关，测试不得依赖它保证正确性。值必须是非负整数；pace 等待期间中止会迅速取消流。 |

```yaml
- id: llm-replay
  name: '@deepseek-ai/dsh-llm-replay'
  config:
    providers:
      - id: deepseek
        name: DeepSeek
        models:
          - id: deepseek-v4-flash
            contextWindow: 128000
          - id: deepseek-v4-pro
  # file/overrideFile/childFiles default to $DSH_SNAPSHOT_FILE /
  # $DSH_SNAPSHOT_OVERRIDE / $DSH_SNAPSHOT_CHILD_FILES, set by the snapshot
  # harness per scenario.
```

## 导出项

- `installLlmReplay(ctx, config)`：安装已配置回放适配器或 catch-all `llm/stream` 监听器；返回 `ReplayHandle`（包含用于 HMR 安全的 `dispose()`，以及 `assertConsumed()` 拆卸检查；后者确保每个已记录脚本都绑定到实时会话，且每个已绑定游标都已耗尽，从而将场景静默驱动的模型调用少于记录数转换为明确诊断）。在测试中使用它，可以不通过 Loader 或 env var 驱动回放。
- `loadSessionScripts(config)`：解析场景的有序 `SessionScript[]` （主级 + 子级），准备按首次调用顺序绑定到实时会话。
- `loadReplayScript(config)`：只解析主会话的 `ReplayEntry[]` （如果存在则使用经校验的 sidecar 替换或 patch，否则从 JSONL 派生；fixture 缺失时快速失败）。
- `deriveReplayScript(events)` / `parseSessionLog(text)` / `parseSessionHeader(text)`：将已记录会话日志转换为脚本并读取其 header `id`/`createdAt` 的纯辅助工具。派生分组必须以 `finish` 分片结束；没有该分片的分组是已抛出 `stream()` 的指纹，必须改用 override sidecar 表达。
- 类型 `ReplayEntry` / `ReplayOverrideDoc` / `ReplayOverridePatch` / `SessionScript` / `ReplayConfig` / `ReplayProviderConfig` / `ReplayModelConfig` / `ReplayHandle` / `Config`。

## 插件导出形态

命名导出 `name` / `inject` / `Config` / `apply`，且**没有默认导出**：Cordis Loader 的 `unwrapExports` 执行 `exports.default ?? exports`，因此意外的默认导出会将模块折叠为纯函数，并丢弃 `inject` 命名空间（见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

无。该无密钥测试适配器不向提供方模型发送请求，只将已记录 assistant 分片回放到测试 loop 中。

#### KV 缓存影响

无；该包既不组装也不发送提供方请求。

## 已知限制与待完成工作

- **首次调用顺序脚本绑定假设串行委托**：并发运行同级 subagent 的 cut（或运行中落地的压缩摘要调用）会非确定性地将实时会话绑定到已记录脚本；在这种场景出现前暂不实现更强的键控（`XXX(concurrent-subagents)`）。
- **只有生产分片的调用可派生**：纯分片前抛出或 cancel/hang 场景需要 `replay.override.json` sidecar。替换和 patch 两种形式都只影响主会话；子会话脚本仍从各自日志派生。
