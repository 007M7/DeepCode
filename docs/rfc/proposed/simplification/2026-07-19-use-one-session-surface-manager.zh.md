# RFC: 每个会话只使用一个表层管理器

Status: proposed

[English](2026-07-19-use-one-session-surface-manager.md) | 中文

## 问题

`Session` 针对同一份仅追加事件日志维护两个 `SurfaceManager` 实例。`surfaceValidator` 主动校验种子事件与追加候选事件，延迟创建的 `_surface` 则独立折叠已提交事件，供 `session.surface`、派生消息、压缩（compaction）和工作区上下文使用。一旦读取公共表层，之后的每个事件都会推进两份重复的节点状态与替换代数状态。

[会话表层决策](../../implemented/architecture/2026-06-18-session-surface.md)要求系统只保留一个有序表层，并使用一种表示完成校验。第二个管理器既不形成独立真源，也不保护不同的失败边界；它只会重复规范折叠，并使两个视图可能出现状态偏差。

## 提案

每个 `Session` 只保留一个 `SurfaceManager`。种子事件与追加事件的接纳流程仍在提交事件之前调用 `validateNext()`，公共表层视图则从同一个管理器读取 `nodes` 与 `replaceGeneration`。

`Session.surface` 只公开只读表层契约，候选事件校验仍由 `Session` 负责。保留 `foldSurface()`，用于离线校验与重建时执行分离的完整日志回放。

## 实施计划

1. 在 `packages/core/session/src/surface.ts` 中，导出结构化的 `SessionSurface` 契约，只包含只读的 `nodes` 与 `replaceGeneration`，并让 `SurfaceManager` 实现该契约。从 `packages/core/session/src/index.ts` 重新导出这个类型，使 `Session.surface` 的声明不再暴露 `validateNext()`。
2. 在 `Session` 中，用一个主动创建的 `surfaceManager` 替换 `surfaceValidator` 与延迟创建的 `_surface`。种子事件与追加事件都通过该管理器校验，`get surface(): SessionSurface` 返回同一个对象，`deriveMessages()` 也读取同一份节点与代数。`validateNext()` 可以同步已提交的日志事件，但对尚未提交的候选事件只能制定变更计划。候选事件在 `log.push()` 之后、下一次增量同步时才进入管理器状态，因此表层校验拒绝或提交前 `internal/dispatch` 否决都不会留下虚假状态。
3. 保持 `foldSurface()` 与 `surface.ts` 中的状态转换函数不变。编译并验证 `packages/compact/compact/src/tool-pairing.ts`、`packages/compact/compact-basic/src/region.ts` 和 `packages/context/workspace-context/src/state.ts` 中的直接消费方；它们仍然只读取节点与替换代数。
4. 扩展 `packages/core/session/tests/surface.spec.ts`：先读取公共视图，再提交无效候选事件，证明拒绝后节点与代数仍停留在已接纳前缀；随后追加有效事件，并把每个结果前缀与 `foldSurface()` 比较。在 `session.spec.ts` 中新增 `internal/dispatch` 否决用例与类型层面的 `SessionSurface` 断言，同时保留种子回放、增量增长、替换、代数和派生缓存用例。
5. 运行消费表层的请求重建、压缩工具配对、压缩范围与工作区上下文回归套件。在实现 PR 中，先更新 `packages/core/session/README.md`、`docs/core-data-structures/session.md`、已实现会话表层 RFC 及其中文对应文件、翻译记录、`scripts/type-equiv.manifest.json` 和生成的 RFC 索引，再把本 RFC 双语文件移入 `implemented/`。

## 备选方案

**继续分离接纳状态与投影视图。** 两个独立实例看似能够隔离公共读取和校验，但普通调用方目前取得的就是借用的表层状态，无法通过声明的只读契约修改它。通过类型断言修改返回的节点数组，本就会破坏派生历史；复制管理器并不能构成可靠的运行时信任边界。

**每次读取都根据完整日志重新计算公共表层。** 该方案不再缓存重复状态，但会放弃增量派生，使每次请求构造都随完整会话历史增长。

## 验收标准

- 每个活跃 `Session` 只拥有一个增量 `SurfaceManager`。
- 种子事件与追加候选事件都在发布前完成校验，拒绝事件时不会留下只修改一半的表层状态。
- `session.surface`、派生消息、压缩和工作区上下文观察到的节点与替换代数，和接纳路径使用的状态完全一致。
- `foldSurface()` 仍可用于分离回放，并且对任意已接纳前缀都与活跃管理器一致。
- 会话表层、种子、请求重建、压缩工具配对和工作区上下文测试全部通过。

## 风险

共享一个管理器会提高只读借用状态契约的重要性，因为恶意类型断言可能同时破坏校验状态和投影视图。实现应返回收窄后的视图，避免通过 `Session.surface` 暴露修改方法；刻意绕过类型契约的 JavaScript 调用方不属于受支持的同进程边界。
