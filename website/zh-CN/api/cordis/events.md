# Events

`ctx.events` 是内置服务，提供事件系统相关的全部 API。

## 实例方法

### ctx.on(event, listener, options?) {#ctx-on}

- **event:** `string` 事件名称
- **listener:** `Function` 事件监听器
- **options:** `object`
  - **prepend:** `boolean` 是否注册为前置（默认 `false`）
  - **global:** `boolean` 是否注册为全局（默认 `false`）
- **返回值:** `() => void` 取消注册函数

注册一个事件监听器。返回的函数可用于手动取消注册，但通常不需要——插件卸载时会自动清理。

```typescript
ctx.on('agent/turn-end', (data) => {
  console.log('turn ended:', data)
})
```

### ctx.emit(thisArg?, event, ...args) {#ctx-emit}

- **thisArg:** `any` 监听器的 `this` 参数（可选）
- **event:** `string` 事件名称
- **args:** `any[]` 事件参数
- **返回值:** `void`

同步触发所有匹配的监听器（并行，不等待异步完成）。

### ctx.parallel(thisArg?, event, ...args)

- 签名同 `emit`
- **返回值:** `Promise<void>`

异步触发所有匹配的监听器（并行等待）。

### ctx.bail(thisArg?, event, ...args) {#ctx-bail}

- **返回值:** `any`

同步依次触发监听器。第一个返回非 `undefined`/`null`/`false` 值的监听器停止链并返回该值。

### ctx.serial(thisArg?, event, ...args) {#ctx-serial}

- **返回值:** `Promise<any>`

异步依次触发监听器。语义同 `bail` 的异步版本。

### ctx.waterfall(thisArg?, event, ...args) {#ctx-waterfall}

- **返回值:** `Promise<any>`

管道模式：每个监听器接收前一个的输出。监听器内部必须调用 `next()` 才会传递给下一个。

```typescript
// 注册
ctx.on('llm/pre-request', async (messages, next) => {
  messages.push(extraMsg)
  return next(messages)  // 必须调用
})

// 触发
const result = await ctx.waterfall('llm/pre-request', initialMessages)
```

::: warning
不调用 `next()` 即为否决 (veto)——管道终止。这是设计行为，用于拦截/网关。
:::

## Harness 内置事件

### agent/pre-step

- **触发模式:** serial
- **参数:** `{ agentId, turnIndex }`

Agent 执行一步之前触发。

### agent/post-step

- **触发模式:** emit
- **参数:** `{ agentId, turnIndex, blocks }`

Agent 执行一步之后触发。

### tool/call

- **触发模式:** emit
- **参数:** `{ name, args, callId }`

Tool 被模型调用时触发。

### tool/result

- **触发模式:** emit
- **参数:** `{ name, result, callId }`

Tool 返回结果时触发。

### session/event

- **触发模式:** emit
- **参数:** `SessionEvent`

会话事件被记录时触发。

### compact/start

- **触发模式:** emit

上下文压缩开始。

### compact/end

- **触发模式:** emit

上下文压缩结束。
