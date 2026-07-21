# 插件与生命周期

[English](index.md) | 中文

深入了解 Cordis 插件模型和生命周期状态机。

## Fiber 状态机

每个被加载的插件对应一个 **Fiber**（作用域）。Fiber 有以下状态：

```
PENDING → LOADING → ACTIVE
                 ↘ FAILED
ACTIVE → UNLOADING → DISPOSED
```

| 状态 | 含义 |
|------|------|
| PENDING | 已声明但依赖未就绪 |
| LOADING | 依赖就绪，正在执行 `apply` |
| ACTIVE | 插件运行中 |
| FAILED | `apply` 抛出异常 |
| UNLOADING | 正在卸载，清理中 |
| DISPOSED | 已完全卸载 |

## 依赖驱动的加载

声明了 `inject` 的插件不会立即加载，而是等待依赖的服务就绪：

```ts ignore-check
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // ctx.tools and ctx.llm are ready here.
}
```

如果依赖的服务消失（比如提供者被热替换），插件会被自动卸载（ACTIVE → DISPOSED），待服务恢复后重新加载。

## 自动清理机制

通过 `ctx` 做的任何注册，在插件卸载时都会自动撤销：

```ts ignore-check
export function apply(ctx: Context) {
  // Event listener: removed automatically on unload.
  ctx.on('some-event', handler)

  // Custom resource: the returned disposer runs on unload.
  ctx.effect(() => {
    const connection = createConnection()
    return () => connection.close()
  })
}
```

以下操作都会被自动追踪和清理：
- `ctx.on(event, handler)` — 事件监听
- `ctx.tools.register(tool)` — tool 注册
- `ctx.llm.registerAdapter(names, adapter)` — LLM 适配器注册
- `ctx.effect(() => cleanup)` — 自定义资源

插件卸载时，处置器按注册顺序的反向发起，但多个异步处置器会并发执行，不保证逐个完成。存在顺序依赖的清理步骤必须放进同一个 `ctx.effect()` 返回的处置器中，由该处置器负责串行等待。

## 嵌套上下文

`ctx.plugin()` 创建子 Fiber，它继承父上下文但有独立的生命周期：

```ts ignore-check
export function apply(ctx: Context) {
  // Register a child plugin.
  ctx.plugin(childPlugin)

  // The child has its own Fiber and unloads with its parent.
}
```

## dispose 语义

当你需要提前终止一个插件实例：

```ts
import type { Context } from 'cordis'

declare const ctx: Context
declare function myPlugin(ctx: Context): void

const fiber = ctx.plugin(myPlugin)

// Dispose it manually later.
await fiber.dispose()
```

`dispose` 保证：
1. 该插件注册的所有东西被撤销
2. 它的子插件也被递归卸载
3. 所有异步清理完成后 Promise resolve

## 热替换 (HMR)

在开发环境中（`cordis.yml` 加载了 `@cordisjs/plugin-hmr`），修改插件源文件会自动触发：

1. 卸载旧插件（清理所有注册）
2. 重新加载新代码
3. 执行新的 `apply`

因为所有注册都会被自动清理，所以热替换天然安全——不会留下旧状态。

## 实战：理解生命周期

```ts ignore-check
export function apply(ctx: Context) {
  console.log('plugin loading')

  ctx.effect(() => {
    console.log('effect registered')
    return () => console.log('effect cleaned up')
  })
}
```

加载时输出：
```
plugin loading
effect registered
```

卸载时输出：
```
effect cleaned up
```

## 下一步

- [服务与依赖](./service.md) — 让你的插件对外提供能力
- [事件系统](./events.md) — 插件间通信的核心机制
