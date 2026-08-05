# 实操手册：扩展插件形态

[English](extension-cookbook.md) | 中文

harness 扩展表面的参考形态。代码片段省略了 import 和辅助实现，无法直接复制运行。具体编写路径见[包检查清单](adding-a-package.md)、[第一个工具教程](../user/develop/basic/tool.md)、[工具参考](adding-a-tool.md)和 [LLM（大语言模型）适配器指南](adding-an-llm-adapter.md)；系统与扩展 seam 映射由[架构文档](../architecture.md)负责。

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

UI 插件从 `session/event` 事件流渲染（助手 token 流以 `assistant/chunk` 形式到达，加上轮次/步骤边界与工具活动），并通过 `agent.followup()` / `agent.steer()` 将输入驱动回去。

```ts
import type { Context } from 'cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
  onUserInput(text => ctx.agents.get(SessionId('client-session'))?.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })))
}
```

## 外部协议驱动

*协议驱动*将协议对端接入 `ctx.agents`；它可以服务于 UI 或自动化客户端。stdio 驱动拥有 stdout，通过工厂创建或恢复 agent（智能体），将协议请求映射为 `followup()` 或 `cancel()`，并根据持久的 `turn/end` 对每个请求恰好结算一次。通过 `AgentHandle.dispose()` 拆除 agent，以使 dispose（资源释放）达到完全停稳。

[`packages/acp/acp`](../../packages/acp/acp) 是仅面向自动化的完整示例：它通过 ACP（Agent Client Protocol）JSON-RPC stdio 提供全新文本会话，发出已提交的助手文本，并为其拥有的 agent 注册一次性机器权限应答器。其 [README](../../packages/acp/acp/README.md) 拥有精确的方法和生命周期契约。

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

可运行叶子从 `examples/*/cordis.yml` 加载各自的插件树；根目录的 `demo:*` 脚本和这些叶子目录是权威清单。非交互式叶子使用 [`@deepseek-ai/dsh-cli-demo`](../../packages/examples/cli-demo)，ACP 叶子使用 [`@deepseek-ai/dsh-acp-demo`](../../packages/examples/acp-demo)，JSON-RPC 叶子使用 [`@deepseek-ai/dsh-jsonrpc-demo`](../../packages/examples/jsonrpc-demo)，应用包共享 [`@deepseek-ai/dsh-agent-spine-demo`](../../packages/examples/agent-spine-demo)。
