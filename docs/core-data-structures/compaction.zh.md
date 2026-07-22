# 上下文压缩

[English](compaction.md) | 中文

上下文压缩（context compaction）的 seam 是一个[能力 seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md)，按 bash 式拆分：接口（[dsh-compact](../../packages/compact/compact)，`ctx.compact`）、实现（后端，如 [dsh-compact-basic](../../packages/compact/compact-basic)）、消费方（一个 `/compact` 工具，暂缓实现）。上下文压缩是**一项可选能力**，不属于 agent loop（智能体循环）主干，因此其词汇定义在此处，而非 [core.md](core.md)。基于 tokenizer 或模板的后端是实现同一接口的兄弟包。与 bash 不同的是，该接口必然依赖 `dsh-session` 和 `dsh-llm`：它的动词定义在 `Session` 之上，输出使用 `ContentBlock` 词汇（见[上下文压缩能力 seam RFC](../rfc/implemented/feature/2026-06-18-compaction-capability-seam.md)）。

源码：[`packages/compact/compact/src/types.ts`](../../packages/compact/compact/src/types.ts)

## `compact/*` 会话事件

上下文压缩通过声明合并为 [`SessionEventMap`](session.md) 扩展了三种事件类型。三者均为**仅日志**事件：它们记录压缩锁及其来源信息，永远不进入 surface。`SurfaceEventType` 被刻意**不**扩展（只有产生消息的事件才到达模型），因此摘要本身搭载在一条独立的 `user/message` 上，带有 `surfaceOp: { op: 'replace', start, end }`——唯一的 surface 变更。关于为何复用 `user/message` 是诚实的做法而非权宜之计，见 RFC。

| 事件 | 载荷 | 作用 |
|---|---|---|
| `compact/start` | `{ turn }` | 获取日志记录的锁 |
| `compact/summary` | `{ summary, shadowedRange, shadowedSeqs, shadowedTokenCount, model, maxTokens? }` | 来源信息：摘要块、被遮蔽的 surface 边界对（`start`/`end` seq，是位置跨度而非数值区间）、按 surface 顺序排列的被遮蔽 seq、估算的 token 数量，以及摘要调用的信封（`model`，加上生效时的生成上限）。记录这些信息使得单次请求可从日志加代码重建（reconstructability RFC） |
| `compact/end` | `{ turn, error? }` | 释放锁（摘要调用抛出异常时设置 `error`） |

锁括住**整个**操作：先追加 `compact/start`，然后执行摘要生成、写入 `compact/summary` 来源记录与 `user/message` 替换，最后才追加 `compact/end`。最后释放锁意味着操作中途崩溃会表现为可检测的遗留锁（有 `compact/start` 而无匹配的 `compact/end`），而非一个虚假声称压缩已完成的 `compact/end`。

这些变体在 `declare module '@deepseek-ai/dsh-session'` 块内合并，因此——与其他子页面上的顶层类型不同——它们不以漂移检查的 ` ```ts type-equiv ` 块粘贴（`verify-type-equiv` 提取器只按名称匹配顶层声明）。上方的载荷表即为目录条目；权威形状请循源码链接查看。

## `CompactionResult`

一次成功的压缩返回给调用方的内容：三个追加的 `compact/*` 事件的 seq、摘要块，以及被遮蔽的范围/seq 和估算的 token 数量。

```ts type-equiv
interface CompactionResult {
  /** The seq of the appended `compact/start` event. */
  startSeq: number
  /** The seq of the appended `compact/summary` event. */
  summarySeq: number
  /** The seq of the appended `compact/end` event. */
  endSeq: number
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: number; end: number }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}
```

## 服务

`CompactService` 暴露 `compactIfNeeded(...)` 用于压力触发的压缩（不需要压缩时返回 `null`），以及 `compactRegion(...)` 用于对显式的闭区间 surface 范围进行压缩。pre-step 调用方提供 agent、完整 prompt、会话前缀和 abort signal；实现必须将该 signal 转发给摘要生成。估算、保留策略、事件排序与摘要生成均为后端策略。

自动压缩在串行的 `agent/pre-step` 时运行，位于步骤和请求推导之前，因此可以在替换 surface 节点的同时将 trace 事件保持在步骤之外。区域边界保持工具调用/结果配对，但不保持完整轮次，允许一个超大轮次中已关闭的早期步骤被压缩。保留策略与失败处理的细节由 `dsh-compact-basic` 负责。
