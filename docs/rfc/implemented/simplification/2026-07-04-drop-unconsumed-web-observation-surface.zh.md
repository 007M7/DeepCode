# RFC：移除未被消费的 web 观测面——`providers-change` 事件与 status 方法

Status: implemented

[English](2026-07-04-drop-unconsumed-web-observation-surface.md) | 中文

## 问题

`WebService` 暴露了一组没有任何生产代码观测的观测面：

- **`web/providers-change`**（`packages/web/web/src/index.ts`）在每次 provider 注册和 dispose（资源释放）时声明并发射。每个注册 effect 的回滚 yield 被刻意排在 emit 之前，唯一目的是让一个抛异常的 change listener 能回退注册。该事件在包自身的两个单元测试之外没有任何 listener（其中一个测试的存在就是为了固定那个回滚顺序）。
- **`searchStatus()` / `fetchStatus()` 与 `WebCapabilityStatus` 联合类型**（同一个包）没有任何生产调用方：`dsh-tool-web` 直接通过 `ctx.web.search()`/`fetch()` 执行，并将不可用状态以 seam 在执行时抛出的结构化 `WebError` 错误码呈现（`packages/web/tool-web/src/search.ts`、`packages/web/tool-web/src/fetch.ts`）；唯一的 status 调用方是 web 包自身的测试。`packages/web/tool-web/README.md` 与 [architecture.md](../../../architecture.md) 中的行文声称工具「只读取聚合的 `searchStatus()`/`fetchStatus()`」——这种漂移之所以存活，仅仅因为没有什么机制会拿行文与调用点做比对。

seam 自身的设计使两个观测面都失去了消费方：工具注册跟随产品 ENABLEMENT 而非 provider 可用性（`packages/web/tool-web/src/index.ts`），provider 选择在执行时解析、从不缓存——因此没有需要失效的缓存、没有需要重算的注册集合，也没有调用方需要一个独立于「执行并路由结构化错误」的可用性探针。HMR（热模块替换）清理由 effect disposer 自身承载。

这与[移除未被消费的 `llm/adapter-change` 事件](../../implemented/simplification/2026-06-20-drop-unconsumed-llm-adapter-change-event.md)如出一辙：那次从 `LlmService` 移除了相同的通知形态、相同的回滚先于 emit 机制，以及相同的 listener-throw 测试。该 RFC 的保留/裁剪判据——保留 `tools/change`（因为它有合理的面向用户的工具列表消费方），裁剪启动期后端注册表信号——把 web provider 注册表信号明确归入裁剪一侧；status 方法则是同一判断应用于拉取面而非推送面。

## 决策

移除注册表变更事件、聚合 status 方法与类型，以及它们的专属测试。provider 私有的 status 保留用于执行时选择。面向调用方的覆盖率现在断言成功执行或结构化的选择错误，web 相关文档描述该按需调用契约。

## 曾考虑的替代方案

### 为什么不保留？

web seam RFC 当初有意指定了两者——事件作为最小的 HMR 可见性信号，status 方法作为工具的聚合诊断——且未来的 provider 状态面板是可以想象的。但同一 RFC 的其他选择使它们失去了消费方：按需派生的选择与基于 enablement 的注册使得没有消费方**能**需要它们；已交付的工具展示了真实模式（执行并路由结构化错误）；漂移的 README 语句表明承诺的消费方从未实现。按照 AGENTS.md 的原则「RFC 是提案，不是金科玉律」，这些正是该提案中被代码证明过度延伸的部分；未来的观测者重新引入它实际消费的最小信号或查询，由该消费方塑造其形态。

## 验证

`providers-change`、`searchStatus`、`fetchStatus` 和 `WebCapabilityStatus` 在 RFC 历史之外不再有任何拼写残留；catalog 是最新的（`verify-cordis-catalog` 绿色）；注册/释放的 HMR 安全测试通过执行行为证明清理正确；tool-web README 与架构段落描述了工具实际拥有的执行时错误路由契约。

## 后果

未来如果有 provider 选择器 UI 或诊断面板需要变更通知或 status 查询，它会重新添加自己实际消费的最小观测面；相同的判断及其反转条件已记录在 LLM 先例中。
