# 事件系统

事件是 Cordis 插件间通信的核心机制。Harness 大量使用事件来实现松耦合的扩展点。

## 基本用法

### 监听事件

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'event-name'(payload: string): void
  }
}

declare const ctx: Context

ctx.on('event-name', (payload) => {
  // 处理事件
})
```

### 触发事件

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'event-name'(payload: string): void
  }
}

declare const ctx: Context
declare const payload: string

ctx.emit('event-name', payload)
```

## 事件模式

Cordis 提供多种事件触发模式，适用于不同场景：

### emit — 广播

同步依次调用所有监听器，不等待、不关心返回值（监听器如果是 async，其 Promise 被忽略）：

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'my-plugin/turn-end'(agentId: string, turnIndex: number): void
  }
}

declare const ctx: Context
declare const agentId: string
declare const turnIndex: number

// 触发
ctx.emit('my-plugin/turn-end', agentId, turnIndex)

// 监听
ctx.on('my-plugin/turn-end', (agentId, turnIndex) => {
  console.log(`Turn ${turnIndex} ended`)
})
```

### bail — 短路

同步依次调用监听器，第一个返回**非 `undefined`/`null`/`false`** 值的监听器终止链并作为最终值（返回 `undefined`/`null`/`false` 则继续下一个）：

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'some-check'(input: string): string | undefined
  }
}

declare const ctx: Context
declare const input: string
declare function shouldBlock(input: string): boolean

// 触发
const result = ctx.bail('some-check', input)

// 监听（返回值阻止后续监听器）
ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // 返回 undefined 继续传递给下一个监听器
  return undefined
})
```

### serial — 顺序执行

按注册顺序逐个 `await` 监听器，遇到第一个 bail 值（非 `undefined`/`null`/`false`）即停止并返回它；全部返回空值则执行到底。相当于 `bail` 的异步版：

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'setup-phase'(context: object): Promise<void> | void
  }
}

declare const ctx: Context
declare const context: object

await ctx.serial('setup-phase', context)
```

### waterfall — 管道

监听器围绕默认实现层层包裹，形成数据管道。**必须调用 `next()` 委托给下游**，不调用即为否决：

```ts
import type { Context } from 'cordis'
import type { Message } from '@deepseek-ai/dsh-llm'

declare module 'cordis' {
  interface Events {
    'my-plugin/messages'(messages: Message[], next: () => Promise<Message[]>): Promise<Message[]>
  }
}

declare const ctx: Context
declare const messages: Message[]
declare const extraMessage: Message

// 触发：最后一个参数是默认实现（所有监听器都调用 next 时的最终值）
const finalMessages = await ctx.waterfall('my-plugin/messages', messages, async () => messages)

// 监听（必须调用 next）
ctx.on('my-plugin/messages', async (messages, next) => {
  // next() 委托给下游监听器（最终到达默认实现），返回值可以被加工
  const result = await next()
  return [...result, extraMessage]
})
```

::: warning
Waterfall 监听器**必须调用 `next()`**。不调用 `next` 等于否决整个管道，这是故意为之的设计——用于实现拦截/网关逻辑。
:::

## Typed Events

Harness 使用 TypeScript 声明合并来为事件提供类型安全：

```ts
import type {} from 'cordis'

declare module 'cordis' {
  interface Events {
    'my-plugin/ready'(payload: { id: string }): void
    'my-plugin/check'(input: string): boolean | undefined
  }
}

// 现在 ctx.on('my-plugin/ready', ...) 和 ctx.emit('my-plugin/ready', ...)
// 都有正确的类型推导
```

## 命名约定

Harness 事件遵循 `namespace/action` 命名：

```
agent/pre-step       — 每个 step 开始前的检查点（serial）
agent/step-result    — step 的 assistant 消息组装完成（waterfall）
tools/pre-execute    — tool 执行前的允许/拒绝门（waterfall）
tools/post-execute   — tool 执行后的检查/改写缝（waterfall）
llm/stream           — 每次流式模型调用的环绕点（waterfall）
session/event        — 会话事件被记录（emit）
session/flush        — 会话持久化检查点（parallel）
```

完整的事件列表（含每个事件的签名与派发模式）见仓库中的 `docs/cordis-catalog/events.md`。

## 事件也是效果

通过 `ctx.on()` 注册的监听器会在插件卸载时自动移除：

```ts
import type { Context } from 'cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'

declare function handler(agent: Agent, status: AgentStatus): void

export function apply(ctx: Context) {
  // 这个监听器在插件 dispose 时自动清理
  ctx.on('agent/status', handler)
}
```

## 实战示例：日志插件

一个记录所有 tool 调用的简单插件：

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/execute', async (exec, next) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const result = await next()
    const text = result.content
      .map(b => b.type === 'text' ? b.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
    return result
  })
}
```

## 下一步

- [能力三件套](../practice/) — 事件在 capability seam 中的角色
- [LLM 适配器](../practice/llm-adapter) — 实现一个完整的 LLM 后端
