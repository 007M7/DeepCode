# Agent (dsh-agent)

Agent 实例管理和生命周期。

**包名:** `@deepseek-ai/dsh-agent`
**服务名:** `ctx.agents`

## Agent Service

### ctx.agents.create(options)

- **options:** `AgentOptions`
- **返回值:** `Agent`

创建一个新的 Agent 实例。

### ctx.agents.get(id)

- **id:** `AgentId`
- **返回值:** `Agent | undefined`

获取指定 ID 的 Agent 实例。

## AgentOptions

```typescript
interface AgentOptions {
  /** Agent ID（branded） */
  id?: AgentId
  /** 使用的模型名 */
  model: string
  /** 系统提示词（支持 {{model}} 变量） */
  persona?: string
  /** 关联的 session */
  session?: Session
}
```

## Agent 实例

### agent.id

- **类型:** `AgentId`

Agent 的唯一标识符（branded string）。

### agent.model

- **类型:** `string`

Agent 使用的模型名。

### agent.step(input)

- **input:** `ContentBlock[]`
- **返回值:** `Promise<StepResult>`

执行一步：将输入发送给模型，获取响应，执行 tool calls。这是 agent-loop 内部使用的核心方法。

## Agent Loop

Agent 的执行循环由 `dsh-agent-loop` 管理。它：

1. 组装 system prompt + 历史消息 + 当前输入
2. 调用 LLM（通过 `ctx.llm`）
3. 解析响应中的 tool calls
4. 执行 tools
5. 将 tool results 追加到 session
6. 如果 finish reason 是 `tool-calls`，回到步骤 2

### 扩展点

- `agent/pre-step` 事件 — 在每一步 LLM 调用前触发
- `agent/post-step` 事件 — 在每一步完成后触发
- `llm/pre-request` waterfall — 可修改发送给模型的消息

## AgentId

Opaque branded string：

```typescript
import { AgentId } from '@deepseek-ai/dsh-agent'

const id = AgentId('main')
```
