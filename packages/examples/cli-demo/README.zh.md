# @deepseek-ai/dsh-cli-demo

[English](README.md) | 中文

无头单次应用及 bin，用于在没有交互式 UI 或编辑器客户端的情况下运行一项 agent（智能体）任务。它组合 [`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md)、JSONL 持久化，以及恰好一个新建顶层 agent。bin 拥有一个从 idle 到 idle 的活动区间，渲染所选输出，执行 dispose（资源释放）直至完全停稳，然后退出。

该包不挂载 console logger、交互式 UI、用户交互服务或 `ask_user_question` 工具。Stdout 专用于所选输出格式；诊断使用 stderr。

## 配置

| 键 | 默认值 | 路由目标 |
|---|---|---|
| `provider` | 必填 | 已配置 agent 的提供方路由 |
| `model` | 必填 | 已配置 agent 的模型 |
| `maxParallelToolCalls` | agent loop 默认值 | 正整数并发工具调用上限；`1` 表示串行 |
| `persona` | 无 | `dsh-system-prompt` 中的部署 persona |
| `toolOrder` | 字典序 | `dsh-system-prompt` 中显式的面向模型工具顺序 |
| `tools` | `{ mode: 'native' }` | 通过 `dsh-agent-spine-demo` 提供的工具注册表呈现配置 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 向模型 bash 公开并用于本地 skill（技能）发现的 harness 主目录 |
| `sessionTitle` | 主干示例限制 | 通过 `dsh-agent-spine-demo` 提供的后备标题词数／字节限制 |
| `skills` | 拥有者默认值 | skill 注册表、本地提供方和面向模型的 skill 工具 |
| `toolBash` | 拥有者默认值 | 面向模型的 bash 配置，包括此生产方对后台任务的显式启用 |
| `toolTasks` | 拥有者默认值 | 通用 `task_output` 等待边界 |
| `persistenceRoot` | `./.sessions` | JSONL 会话根目录 |
| `persistenceCompression` | `'zstd'` | JSONL 产物编码（`'zstd'` 或原始 `'none'`） |
| `workspaceContext` | 必填 | 工作区指令字节预算，或以 `false` 禁用加载 |

## CLI（命令行界面）契约

```sh
dsh-cli-demo [--config path] [--output-format text|json|stream-json] <task>
```

`--config` 默认为 `./cordis.yml`；`--output-format` 默认为 `text`。必须恰好提供一个非空的任务位置参数，因此含空格的任务需要加引号。`--help` 在不启动的情况下打印用法。不存在 `-p` 或 `--print` 标志。

根 headless-agent 示例提供其叶节点：

```sh
pnpm run demo:headless "inspect the failing test and fix it"
```

loader 配置通过仓库安装的可选原生辅助程序解析裸包说明符，因此根命令不需要特殊 Node 标志。

### 输出格式

- `text` 写入最后一条含文本的 assistant 消息，后跟一个换行符。
- `json` 写入一条 DSH 原生结果记录：`{ type: "result", sessionId, output, usage? }`。`output` 是活动区间内最后提交的 assistant 文本。`usage` 对该区间中的每个模型步骤恰好求和一次，包括产生用量但没有提交 assistant 消息的已计费失败尝试。
- `stream-json` 将顶层会话自有活动区间中的每个规范事件写成 `{ type: "session_event", sessionId, event }`，然后写入同一结果记录。子 agent 活动只通过父工具事件与结果出现。

正常进入 idle 会成功退出，不会为该任务指定轮次原因。参数、启动、观测和持久化失败会让 stdout 保持为空。SIGINT 与 SIGTERM 会取消正在进行的工作，等待 dispose 完成，并分别以 130 和 143 退出。

自有活动会在最终输出前显式刷新。进程退出后，会话日志仍保留在 `persistenceRoot` 下。

## 操作安全

headless-agent 叶节点提供本地 bash、文件系统、skill、subagent、工作流和 todo 能力。因此任务可以修改启动工作区、运行命令、spawn 子 agent，并消耗提供方 token。请从目标项目目录运行 CLI，检查叶节点的能力与沙箱配置，不要把非交互式执行当作批准边界。

## 模型体验

### 单次活动

#### 模型看到的内容

任务位置参数会成为一条用户消息。通过 `dsh-agent-spine-demo`，顶层 agent 还会收到已配置的工作区指令与 persona、skill 目录、可见工具 schema，以及自有活动后续步骤所需的保留工具结果。

#### Token 影响

每个模型步骤中的任务、提示词段、工具 schema、assistant 输出和工具结果都会消耗 token。JSON 事件流式输出和最终渲染不增加模型 token；委派的子工作有自己的模型用量，不计入父结果的 `usage` 总量。

#### KV Cache 影响

只要单次 agent 的提示词、schema、模型路由和会话前缀保持不变，工具轮次历史就仅追加。改变该组合会建立不同的请求前缀；JSON 输出模式不影响缓存。

## 已知限制与暂缓事项

- **每个进程只创建一个新的顶层会话**：其工作区 cwd 是启动目录；此应用不支持恢复、第二条提示词、stdin 上下文或并发顶层会话。
- **没有交互式问题或批准提供方**：需要人工回答的工具无法完成，除非其他叶节点按显式策略组合一个非交互式提供方。
- **流式输出仅限顶层会话**：子会话不会平铺到流中，聚合用量只涵盖父活动区间记录的模型步骤。
