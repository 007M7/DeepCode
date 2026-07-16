# 响应式余作用

响应式余作用 (Reactive Coeffects) 是 Cordis 实现**空间可组合性**的核心机制。

- 将代码中的资源依赖抽象为服务 (service) 的概念
- 通过运行时生命周期语义，实现自动、安全、高效的资源管理

## 依赖的本质是生命周期

传统的依赖注入（如 Angular DI、Spring IoC）解决的是"怎么拿到依赖"的问题，但忽略了一个关键问题：**依赖是有生命周期的**。

一个数据库连接池可能重启，一个 API 服务可能下线，一个 LLM adapter 可能被热替换。当依赖消失时，依赖者应当如何表现？

- 崩溃？——对长时运行程序不可接受。
- 继续运行？——可能产生不一致状态。
- **自动挂起，等待恢复？**——Cordis 的选择。

## 服务与生命周期

Cordis 将程序中的资源依赖抽象为**服务** (service)：

- 任何插件都可以声明自己依赖的服务列表
- 服务存在明确的生命周期（提供、撤销）
- 运行时对依赖不满足的插件**等待**，而非拒绝
- 服务生命周期结束前，依赖该服务的插件**先一步被回收**

```ts
import { Service, type Context } from 'cordis'

// LLM 适配器插件：提供 llm 服务
export class LlmService extends Service {
  static inject = ['http']  // 自身依赖 http
  // 当 http 不可用时，LlmService 自动挂起
  // 挂起导致 ctx.llm 不可用
  // 所有 inject: ['llm'] 的插件级联挂起

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
}
```

## 与现有理论的对比

### 与 Comonad 余作用比较

基于 Comonad 的余作用（Petricek 2013）将上下文建模为静态结构，侧重于编译期分析。Cordis 的响应式余作用额外引入了**时序语义**：

- 服务可在运行时出现/消失
- 依赖关系随之动态建立/解除
- 效果的生命周期由依赖关系决定

### 与 Grade Algebra 余作用比较

基于 Grade Algebra 的余作用（Gaboardi 2016）用有序半环描述资源的组合规则。Cordis 的服务依赖可以建模为**交换半群**：

- 服务名构成依赖集合
- 集合并（∪）对应并行依赖
- 交换律：依赖 A + B ≡ 依赖 B + A（声明顺序无关）
- 结合律：依赖分组方式不影响语义

但 Cordis 还增加了代数不具备的运行时行为：当集合中的某个服务不可用时，整个依赖集不满足，触发挂起。

## 在 Cordis 中的实现

```ts
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'

// 声明依赖
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // 到这里时，ctx.tools 和 ctx.llm 一定可用
  // 如果任一服务消失，此插件自动卸载
  // 服务恢复后，自动重新执行 apply
}
```

服务生命周期变化时的行为：

```
llm service 可用 → 依赖 llm 的插件 PENDING → ACTIVE
llm service 消失 → 依赖 llm 的插件 ACTIVE → DISPOSED
llm service 恢复 → 依赖 llm 的插件重新 PENDING → ACTIVE
```

## 为什么 Agent 需要响应式余作用

在 Harness 场景下，响应式余作用直接支撑：

| 场景 | 行为 |
|------|------|
| LLM adapter 热替换 | 依赖 `llm` 的插件自动挂起/恢复，中间不丢状态 |
| 按需加载 bash 执行器 | bash tool 只在 `bash` 服务就绪后注册 |
| 子 Agent 独立服务空间 | 通过 `ctx.isolate()` 隔离服务实例，互不干扰 |
| 可选能力降级 | 不声明 `inject`，用 `ctx.get('web')` 读取——服务不可用时返回 `undefined`，插件照常运行 |

这意味着 Harness 插件开发者无需编写防御性的 "if service exists" 检查——框架保证：当你的 `apply` 被调用时，声明的依赖一定已就绪。
