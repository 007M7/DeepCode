# 插件与生命周期

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

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'

export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // 到这里时，ctx.tools 和 ctx.llm 一定存在
}
```

如果依赖的服务消失（比如提供者被热替换），插件会被自动卸载（ACTIVE → DISPOSED），待服务恢复后重新加载。

## 自动清理机制

通过 `ctx` 做的任何注册，在插件卸载时都会自动撤销：

```ts
import type { Context } from 'cordis'

declare module 'cordis' {
  interface Events {
    'my-plugin/some-event'(): void
  }
}

declare function handler(): void
declare function createConnection(): { close(): void }

export function apply(ctx: Context) {
  // 事件监听——卸载时自动移除
  ctx.on('my-plugin/some-event', handler)

  // 自定义资源——卸载时调用返回的函数
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

插件卸载时，这些注册按倒序逐个撤销。

## 嵌套上下文

`ctx.plugin()` 创建子 Fiber，它继承父上下文但有独立的生命周期：

```ts
import type { Context } from 'cordis'

declare function childPlugin(ctx: Context): void

export function apply(ctx: Context) {
  // 注册一个子插件
  ctx.plugin(childPlugin)

  // 子插件有自己的 Fiber，父卸载时子也卸载
}
```

## dispose 语义

当你需要提前终止一个插件实例：

```ts
import type { Context } from 'cordis'

declare const ctx: Context
declare function myPlugin(ctx: Context): void

const fiber = ctx.plugin(myPlugin)

// 之后可以手动 dispose
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

`apply` 函数体就是加载钩子；卸载没有专门的事件——把清理逻辑放进 `ctx.effect()` 的返回函数即可：

```ts
import type { Context } from 'cordis'

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

- [服务与依赖](service) — 让你的插件对外提供能力
- [事件系统](events) — 插件间通信的核心机制
