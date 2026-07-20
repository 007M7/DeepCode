# 第一个插件

本文带你编写一个最小的 Harness 插件并加载到 Agent 中。

## 插件是什么

在 Harness 中，插件是一个导出 `apply` 函数的 TypeScript 模块。框架在加载时调用 `apply`，传入一个 `ctx`（上下文对象），你通过 `ctx` 注册能力：

```ts
import type { Context } from 'cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册能力
}
```

就这么简单。

## 创建插件文件

在你的项目目录下创建 `src/my-plugin.ts`：

```ts
import type { Context } from 'cordis'

export const name = 'hello-plugin'

export function apply(ctx: Context) {
  // apply 函数体在插件加载时执行
  console.log('[hello-plugin] 插件已加载!')
}
```

## 注册到 cordis.yml

在你的 `cordis.yml` 中添加一条：

```yaml
- id: hello
  name: './src/my-plugin.ts'
```

启动后你会在控制台看到 `[hello-plugin] 插件已加载!`。

## 自动清理

通过 `ctx` 注册的任何东西——事件监听、tool、定时器——在插件卸载时都会被自动清理。你不需要手动 removeListener 或 clearInterval。

如果你有需要手动清理的资源（比如一个网络连接），用 `ctx.effect()` 告诉框架怎么清理：

```ts
import type { Context } from 'cordis'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('heartbeat')
    }, 5000)

    // 返回的函数会在插件卸载时被调用
    return () => clearInterval(timer)
  })
}
```

## 声明依赖

如果你的插件需要使用其他服务（如 `tools`、`llm`），需要声明 `inject`：

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools 现在可用
  ctx.tools.register(defineTool({
    name: 'demo',
    description: 'Demo tool.',
    parameters: {},
    async execute() {
      return []
    },
  }))
}
```

框架会确保依赖的服务就绪后才加载你的插件。

## 插件的三种形态

除了函数形式，插件还支持对象形式和类形式：

### 对象形式

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // ...
  },
}
```

### 类形式

```ts
import { Service, type Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService')
  }

  // 服务的公开方法
  greet(name: string) {
    return `Hello, ${name}!`
  }
}
```

大多数情况下，函数形式足够了。类形式用于需要对外提供服务的插件（见 [服务与依赖](../framework/service)）。

## 完整示例

参考仓库中的 `examples/echo-agent/src/echo-tool.ts`，这是一个注册 tool 的插件：

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'echo-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'Echo the given text back, uppercased.',
    parameters: {
      text: { type: 'string', required: true },
    },
    async execute(args) {
      return [{ type: 'text', text: `ECHO: ${args.text.toUpperCase()}` }]
    },
  }))
}
```

## 下一步

- [开发一个 Tool](tool) — 详细了解 tool 定义 DSL
- [插件配置](config) — 让插件接受用户配置
