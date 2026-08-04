# @deepseek-ai/dsh-subagent-codex

[English](README.md) | 中文

本包（package）注册固定的 `codex` subagent 提供方。每次接受运行请求后，它都会在发起委托的会话工作区中启动官方 `codex app-server --stdio` 命令，创建一个临时 Codex 线程，提交一个自包含的文本任务，并通过共享的 [`dsh-subagent`](../subagent/README.md) 结果契约仅返回最终答案。

## 启动与所有权

`start(request)` 只接受非空的文本块序列，并根据父会话确定子级 cwd。随后，它通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) spawn 固定命令，依次执行 `initialize` → `initialized` → `thread/start { cwd, ephemeral: true }`，且仅在 Codex 返回有效的临时线程后才发布此次运行。若在发布前发生失败或取消，它会关闭通信链路、终止受管进程树并等待其退出，然后拒绝 `start()` 调用。

已发布的 `run.result` 恰好启动一个轮次。它只接受与此次运行的线程和轮次匹配的通知，随后等待权威的终止通知 `turn/completed`。以最后一条 `phase: "final_answer"` 的 `agentMessage` 为准；若 Codex 没有发出明确的最终阶段，则以最后一条 `phase: null` 的消息作为兼容性回退。过程说明绝不会取代上述任一答案；成功完成的轮次若没有非空白答案，结果也会判为错误。

无人值守的提供方对命令与文件审批答复 `decline`，对权限请求返回作用域限于当前轮次的空权限集，并拒绝 MCP elicitation。其他任何服务器请求都会导致此次运行失败，而不会等待本提供方无法提供的交互。

本地取消会在结果竞态中胜出并映射为 `aborted`；远端轮次若中断或失败，则映射为 `error`。`dispose()` 具有幂等性：如果当前标识符已知，它会尽力请求 `turn/interrupt`，关闭 JSON-RPC 通信链路，结束标准输入，调用共享的进程树逐级终止机制，并等待整棵进程树退出。结果失败与独立的清理失败仍彼此分离。

## 能力与上下文

本提供方不声明任何可选的启动时能力，并报告 `inheritsParentContext: false`。Codex 会接收独立文本任务和父会话 cwd，但不会接收父会话的对话、角色设定、工具筛选器、深度策略或结构化输出契约。临时 Codex 线程 ID 与轮次 ID 仅在此次运行内部可见，绝不会持久化到父会话。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `env` | `{}` | 显式指定的子进程环境，叠加在由子进程 seam 清除凭证后的父环境之上。 |
| `disposeGraceMs` | `3000` | 进程树终止宽限期，须为正有限值，单位为毫秒；最终退出确认的等待时间上限为该值的两倍。 |

生产环境会从 `PATH` 中解析 `codex`，并使用宿主机原生的 Codex 配置与身份验证。本插件不安装 Codex、不选择模型、不创建 `CODEX_HOME`、不执行登录，也不探测版本。子进程 seam 会移除具有凭证特征的环境变量，因此供子进程使用的 API 密钥必须在 `env` 中显式提供；除非被覆盖，`PATH` 和 `HOME` 等普通环境变量值仍然可用。

```yaml
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    env:
      OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY

- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    enableRunInBackground: false
    maxDepth: provider-managed
```

## 产品兼容性与证据

生产环境的协议层有意只实现这一单次执行契约所需的 app-server 方法。开发证据锁定在 `@openai/codex@0.146.0` / `codex-cli 0.146.0`：包测试使用非空的伪密钥，驱动真实二进制程序连接回环 Responses 服务；Loader 快照则锁定模型可见的工具 schema、确切的工具结果、已持久化的父会话、原始子任务、身份验证请求头，以及清理前进程树的完全停稳状态。该 NPM 包仅作为测试依赖；部署环境仍需通过 `PATH` 提供 `codex`。

## 模型体验

### 子任务请求

#### 模型看到的内容

Codex 子任务会在一个全新的临时线程中，以单个轮次接收这些独立文本块。它的工作区是父会话 cwd；其模型、系统指令、工具、沙箱和身份验证来自原生 Codex 安装与配置。

#### 对 token 的影响

子任务需为独立的 Codex 上下文和轮次承担 token 开销。子任务 token 不会进入父级上下文。

#### 对 KV Cache 的影响

这与父请求缓存相互独立。能否复用只取决于 Codex 自身的提供方、模型、指令、工具和临时线程请求。

### 父级工具结果（间接）

#### 模型看到的内容

通过 `dsh-tool-subagent`，父级模型只会看到选定的 Codex 最终答案，或者在结果未完成时看到消费方给出的原样错误。Codex 的过程说明、推理（reasoning）、工具活动、stderr、工作区差异和产品标识符均不会复制到父会话。

#### 对 token 的影响

父级输入只会增加工具结果中保留的最终答案或错误内容。本提供方自身不添加父级工具 schema。

#### 对 KV Cache 的影响

仅追加：新的工具结果接在可复用的父请求前缀之后。

## 已知限制与后续工作

- **每次运行均新建一个进程、一个线程和一个轮次**：不支持续接、恢复、池化、进度流或产品会话持久化。
- **产品安装和账户状态由宿主管理**：`codex` 缺失或不兼容、配置错误或身份验证失败，都会呈现为启动错误或运行错误；本插件不提供安装程序、登录流程或运行时版本门禁。
- **兼容性由开发证据锁定**：若要从已验证的 0.146.0 协议基线升级，必须重新生成上游 schema 证据，并重新运行握手、答案选择、审批、取消和真实产品测试。
- **没有人工审批路径**：已知的无人值守审批请求会被拒绝，未知服务器请求会以默认拒绝方式使运行失败；部署方无法通过本包配置允许策略。
- **仅返回最终文本**：推理、过程说明、中间消息、工具通信、用量信息、stderr 和工作区差异仍只保留在产品内部。
- **没有可选的共享能力**：对于本提供方，共享服务会拒绝输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。
- **没有按实际经过时间触发的超时或副作用回滚**：长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
