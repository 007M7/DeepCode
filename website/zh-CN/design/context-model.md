# 上下文模型

上下文 (Context) 是 Cordis 将作用与余作用统一的运行时模型。它提供了一种编程范式，允许开发者无心智负担地编写时间、空间可组合的程序。

## 作用上下文 (Effect Context)

当副作用被记录到全局环境时，$\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)$ 也就变成了一个更大的 $\mathcal{C}$。

递归地定义：

$$
\begin{matrix}
\mathcal{C}_1=\mathcal{C}_0\times\left(\mathcal{C}_0\to\mathcal{C}_0\right)\\
\mathcal{C}_2=\mathcal{C}_1\times\left(\mathcal{C}_1\to\mathcal{C}_1\right)\\
\cdots\\
\mathcal{C}_{n+1}=\mathcal{C}_n\times\left(\mathcal{C}_n\to\mathcal{C}_n\right)\\
\end{matrix}
$$

每一层 $\mathcal{C}$ 包含上一层的状态，同时记录了上一层的副作用。

利用递归类型得到真正的作用上下文：

$$
\mathcal{C}=\mathcal{C}\times\left(\mathcal{C}\to\mathcal{C}\right)
$$

这就是 Cordis Context 的理论根基：**上下文既是状态容器，又是副作用追踪器。**

## 上下文的派生

当一个插件被加载时，从当前上下文派生出新的上下文实例：

```
Root Context
├── Plugin A Context   ← 管理 A 的副作用
│   └── Sub-plugin Context
└── Plugin B Context   ← 管理 B 的副作用
```

- 子级上下文管理插件内部的全部副作用
- 插件整体作为一个副作用被父级上下文收集
- 父级 dispose 时，子级先被 dispose（保证依赖逆序）

## 余作用上下文 (Coeffect Context)

余作用由作用产生：

- **提供服务**本身是一种作用——它占用了服务命名空间资源
- 因此服务的提供被记录在作用上下文中
- 上下文将作用与余作用关联起来，提供了统一的时间、空间可组合性

```ts
import { Service, type Context } from 'cordis'

// 提供服务 = 一个 effect（占用 ctx.llm 这个 "资源"）
class LlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  // 当此插件卸载时，ctx.llm 被回收（effect 的逆操作）
  // 所有依赖 llm 的插件因 coeffect 不满足而挂起
}
```

## 基于上下文的开发范式

上下文模型提供了两个关键优势：

### 无感性 (Transparent)

框架将领域中的所有方法都封装为 effect 版本。开发者只需调用 `ctx` 上的方法，就能自动获得时间/空间可组合性：

```ts
import type { Context } from 'cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LlmAdapter, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

declare function validateResult(agent: Agent, turn: number, step: number, message: Message, next: () => Promise<Message>): Promise<Message>
declare const myTool: ToolDefinition
declare const adapter: LlmAdapter

export function apply(ctx: Context) {
  // 以下每一行都是 effect——卸载时自动逆序回收
  ctx.on('agent/step-result', validateResult)
  ctx.tools.register(myTool)
  ctx.llm.registerAdapter(['my-model'], adapter)

  // 开发者无需知道"可逆作用"的存在
  // 只需通过 ctx 调用，框架保证一切安全
}
```

### 渐进性 (Incremental)

可以逐步将现有框架中的 API 替换为可组合版本，无需一次性重写：

```ts
import type { Context } from 'cordis'

declare const ctx: Context
declare function handler(): void
declare const legacySystem: {
  register(handler: () => void): object
  unregister(token: object): void
}

// 第一步：用 ctx.effect 包装遗留 API
ctx.effect(() => {
  const legacy = legacySystem.register(handler)
  return () => legacySystem.unregister(legacy)
})

// 第二步：在未来将遗留 API 原生改造为 effect
// 两种方式可以并存
```

## 在 Harness 中的完整图景

DeepSeek Harness 的运行时是一个 Context 树：

```
Root Context (Cordis 应用)
├── dsh-session (提供 ctx.sessions)
├── dsh-tools (提供 ctx.tools)
├── dsh-llm (提供 ctx.llm)
│   └── deepseek-adapter (注册模型适配器)
├── dsh-agent-loop (提供 ctx.agentLoop)
├── dsh-bash (提供 ctx.bash)
│   └── bash-local (本地执行器实现)
├── dsh-fs (提供 ctx.fs)
│   └── fs-local (本地 FS 实现)
├── dsh-system-prompt (提供 ctx.systemPrompt)
└── Agent Context (由 agents.create() 派生)
    ├── Agent 自己注册的 tools
    ├── Agent 的 session
    └── Subagent Context (进一步派生)
```

每个节点都是一个 Context 实例。插件加载/卸载、服务出现/消失、Agent 创建/销毁——这一切都在 Context 树上以统一的语义发生。

## 总结

| 概念 | 解决的问题 | Cordis 机制 |
|------|-----------|-------------|
| 作用上下文 | 副作用追踪与回收 | `ctx.effect()` / `fiber.dispose()` |
| 上下文派生 | 副作用的层级隔离 | `ctx.plugin()` 创建子 Context |
| 余作用上下文 | 依赖的动态管理 | `inject` 声明 + 服务生命周期 |
| 统一范式 | 开发者无需关心底层机制 | 只需通过 `ctx` 调用 API |

这就是为什么 Harness 能在保持「一切皆插件」的同时，不给插件开发者增加心智负担——**上下文模型把复杂性封装在了框架内部**。
