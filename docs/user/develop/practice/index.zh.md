# 能力的三层拆分

[English](index.md) | 中文

当一个能力（插件）足够通用（比如"执行 bash 命令"），Harness 会把它拆成三个包：**接口**、**实现**、**消费者**。这样可以独立替换其中任何一层。

## 以 Bash 为例

考虑 "Bash 执行" 这个能力：

- **接口** (`dsh-bash`) — 定义"bash 执行"长什么样：输入是什么、输出是什么
- **实现** (`dsh-bash-local`) — 真正在本地跑命令的代码
- **消费者** (`dsh-tool-bash`) — 把这个能力包装成模型能调用的 tool

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  dsh-bash   │────▶│  dsh-bash-local  │     │ dsh-tool-bash│
│ (interface) │     │ (implementation) │     │(consumer/tool)│
└─────────────┘     └──────────────────┘     └──────────────┘
       ▲                                            │
       └────────────────────────────────────────────┘
                    inject: ['bash']
```

## 拆分的好处

### 具体实现可替换

同一个接口可以有多种实现。用户通过 `cordis.yml` 选择：

```yaml
# Local execution
- name: '@deepseek-ai/dsh-bash-local'

# Or a future remote sandbox implementation
# - name: '@deepseek-ai/dsh-bash-remote'
#   config:
#     endpoint: 'https://sandbox.example.com'
```

接口不变、tool 不变，只换实现。

### 独立演进

- 接口定义稳定后很少改动
- 实现可以独立优化（性能、安全）
- 消费者（tool）可以调整对模型的呈现方式

### 依赖解耦

- 实现 depend on 接口
- 消费者 depend on 接口
- 实现和消费者**互不依赖**

## Harness 中内置的三件套

| 能力 | 接口 (seam) | 实现 | 消费者 (tool) |
|------|-------------|------|---------------|
| Bash | `dsh-bash` | `dsh-bash-local` | `dsh-tool-bash` |
| 文件系统 | `dsh-fs` | `dsh-fs-local` + `dsh-fs-policy` | `dsh-tool-fs` |
| Web | `dsh-web` | `dsh-web-fetch-local` / `dsh-web-search-*` | `dsh-tool-web` |
| 子代理 | `dsh-subagent` | `dsh-subagent-spawn` / `dsh-subagent-fork` | `dsh-tool-subagent` |
| 压缩 | `dsh-compact` | `dsh-compact-basic` | 由实现插件消费 agent-loop 的扩展事件 |

## 开发你自己的三件套

### 第一步：定义接口

```ts ignore-check
// packages/my-cap/my-cap/src/index.ts
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    myCap: MyCapService
  }
}

export abstract class MyCapService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myCap')
  }

  /** Execute the capability. */
  abstract execute(request: MyCapRequest): Promise<MyCapResult>
}

export interface MyCapRequest {
  input: string
}

export interface MyCapResult {
  output: string
}
```

### 第二步：编写实现

```ts ignore-check
// packages/my-cap/my-cap-local/src/index.ts
import type { Context } from 'cordis'
import { MyCapService, type MyCapRequest, type MyCapResult } from '@deepseek-ai/dsh-my-cap'

class MyCapLocal extends MyCapService {
  async execute(request: MyCapRequest): Promise<MyCapResult> {
    // Concrete implementation.
    return { output: request.input.toUpperCase() }
  }
}

export const name = 'my-cap-local'

export function apply(ctx: Context) {
  ctx.plugin(MyCapLocal)
}
```

### 第三步：编写消费者 (tool)

```ts ignore-check
// packages/my-cap/tool-my-cap/src/index.ts
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-my-cap'
export const inject = ['tools', 'myCap']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_cap',
    description: 'Execute my capability.',
    parameters: {
      input: { type: 'string', required: true },
    },
    async execute(args) {
      const result = await ctx.myCap.execute({ input: args.input })
      return [{ type: 'text', text: result.output }]
    },
  }))
}
```

### 在 cordis.yml 中组合

```yaml
- name: '@deepseek-ai/dsh-my-cap-local'
- name: '@deepseek-ai/dsh-tool-my-cap'
```

## 设计要点

- **不要预防性拆分** — 只有当你确实需要可替换实现时才拆三件套。一个简单的 tool 插件不需要拆分。
- **接口定义 Request/Result 类型** — 实现和消费者只依赖接口包。
- **Explicit > Implicit** — 实现中的默认值处理应该是显式的 `resolve(request): Spec` 步骤，不是隐藏在 `run()` 中的 `?? default`。

## 下一步

- [LLM 适配器](./llm-adapter.md) — 实现一个 LLM 后端（最常见的 seam 扩展）
