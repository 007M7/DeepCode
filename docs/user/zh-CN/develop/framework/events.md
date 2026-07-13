# 事件系统

事件是 Cordis 插件间通信的核心机制。Harness 大量使用事件来实现松耦合的扩展点。

## 基本用法

### 监听事件

```typescript
ctx.on('event-name', (payload) => {
  // 处理事件
})
```

### 触发事件

```typescript
ctx.emit('event-name', payload)
```

## 事件模式

Cordis 提供多种事件触发模式，适用于不同场景：

### emit — 广播

所有监听器并行执行，不关心返回值：

```typescript
// 触发
ctx.emit('agent/turn-end', { agentId, turnIndex })

// 监听
ctx.on('agent/turn-end', ({ agentId, turnIndex }) => {
  console.log(`Turn ${turnIndex} ended`)
})
```

### bail — 短路

依次调用监听器，第一个返回非 `undefined` 值的结果作为最终值：

```typescript
// 触发
const result = ctx.bail('some-check', input)

// 监听（返回值阻止后续监听器）
ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // 返回 undefined 继续传递给下一个监听器
})
```

### serial — 顺序执行

所有监听器按注册顺序依次执行（异步安全）：

```typescript
await ctx.serial('setup-phase', context)
```

### waterfall — 管道

每个监听器接收前一个的输出，形成数据管道。**必须调用 `next()` 传递给下游**，不调用即为否决：

```typescript
// 触发
const finalMessages = await ctx.waterfall('llm/pre-request', messages)

// 监听（必须调用 next）
ctx.on('llm/pre-request', async (messages, next) => {
  // 可以修改 messages
  messages.push(extraMessage)
  // 必须调用 next() 传递给下一个监听器
  return next(messages)
})
```

::: warning
Waterfall 监听器**必须调用 `next()`**。不调用 `next` 等于否决整个管道，这是故意为之的设计——用于实现拦截/网关逻辑。
:::

## Typed Events

Harness 使用 TypeScript 声明合并来为事件提供类型安全：

```typescript
declare module 'cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
  }
}

// 现在 ctx.on('my-plugin/ready', ...) 和 ctx.emit('my-plugin/ready', ...)
// 都有正确的类型推导
```

## 命名约定

Harness 事件遵循 `namespace/action` 命名：

```
agent/pre-step      — agent 执行一步之前
agent/post-step     — agent 执行一步之后
tool/call           — tool 被调用
tool/result         — tool 返回结果
llm/pre-request     — LLM 请求发送前
session/event       — 会话事件被记录
compact/start       — 压缩开始
compact/end         — 压缩结束
```

## 事件也是效果

通过 `ctx.on()` 注册的监听器会在插件卸载时自动移除：

```typescript
export function apply(ctx: Context) {
  // 这个监听器在插件 dispose 时自动清理
  ctx.on('agent/turn-end', handler)
}
```

## 实战示例：日志插件

一个记录所有 tool 调用的简单插件：

```typescript
import type { Context } from 'cordis'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tool/call', ({ name, args }) => {
    console.log(`[tool] ${name}(${JSON.stringify(args)})`)
  })

  ctx.on('tool/result', ({ name, result }) => {
    const text = result.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

## 下一步

- [能力三件套](../practice/) — 事件在 capability seam 中的角色
- [LLM 适配器](../practice/llm-adapter.md) — 实现一个完整的 LLM 后端
