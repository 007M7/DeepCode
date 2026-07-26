# @deepseek-ai/dsh-tui-demo

[English](README.md) | 中文

全屏终端应用组合包：一个 Cordis 插件，组合 [`@deepseek-ai/dsh-agent-spine-demo`](../agent-spine-demo/README.md)、持久的同会话目标、人类命令注册表与 `/goal` 生产方、JSONL 持久化、键盘支持的用户交互、预创建的 `main` agent，以及 [`@deepseek-ai/dsh-tui`](../../ui/tui/README.md)。一份 `cordis.yml` 将它作为单个条目挂载；[`dsh`](../../../apps/cli/README.md) CLI 是启动此类配置的前端入口。

管道、脚本和其他非交互式运行应使用 [`@deepseek-ai/dsh-cli-demo`](../cli-demo/README.md)。此组合包需要一对 TTY，不提供面向行的回退。

## 内置组件

| 插件 | 设置在此处的原因 |
|---|---|
| `@deepseek-ai/dsh-agent-spine-demo` | 共享服务、面向模型的工具，以及一个已配置的 `main` agent |
| `@deepseek-ai/dsh-commands` | 供 TUI 和命令插件消费的纯人类命令发现与分发 |
| `@deepseek-ai/dsh-command-goal` | 直接在主干的持久目标栈上提供 `/goal` 状态与变更 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 位于 `persistenceRoot` 下的持久会话日志 |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 模型请求和顶层工具 effect 前的语义持久性屏障，以及已完成步骤的检查点 |
| `@deepseek-ai/dsh-session-query-sqlite` + `@deepseek-ai/dsh-session-reference` | TUI 消费的组合式精确／FTS 会话查询与有界 `@session` 快照；面向模型的查询工具仍由叶节点选用 |
| `@deepseek-ai/dsh-user-interaction` | 与提供方无关的人类问题服务 |
| `@deepseek-ai/dsh-tui` | 全屏记录、编辑器、工具卡片、计划与问题 overlay |
| `@deepseek-ai/dsh-tool-ask-user` | 面向模型的 `ask_user_question` 工具 |

可替换的 LLM、bash、文件系统和其他能力提供方仍留在叶节点配置中。`@cordisjs/plugin-hmr` 也仍是仅叶节点使用的开发条目，因为它需要 Loader 内部表层。

## 配置

| 键 | 默认值 | 路由目标 |
|---|---|---|
| `provider` | 必填 | 已配置 `main` agent 的提供方 |
| `model` | 必填 | 已配置 `main` agent 的模型 |
| `maxParallelToolCalls` | agent-loop 默认值 | 组合包内循环的并发上限 |
| `persona` | 无 | 系统提示词 persona 模板 |
| `toolOrder` | 字典序 | 显式的面向模型工具顺序 |
| `tools` | 拥有者默认值 | 工具呈现 mode |
| `dshHome` | 拥有者默认值 | bash 与 skill 使用的 Harness 主目录 |
| `sessionTitle` | 主干示例限制 | 后备标题词数／字节限制 |
| `skills` | 拥有者默认值 | Skill 注册表、本地提供方和工具配置 |
| `toolBash` | 拥有者默认值 | 面向模型的 bash 工具配置 |
| `toolTasks` | 拥有者默认值 | 后台任务控制工具配置，或 `false` |
| `goals` | 拥有者默认值 | 持久目标领域与模型工具配置；`false` 会移除目标栈与 `/goal` 生产方 |
| `workspaceContext` | 必填 | Workspace 指令配置，或 `false` |
| `persistenceRoot` | `./.sessions` | JSONL 持久化根目录，以及派生 `session-query.db` 索引的父目录 |
| `persistenceCompression` | `'zstd'` | JSONL 工件编码（`'zstd'` 或原始 `'none'`） |
| `sessionReferences` | 服务默认值 | 路由到 `dsh-session-reference` 的跨会话候选项与快照限制 |
| `welcome` | `ready.` | TUI 副标题 |
| `resumeCommand` | 无 | 退出和无宿主回退的命令模板；选择器本身使用会话查询与宿主移交 |
| `ui` | 拥有者默认值 | 推理、颜色、卡片高度等 TUI 呈现设置 |
| `resumeSessionId` | 无 | 要恢复的确切持久化会话 |

新运行会创建 `main-session-<uuid>` 会话 id，并将它同时传给 TUI 与已配置的 agent。恢复运行会将两个组件都绑定到 `resumeSessionId`。TUI 先于主干挂载，因此它可以渲染匹配的配置启动失败，而不会留下空白终端。应用为 `/resume` 组合持久化和会话查询；嵌入宿主还可以提供 `tuiResumeHost`，以原地移交进程。

## 前端入口

此包不交付 bin。[`dsh`](../../../apps/cli/README.md) CLI 是终端前端入口：裸 `dsh` 启动已交付的 `examples/tui-agent/cordis.yml`（它挂载此组合包），而 `dsh --config <path-to-cordis.yml>` 启动另一个挂载此组合包的叶节点配置。它加载 cwd 下可选的 `.env`，驱动 Cordis Loader，并等待完整插件树。仓库安装了 Loader 的可选原生辅助程序，因此裸包说明符可以在纯 Node 下解析。

## 叶节点示例

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKey: !!js process.env.DEEPSEEK_API_KEY
- id: bash
  name: '@deepseek-ai/dsh-bash-local'
- id: tui-agent
  name: '@deepseek-ai/dsh-tui-demo'
  config:
    provider: deepseek
    model: deepseek-v4-flash
    workspaceContext:
      maxBytes: 65536
    welcome: 'Coding agent ready.'
    ui:
      showReasoning: true
```

## 模型体验

### 交互式终端轮次

#### 模型所见

每次非空、非命令的编辑器提交都会成为用户消息；运行中轮次内的提交成为 steering。斜杠命令输入和输出仍只面向人类，而已接受的 `/goal` 变更会追加领域拥有的模型可见状态。共享主干提供已配置的 persona、workspace 指令、skill 目录、目标控制和可见工具 schema。TUI 渲染本身对模型不可见。

#### Token 影响

用户、assistant 与工具历史按常规会话和压缩规则增长。Header、卡片、计划、Markdown 样式和快捷键不增加 token。

#### KV Cache 影响

只要组合后的提示词、schema、路由和保留历史前缀保持稳定，就只追加。组合变更与压缩可能从第一个变化的 token 起使复用失效。

### 人类问题答案

#### 模型所见

`ask_user_question` 会保留工具调用，以及 `dsh-tool-ask-user` 定义的精简答案或稳定中断错误。问题 overlay 只在终端显示。

#### Token 影响

只有已完成或失败的工具结果会增加保留 token。

#### KV Cache 影响

只追加；答案跟在可复用请求前缀之后。

## 已知限制与延后工作

- **只支持 TTY**：stdin 与 stdout 都必须是终端；自动化使用 `dsh-cli-demo`。
- **一个已配置的终端会话**：记录与编辑器绑定到一个确切会话 id。
- **应用集群固定不变**：JSONL 持久化与 ask-user 工具内置；不同策略需要另一种组合。
- **批准机制独立存在**：此应用回答 `ctx.userInteraction`，而不是 `ctx.approval`；权限提示需要批准服务和回答方。
