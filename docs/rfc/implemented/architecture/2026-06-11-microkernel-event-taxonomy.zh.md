# RFC：微内核——通过 Cordis 事件分类体系实现扩展，唯一具体循环

Status: implemented

[English](2026-06-11-microkernel-event-taxonomy.md) | 中文

## 问题

产品原则是「一切皆插件」：钩子、/goal、/loop、动态工作流、上下文压缩（context compaction）、沙箱、权限、UI、持久化、MCP、skill（技能）都必须能以插件形式编写，而无需修改核心。

## 决策

纯 Cordis 事件分类体系（taxonomy）。循环的扩展 seam 是带有明确分发模式的类型化事件：

- **waterfall（瀑布式事件）**（around-middleware）：插件可以变换、否决或包装：`agent/prompt-submit`、`agent/request`、`agent/step-result`、`agent/turn-continuation`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`llm/stream`、`system-prompt/assemble`。
- **serial**（按监听器顺序依次 await；bail 值会阻止后续监听器）：用于有序检查点。所有 `agent/pre-step` 监听器在全部弃权时都会运行，而 `agent/turn-stop` 返回的第一个 stop 值即为最终的终止决策。
- **parallel**（await 扇出）：每个监听器都必须获得独立执行机会：`session/flush` 持久性检查点。
- **emit**（同步 fire-and-forget）：用于通知：轮次/步骤边界、流式分片、生命周期、错误，以及包含不可变 `tools/result` 观测值的事件。

事件词汇定义在接口包中（dsh-agent 声明 agent/* 事件）；`@deepseek-ai/dsh-agent-loop` 是唯一的具体循环插件，且本身可替换——它之外的任何代码都不得依赖它。

## 曾考虑的替代方案

**专用中间件栈（koa-compose 风格）** 与 **插件插入其中的显式阶段状态机**：两者都需要重新实现分发、dispose（资源释放）和重载语义，而 Cordis 原生事件系统已经提供了这些；作为 Cordis effect，监听器天然获得 HMR（热模块替换）和 dispose 能力。

## 后果

- 每个 MVP 功能都映射到一个监听器（[功能→机制映射](../../../cookbook/extension-cookbook.md#the-feature--mechanism-map)是证明义务，保持最新）。
- HMR 和 dispose 免费获得：监听器和注册都是 Cordis effect。
- waterfall 语义（调用 `next()` 或短路）不直观，需要教学——已在 AGENTS.md 中记录，并由组合测试覆盖。
- 循环必须具备防御性：插件异常在轮次级别被隔离，来自任何 seam 的 steering（中途引导）绝不会被搁置（有回归测试保障）。
