# 实操手册：扩展插件形态

[English](extension-cookbook.md) | 中文

> FIXME：这篇重要指南尚未经过充分的人工设计审查；请在首次发布前完成审查。

针对 harness 扩展表面编写的三种插件形态，以示意性代码片段呈现（省略了 import 和辅助桩——不可直接复制运行）。完整的分步指南见[添加包（package）](adding-a-package.md)、[添加工具](adding-a-tool.md)和[添加 LLM（大语言模型）适配器](adding-an-llm-adapter.md)；这些插件所挂接的 seam 见 [docs/architecture.md](../architecture.md)。

## 工具插件

工具在 `ctx.tools` 上注册。带注解的 `defineTool` 示例（类型化的 `execute` 参数、结果塑形、`run_in_background` 模式）见 [adding-a-tool.md](adding-a-tool.md)——该指南是工具形态的真源。`ctx.tools.register()` 也直接接受原始 JSON-Schema `ToolDefinition`（MCP 来源的工具就是这样到达的）；`defineTool` 是为第一方工具提供的类型化语法糖。

## 钩子插件（以权限门禁为例）

这个权限门禁是钩子插件的一个示例。它从 `tools/pre-execute` 门禁返回一个类型化的决策，用于允许或拒绝一次调用；沙箱、权限和 plan-mode 插件都可以使用该 seam。钩子插件也可以拦截其他 seam，本身并不等同于权限门禁。「原生钩子」是在拦截 seam 上运行的普通 Cordis 插件，不需要外部协议。

```ts
import type { Context } from 'cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

declare function isAllowed(exec: ToolExecution): Promise<boolean>

export const name = 'permission-gate'

export function apply(ctx: Context) {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!(await isAllowed(exec))) {
      return { kind: 'deny', reason: 'Denied by policy.' }
    }
    return next()
  })
}
```

这个 waterfall（瀑布式事件）是可重排的策略层。当不变式需要单调的最终拒绝时使用 `ctx.tools.guard()`；当插件需要包裹实际分发生命周期时（超时/重试/指标；仅 `exec.signal` 可替换）使用 `tools/execute`；显式结果变换使用 `tools/post-execute`；对不可变最终结果的受限观察使用 `tools/result`。选择规则见[添加工具指南](adding-a-tool.md#execution-policy-and-observation)。

## UI 插件

UI 插件从 `session/event` 事件流渲染（助手 token 流以 `assistant/chunk` 形式到达，加上轮次/步骤边界与工具活动），并通过 `agent.send()` / `agent.steer()` 将输入驱动回去。

```ts
import type { Context } from 'cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

declare function render(text: string): void
declare function onUserInput(handler: (text: string) => void): void

export const name = 'my-ui'
export const inject = ['agents']

export function apply(ctx: Context) {
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      render(event.data.chunk.text)
    }
  })
  onUserInput(text => ctx.agents.get(SessionId('client-session'))?.send([{ type: 'text', text }]))
}
```

## 客户端驱动插件（外部协议桥接）

*客户端驱动*是面向协议格式（wire format）对端的 UI 插件。它拥有 stdio，因此必须禁用 stdout 日志；通过工厂创建或恢复 agent（智能体）；将 harness 事件映射为协议消息；将请求映射为 `send()` 或 `cancel()`。每个请求从持久的 `turn/end` 恰好结算一次（即使渲染失败），并通过 `AgentHandle.dispose()` 拆除 agent 以使 dispose（资源释放）达到静止状态。

`packages/ui/acp` 是完整的工作示例：它将 agent 桥接到 ACP（Agent Client Protocol）（基于 stdio 的 JSON-RPC），使 Zed 及其他 ACP 编辑器能够驱动它。其 README 描述了完整的方法接口以及它在审批 seam 上注册的权限提示应答器。

```ts
import type { Context } from 'cordis'

export const name = 'my-protocol-bridge'
export const inject = ['agents', 'sessions', 'sessionPersistence']

export function apply(ctx: Context) {
  // Stream every logged assistant text/reasoning delta out to the client.
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        // sendToClient({ kind: 'message_chunk', text: chunk.text })
      }
    }
  })
  // Inbound "prompt": create/resume an agent and feed it; settle on turn end.
  // Teardown reaches quiescence via AgentHandle.dispose() (stop + await exit).
}
```

## 可运行的组装示例

六个可运行叶子从 `cordis.yml` 加载各自的插件树：[`examples/echo-agent`](../../examples/echo-agent)（mock 模型 + echo 工具，`pnpm run demo:echo`）、[`examples/repl-agent`](../../examples/repl-agent)（DeepSeek V4 + coding 工具，通过面向行的 readline REPL 交互，`pnpm run demo:repl`）、[`examples/tui-agent`](../../examples/tui-agent)（通过全屏 pi-tui 复用相同的 coding 组装，`pnpm run demo:tui`）、[`examples/headless-agent`](../../examples/headless-agent)（同类能力通过单次任务和 DSH 原生输出运行，`pnpm run demo:headless -- "task"`）、[`examples/cordis-agent`](../../examples/cordis-agent)（自我检查和动态插件挂载，`pnpm run demo:cordis`）与 [`examples/acp-agent`](../../examples/acp-agent)（通过 JSON-RPC stdio 暴露的 ACP 服务器，`pnpm run demo:acp`）。终端叶子加载 [`@deepseek-ai/dsh-stdio-demo`](../../packages/examples/stdio-demo)，headless 叶子加载 [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo)，ACP 叶子加载 [`@deepseek-ai/dsh-acp-demo`](../../packages/examples/acp-demo)，三个 app 包都通过 [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo) 共享主干。

## 功能→机制映射

每个产品功能都映射到一个文档化扩展 seam 上的监听器——微内核声明由此可验证（[微内核 Agent Note](../../.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md)）。没有任何一行修改循环本身。

`system-prompt/assemble` 是一个专家协作式的整体装配变换：其返回的装配结果具有权威性，因此监听器作者有责任保留活跃的 Code Mode 和结构化输出协议的贡献。对于需要在展示、查找和执行之间保持对齐的工具过滤，优先使用 `ctx.tools.restrict()`。

| 产品功能 | 插件机制 |
|---|---|
| 钩子系统（用户级 + 项目级） | `agent/session-start`、`agent/prompt-submit`、`agent/request`、`agent/step-result`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-continuation` 上的监听器——每个拦截 waterfall 返回一个类型化 Decision；`dsh-hooks-claude` / `dsh-hooks-codex` 桥接器将钩子配置文件映射到这些 seam 上 |
| `/goal` | 通过 `agent/turn-continuation` 强制继续 + `steer()` 提醒 |
| `/loop` | 在 `turn/end` 会话事件上 `send()` 下一次迭代；或强制继续 |
| 动态工作流 | `ctx.workflows` + worker-thread 引擎 + `workflow` 工具；结构化的进程内子任务通过作用域化的 prompt/工具注册、单调工具守卫、最终 `tools/result` 提交（包括外层 `run_code`）和终端 `agent/turn-stop` 来强制输出 |
| 排队消息 + steering（中途引导） | 核心 `Agent.send()` / `Agent.steer()` |
| 上下文压缩（context compaction）（自动 + 手动） | `ctx.compact` seam + `dsh-compact-basic`；自动压力检查运行在串行 `agent/post-step`，规范化溢出恢复运行在 `agent/request-error`，手动调用方使用同一个压缩服务（[压缩 Agent Note](../../.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.md)——面向模型的 `/compact` 消费方工具已推迟） |
| 系统提示词可配置性 | `ctx.systemPrompt.section()`，支持排序与作用域局部覆盖 |
| AGENTS.md（根目录） | 一个读取该文件的 section provider |
| AGENTS.md（子目录，按需触发）+ 文件变更通知 | 从 watcher / tool-result 监听器调用 `agent.inject()` |
| 内置工具 | `ctx.tools.register()`；schema 自动流入装配——`dsh-tool-*` 系列（bash、fs、web、subagent、todo）是已交付的示例 |
| ToolSearch / 渐进式披露 | 当可见集变化时替换一个作用域化的 `ctx.tools.restrict()` 注册；注册表保持展示、查找和执行三者对齐 |
| 工具截止时间 / 重试 / 指标 | 用 `tools/execute` 包裹核心分发；包装器可替换 `exec.signal`、委托执行，并在同一词法生命周期内检视规范化结果 |
| 最终工具结果指标 / 审计 / 捕获 | 用 `tools/result` 观察不可变的权威结果；仅当插件需要变换结果或附加上下文时才使用 `tools/post-execute` |
| 单调终端轮次策略 | 从串行 `agent/turn-stop` 返回 `{ action: 'stop' }`，此时 continuation 和 steering 已折叠完毕 |
| 子进程沙箱（landlock / sandbox-exec） | 通过 `dsh-bash-sandbox` 使用 `ctx.sandbox` 后端；能力级别的拒绝使用 `tools/pre-execute` |
| 权限系统 / AskUserQuestion | 从 `tools/pre-execute` 返回 `ask` 并通过 `ctx.approval` 应答；为普通用户提问注册一个独立的面向模型的 ask 工具 |
| Plan mode | `tools/pre-execute`（拒绝写操作）+ 通过 `ctx.systemPrompt.section()` 或 `agent.inject()` 注入模式提示词段（model-visible ⟺ logged：`agent/request` 仅塑形调用配置） |
| 子 agent 委派 | `ctx.subagents` 提供方注册表（`dsh-subagent-spawn`/`-fork`/`-acp`）+ `dsh-tool-subagent` 向模型暴露一个已配置的提供方 |
| MCP | 每个服务器一个插件：发现工具 → `ctx.tools.register()` |
| Skill（技能） | section + 工具注册；调用时通过 `inject()` 注入 skill 内容 |
| 记忆 | section provider + 工具 |
| 定时任务（cron） | 插件注册面向模型的调度工具；定时器触发 → 空闲时 `send(…, {source: {kind: 'cron', …}})`／忙碌时 `inject()` 通知 |
| UI（GUI；CLI 输出 JSONL） | 监听 `session/event`（助手分片、边界、工具活动）；输入 → `send()` |
| 遥测 / 可回放 trace | `session/event` → JSONL；回放 = `sessions.create(id, { seed })` |
| 模型适配器 | 通过 `registerAdapter` 注册 `LlmAdapter` 子类（`dsh-llm-deepseek`、`dsh-llm-pi-ai`） |
| 插件热重载 | 每个注册都是一个 `ctx.effect` → vendor 的 HMR（热模块替换）直接生效 |
