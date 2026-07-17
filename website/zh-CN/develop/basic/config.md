# 插件配置

让你的插件接受用户在 `cordis.yml` 中传入的配置。

## 定义 Config 类型

在插件中导出一个 `Config` 类型，`apply` 的第二个参数就是用户配置：

```ts
import type { Context } from 'cordis'

export const name = 'my-plugin'

export interface Config {
  greeting?: string
  maxRetries?: number
  verbose?: boolean
}

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting ?? 'Hello')  // 用户配置或默认值
}
```

用户在 `cordis.yml` 中这样使用：

```yaml
- name: './src/my-plugin.ts'
  config:
    greeting: 'Hi there'
    maxRetries: 5
```

只导出类型时，配置原样传入，默认值由代码自己兜底（如上面的 `??`）。想让框架代管默认值和校验，导出一个 schema（见下节）。

## Schema 校验

对于需要默认值和严格校验的场景，额外导出一个 Schemastery schema（仓库约定以 `z` 引入）。加载时框架先用它校验并填充默认值，再把结果传给 `apply`：

```ts
import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'validated-plugin'

export interface Config {
  apiKey: string
  timeout?: number
  mode?: 'fast' | 'accurate'
}

export const Config: z<Config> = z.object({
  apiKey: z.string().required(),
  timeout: z.number().default(30000),
  mode: z.union(['fast', 'accurate'] as const).default('fast'),
})

export function apply(ctx: Context, config: Config) {
  // config 已经过校验，类型安全，默认值已填充
}
```

Schema 在插件加载时执行校验。如果配置不合法，插件会加载失败并给出明确错误信息。

## 设计原则

### 无硬编码可调参数

Harness 的约定：**任何两个部署可能想要不同值的东西，都应该是配置字段**。

```ts
// 错误 — 硬编码超时时间
const TIMEOUT = 30000

// 正确 — 可配置
export interface Config {
  /** 默认 30000 */
  timeoutMs?: number
}
```

检验标准：能否在 `cordis.yml` 中改变这个值，而不需要修改代码？

### 配置错误要响亮

如果配置引用了不存在的东西（比如一个未注册的 LLM 提供方路由），应该尽早报错，而不是静默跳过：

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-llm'

export interface Config {
  provider: string
  model: string
}

export function apply(ctx: Context, config: Config) {
  if (!ctx.llm.listProviders().some(provider => provider.id === config.provider)) {
    throw new Error(`LLM provider "${config.provider}" is not registered`)
  }
}
```

模型目录只用于发现；适配器可能接受目录之外的模型 ID，因此不能把 `listModels()` 当作请求白名单。

## 配合 HMR

配置变更会触发插件热替换：修改 `cordis.yml` 中某个插件的 `config`，框架会卸载旧实例、加载新实例。由于注册都是效果（自动清理），这个过程是安全的。

## 下一步

- [插件与生命周期](../framework/) — 深入了解插件的完整生命周期
- [服务与依赖](../framework/service) — 让你的插件对外提供服务
