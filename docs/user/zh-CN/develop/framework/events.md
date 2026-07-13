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

所有监听器同步执行，不关心返回值：

```typescript
// 触发
ctx.emit('my-plugin/ready', { id: 'worker-1' })

// 监听
ctx.on('my-plugin/ready', ({ id }) => {
  console.log(`${id} is ready`)
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

监听器按注册顺序依次执行，并等待异步结果；第一个返回非空值的监听器会终止后续执行：

```typescript
await ctx.serial('setup-phase', context)
```

### waterfall — 管道

每个监听器可以包装下游返回值，形成处理链。**必须调用 `next()` 传递给下游**，不调用即为否决：

```typescript
// 触发
const output = await ctx.waterfall('my-plugin/transform', input, async () => input)

// 监听（必须调用 next）
ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
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
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}

// 现在 ctx.on('my-plugin/ready', ...) 和 ctx.emit('my-plugin/ready', ...)
// 都有正确的类型推导
```

## Cordis 事件与会话记录

Harness 的 Cordis 事件遵循 `namespace/action` 命名，例如 `agent/pre-step`、`agent/request`、`agent/step-result`、`tools/result` 和 `session/event`。完整签名与触发模式见[Events 目录](../../../../cordis-catalog/events.md)。

`turn/*`、`step/*`、`tool/call`、`tool/result` 和 `compact/*` 是持久化的会话事件类型，不是同名 Cordis 事件。需要观察它们时，监听 `session/event` 并检查 `event.type`。

## 事件也是效果

通过 `ctx.on()` 注册的监听器会在插件卸载时自动移除：

```typescript
export function apply(ctx: Context) {
  // 这个监听器在插件 dispose 时自动清理
  ctx.on('tools/result', handler)
}
```

## 实战示例：日志插件

一个记录所有 tool 调用的简单插件：

```typescript
import type { Context } from 'cordis'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const text = result.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

## 下一步

- [能力三件套](../practice/) — 事件在 capability seam 中的角色
- [LLM 适配器](../practice/llm-adapter.md) — 实现一个完整的 LLM 后端
