# RFC：事件词汇的运行时 schema（Zod 与 merge-extensible-map 模式之争）

[English](2026-06-16-typed-event-schemas.md) | 中文

Status: proposed

## 问题

harness 将其核心词汇——内容块、消息来源、结束原因、轮次触发器、轮次结束原因与会话事件——建模为 **merge-extensible map**：一个 TypeScript `interface`（如 `SessionEventMap`、`ContentBlockMap`），插件通过声明合并对其扩展，公开联合类型以 `Map[keyof Map]` 派生。这是本仓库的通用扩展模式，记录在 [docs/architecture.md](../../../architecture.md) 中（"The same merge-extensible-map pattern is used for `MessageSource`, `FinishReason`, `TurnTrigger`, and `TurnEndReason`"），并被 `defineTool` 的 `InferArgs` DSL 与 `assertNever` 穷尽性约定所依赖。

该模式**仅存在于编译期**。类型在运行时消失：没有 schema 对象可供校验传入值、解析不可信输入或在运行时枚举。[会话持久化契约](../../implemented/architecture/2026-06-14-session-persistence.md)暴露了两个后果：

1. **持久化将 `event.data` 视为不透明 JSON。** JSONL/SQLite 后端对每个事件逐字 `JSON.stringify`/`JSON.parse`；唯一的运行时守卫是 `isJsonValue`（往返可序列化性——拒绝 BigInt、函数、循环引用、非有限数等），而**不是**结构校验。一个损坏但仍为合法 JSON 的事件数据（字段类型错误、字段缺失）会静默往返，只有在之后被消费方的 `switch` 处理时才可能被发现。
2. **插件新增的变体没有运行时契约。** 一个通过声明合并添加新 `SessionEventMap` 键的插件，在自身代码中获得了编译期类型，但没有任何机制校验它产出的值是否匹配它声明的形状——无论在生产端、持久化边界还是重新加载时。

由此引出问题：事件词汇是否应迁移到 **Zod** 或其他运行时 schema 库，使持久化边界与插件边界拥有运行时 schema 而非被擦除的类型。

本 RFC 界定这一问题的范围，不提出具体实现。

## 为什么这不是一个持久化变更

很容易把「用 Zod 做序列化」理解为对 `dsh-session-persistence-jsonl/src/format.ts` 的局部改动。但它不是，原因在于一个结构性事实：**插件无法通过声明合并扩展一个 Zod schema。** 声明合并是 TypeScript 的编译期机制；Zod schema 是运行时值。要用 Zod 校验事件，你需要一个**运行时注册表**，每个产出事件的包向其贡献自己的 schema（如 `ctx.sessionEvents.register('compaction/marker', z.object({…}))`），每个消费方从中读取。这个注册表——而非持久化后端——将成为词汇的真源，取代 merge-extensible interface。

因此真正的提案是：**用运行时 schema 注册表替换编译期的 merge-extensible-map 模式，覆盖全仓库。** 这是一次核心词汇的重新设计。

## 影响范围（实测）

将事件/词汇表面迁移到运行时 schema，至少涉及：

- **六个 merge-extensible map**（约 370 行核心类型）：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap`（在 `dsh-llm` 中）；`TurnTriggerMap`、`TurnEndReasonMap`、`SessionEventMap`（在 `dsh-session` 中）。
- **约 10 个 `declare module` 扩展点**，分布在 `dsh-agent`、`dsh-agent-loop`、`dsh-bash`、`dsh-llm`、`dsh-session`、`dsh-session-persistence`、`dsh-system-prompt`、`dsh-tools` 中——每个都将从声明合并改为运行时 `register()` 调用。
- **事件生产端**——agent loop 中 16 处 `session.append(...)` 调用点——形状不变，但现在在边界处被校验。
- **约 7 个 switch 消费方**，按这些联合类型分支：`deriveMessages`（`dsh-session`）、`BlockAssembler`（`dsh-llm`）、`dsh-invariants` 插件、两个 LLM 适配器（`dsh-llm-deepseek`、`dsh-llm-pi-ai`）以及工具 schema 层（`dsh-tools`）。`assertNever` 对封闭联合的穷尽性 vs 对可扩展联合的 fall-through 约定（一条已文档化的 lint 规则）需要重新考量——运行时变体不具备静态穷尽性。
- **`defineTool` 的 `InferArgs` DSL**（`dsh-tools`），它从编译期 schema 规格派生零强制转换的 `execute` 参数类型——这是当前方案的标杆用例。
- **文档**：architecture.md（该模式被描述为基础性的）、[开发模式不变式](../../implemented/architecture/2026-06-11-dev-invariants-over-deep-readonly.md)，以及任何引用该模式的 RFC。

这是一次仓库级别的词汇重新设计，不是持久化的实现细节。

## 曾考虑的替代方案

### A. 维持现状——merge-extensible 类型 + 持久化边界的 `isJsonValue`
保留编译期模式。持久化继续使用不透明 JSON + 可序列化性守卫。插件通过声明合并扩展；事件*形状*的正确性由生产方负责，在编译期由 TypeScript 强制，在开发模式下由 `dsh-invariants` 插件的结构检查强制。

- **优点**：零变更；插件扩展只需一行 `interface` 声明合并，具备完整类型推断且无运行时注册仪式；无新运行时依赖；`defineTool` DSL 与 `assertNever` 穷尽性保持正常工作。
- **缺点**：持久化边界和插件 seam 处无运行时结构校验；格式错误但仍为合法 JSON 的数据被延迟捕获。

### B. 仅对 header/封闭形状做校验（schemastery），事件保持不透明
仅对那些已有手写类型守卫的真正封闭形状加强校验——例如 JSONL 的 `HeaderLine` 守卫（`isHeaderLine`）——使用 **schemastery**（本仓库现有的 schema 库，已用于每个插件的 `static Config`）。merge-extensible 事件联合保持不变。

- **优点**：改动小，契合既有约定（schemastery，非新库）；用声明式 schema 替换封闭形状上的手写守卫；无核心重设计。
- **缺点**：不解决事件数据的校验问题；仅固定的元数据记录得到改善。

### C. 为整个词汇建立运行时 schema 注册表（Zod 或 schemastery）
用运行时注册表替换 merge-extensible map，生产方向其贡献 schema，持久化/消费方据其校验。

- **优点**：持久化边界与插件 seam 处有真正的运行时校验；单一真源；支持通用工具（自动生成文档、模糊测试、协议格式检查）。
- **缺点**：上述完整影响范围；**Zod 目前不是直接依赖**（仅作为 `@earendil-works/pi-ai` 的传递依赖），本仓库选定的 schema 库是 **schemastery**——广泛引入 Zod 本身就是一个依赖决策；声明合并的人体工学（一行插件扩展、完整推断）被运行时注册 + 手动类型接线取代；`assertNever` 穷尽性保证弱化（运行时变体不具备静态穷尽性）。

## 提案

暂缓。如果需要在持久化边界做运行时校验，**方案 B**（用 schemastery 校验封闭的 header 与元数据形状）是既有约定内的适度步骤。**方案 C** 是一项架构决策，需要自己的实现 RFC，包括在 Zod 与 schemastery 之间做出选择。

## 验收标准

- 方案 C 只能通过自己的实现 RFC 推进，绝不作为持久化的附带效果。
- 如果采纳方案 B，封闭的 header/元数据形状（JSONL 的 `isHeaderLine` 守卫及同类）改用 schemastery 校验以替代手写守卫，merge-extensible map 保持不变。

## 风险

- 暂缓意味着事件 `data` 在持久化边界仍无结构校验：格式错误但仍为合法 JSON 的数据被延迟捕获，由消费方的 `switch` 处理——这是现状的代价，有意接受。
- 如果方案 C 最终被采纳，人体工学损失是实际的：一行声明合并变为运行时注册加手动类型接线，`assertNever` 的静态穷尽性保证弱化。

## 待解问题

- 如果采用注册表，schema 库选 **schemastery**（已在依赖树中，已是配置 schema 库）还是 **Zod**（生态更丰富，目前仅为传递依赖）？同时维护两个 schema 库本身就是成本。
- 能否采用混合方案：保留编译期推断（使 `defineTool` 和插件 DX 不受影响），同时为每个变体添加*可选*的运行时 schema，仅在持久化/协议边界校验而非每次进程内 append 时校验？
- `dsh-invariants` 插件在开发模式下是否已覆盖了足够多的运行时形状缺口，使得边界校验仅在面对真正不可信的输入（如重新加载被外部修改的日志）时才有必要？
