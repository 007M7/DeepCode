# 服务与依赖

服务 (Service) 是插件对外暴露能力的方式。依赖 (inject) 是插件声明自己需要哪些服务。

## 什么是服务

在 Harness 中，`tools`、`llm`、`agents` 都是服务。服务是挂载在 `ctx` 上的命名能力：

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'

declare const ctx: Context

ctx.tools    // ToolRegistry 服务
ctx.llm      // LLM 服务
ctx.agents   // Agent 注册表服务
```

任何插件都可以提供一个新服务，供其他插件使用。

## 使用服务

声明 `inject` 来使用已有服务：

```ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools 在这里一定存在且就绪
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

框架保证：在 `apply` 执行时，`inject` 声明的服务已经全部就绪。如果服务还没准备好，你的插件会等着，不会执行。

## 提供服务

### 使用 Service 基类

```ts
import { Service, type Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-llm'

export default class MetricsService extends Service {
  static inject = ['llm']  // 本服务也可以依赖其他服务

  constructor(ctx: Context) {
    super(ctx, 'metrics')  // 'metrics' 是服务名
  }

  // 服务的公开方法
  record(event: string, value: number) {
    // ...
  }
}
```

加载这个插件后，其他插件就可以通过 `ctx.metrics` 访问它：

```ts
import type { Context } from 'cordis'

export const inject = ['metrics']

export function apply(ctx: Context) {
  ctx.metrics.record('tool_call', 1)
}
```

### 类型声明

使用 TypeScript 声明合并让 `ctx.metrics` 有正确类型：

```ts
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) { /* ... */ }
}
```

## 依赖的行为

### 必选依赖 vs 可选读取

`inject` 声明的依赖都是必选的：服务不存在时，插件不会加载。如果只想"有则用之"，用 `ctx.get()` 读取——服务不存在时返回 `undefined`，插件照常加载：

```ts
import type { Context } from 'cordis'

// 必选：服务不存在时，插件不会加载
export const inject = ['tools']

export function apply(ctx: Context) {
  // 可选读取：不声明 inject，服务不存在时返回 undefined
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1)
}
```

### 服务消失时的行为

如果一个必选依赖的服务在运行时消失（比如提供者被卸载）：

1. 依赖它的插件自动 dispose
2. 当服务重新出现时，插件自动重新加载

这保证了不会出现"调用一个已不存在的服务"的情况。

## 服务隔离

`cordis.yml` 支持服务隔离——同一个服务可以有多个实例，不同插件组看到不同实例。用 `@cordisjs/plugin-group` 建组（`group: true` 标记组条目），并在组上声明 `isolate`，把该服务隔离进组内作用域：

```yaml
- id: group-a
  name: '@cordisjs/plugin-group'
  group: true
  isolate:
    bash: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 5000
    - name: './src/plugin-a.ts'

- id: group-b
  name: '@cordisjs/plugin-group'
  group: true
  isolate:
    bash: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 60000
    - name: './src/plugin-b.ts'
```

`plugin-a` 和 `plugin-b` 各自看到自己组内的 bash 实例，互不影响。`isolate: { bash: true }` 是必需的：不隔离的话，两个组在同一作用域注册同名服务，第二个会直接报重复注册错误。

## Harness 内置服务一览

| 服务名 | 提供者 | 用途 |
|--------|--------|------|
| `tools` | dsh-tools | Tool 注册表 |
| `llm` | dsh-llm | LLM 调用 + 适配器注册 |
| `agents` | dsh-agent | Agent 注册表 |
| `agentLoop` | dsh-agent-loop | Agent 创建与循环执行 |
| `sessions` | dsh-session | 会话存储与事件流 |
| `systemPrompt` | dsh-system-prompt | 系统提示词组装 |
| `bash` | dsh-bash（实现：dsh-bash-local） | Bash 命令执行 |
| `fs` | dsh-fs（实现：dsh-fs-local） | 文件系统操作 |
| `subagents` | dsh-subagent | 子代理委派 |
| `sessionPersistence` | dsh-session-persistence（实现：-jsonl / -sqlite） | 会话持久化 |

## 下一步

- [事件系统](./events) — 插件间松耦合通信
- [能力三件套](../practice/) — 服务在 seam 模式中的应用
