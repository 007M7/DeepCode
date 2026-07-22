# 服务与依赖

[English](service.md) | 中文

服务 (Service) 是插件对外暴露能力的方式。依赖 (inject) 是插件声明自己需要哪些服务。

## 什么是服务

在 Harness 中，`tools`、`llm`、`agents` 都是服务。服务是挂载在 `ctx` 上的命名能力：

```ts ignore-check
ctx.tools    // ToolRegistry service
ctx.llm      // LLM service
ctx.agents   // Agent service
```

任何插件都可以提供一个新服务，供其他插件使用。

## 使用服务

声明 `inject` 来使用已有服务：

```ts ignore-check
export const inject = ['tools']

export function apply(ctx: Context) {
  // ctx.tools exists and is ready here.
  ctx.tools.register(/* ... */)
}
```

框架保证：在 `apply` 执行时，`inject` 声明的服务已经全部就绪。如果服务还没准备好，你的插件会等着，不会执行。

## 提供服务

### 使用 Service 基类

```ts
import { Service, type Context } from 'cordis'

export default class MetricsService extends Service {
  static inject = ['llm']  // A service may depend on other services.

  constructor(ctx: Context) {
    super(ctx, 'metrics')  // 'metrics' is the service name.
  }

  // Public service method.
  record(event: string, value: number) {
    // ...
  }
}
```

加载这个插件后，其他插件就可以通过 `ctx.metrics` 访问它：

```ts ignore-check
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

### 必选依赖 vs 可选依赖

```ts ignore-check
// Required: the plugin does not load while the service is absent.
export const inject = ['tools']

// Optional: omit inject and query with ctx.get() at the use site.
export function apply(ctx: Context) {
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

`cordis.yml` 支持服务隔离——同一个服务可以有多个实例，不同插件组看到不同实例：

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

`plugin-a` 和 `plugin-b` 各自看到自己组内的 bash 实例，互不影响。

## Harness 内置服务

服务名、公开方法和源码位置由仓库自动生成，见[服务目录](../../../cordis-catalog/services.md)。开发插件时应以该目录和服务接口的 TypeScript 类型为准，不要复制一份静态清单。

## 下一步

- [事件系统](./events.md) — 插件间松耦合通信
- [能力三件套](../practice/) — 服务在 seam 模式中的应用
