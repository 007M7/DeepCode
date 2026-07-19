# 系统设计

DeepSeek Harness 建立在 Cordis 微内核之上，采用「一切皆插件」的架构。本节阐述这套设计背后的理论基础和设计哲学。

## 核心思想

Harness 追求三种可组合性的统一：

| 维度 | 含义 | Cordis 对应机制 |
|------|------|----------------|
| 逻辑可组合性 | 功能能否自由拆分和拼装 | 插件系统、事件系统 |
| 时间可组合性 | 运行时能否安全地加载/卸载功能 | 可逆作用、自动清理 |
| 空间可组合性 | 依赖关系能否被安全地声明和管理 | 服务生命周期、依赖注入 |

这三种可组合性在上下文模型中统一为单一的编程范式。

## 目录

- [可组合性与插件系统](composability) — 组合的本质，以及传统插件系统为什么不可靠
- [作用与余作用](effects-coeffects) — Cordis 效果系统的理论模型
- [可逆作用](revertible-effects) — 时间可组合性的形式化定义与证明
- [响应式余作用](reactive-coeffects) — 空间可组合性的服务语义
- [上下文模型](context-model) — Context 如何将作用与余作用统一

## 设计如何映射到 Harness

| 理论概念 | Harness 中的体现 |
|----------|-----------------|
| 可逆作用 | `ctx.tools.register()` 返回 disposer；插件卸载时工具自动注销 |
| 响应式余作用 | `inject: ['llm']` 声明依赖；LLM 适配器不可用时插件自动挂起 |
| 上下文派生 | 子 Agent 拥有独立 Context，继承父级服务但有独立生命周期 |
| Waterfall 事件 | `agent/request` 链式拦截，任一监听器可决定最终请求参数 |
| Capability seam | bash/fs/web 三层拆分：接口 → 实现 → 模型工具 |

## 进一步阅读

- [插件与生命周期](/zh-CN/develop/framework/) — 实践中的 Fiber 状态机
- [服务与依赖](/zh-CN/develop/framework/service) — 服务声明与注入
- [能力的三层拆分](/zh-CN/develop/practice/) — Capability seam 模式
