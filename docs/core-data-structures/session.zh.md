# 会话

[English](session.md) | 中文

[dsh-session](../../packages/core/session) 的内存事件溯源模型。`Session` 是一份由类型化 `SessionEvent` 组成的**仅追加日志**，是 agent（智能体）完整交互历史的唯一真源。LLM（大语言模型）消息历史从日志*派生*而来，从不单独存储；回放即从同一组事件重新派生。日志如何实现**持久化**（持久化 seam、后端、崩溃恢复）是兄弟文档 [persistence.md](persistence.md) 的关注点。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## `SessionEventMap`：事件词汇

仅追加的事件类型。可通过声明合并扩展：插件通过 declaration merging 声明额外的事件类型。例如[上下文压缩（context compaction） seam](compaction.md) 添加了 `compact/start` / `compact/summary` / `compact/end`，`@deepseek-ai/dsh-hook-protocol` 添加了仅记录日志的 `hook/invoked` / `hook/result` 溯源事件，用于钩子桥接。与 `compact/*` 一样，这些都不是 `SurfaceEventType`（没有 `surfaceOp`）。生成的[持久化日志事件目录](../persistence-catalog.md)列举了所有成员（核心与合并扩展的），包含其 payload、surface 标记与声明位置。

```ts type-equiv
interface SessionEventMap {
  'turn/start': { turn: number; trigger: TurnTrigger }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  /** A user-visible prompt (queued message drained at turn start). */
  'user/message': { content: ContentBlock[]; source: MessageSource }
  /**
   * A queued prompt an `agent/prompt-submit` listener VETOED — the durable
   * record of a blocked prompt and why. Appended in place of the `user/message`
   * the prompt would have become, so the block survives replay even in a MIXED
   * batch where another queued prompt is allowed (there the turn does not end
   * `rejected`, so the boundary reason alone would not preserve it). `content`
   * is the original prompt the listener rejected; `reason` is the veto text
   * ({@link PromptDecision} `block.reason`). NOT a {@link SurfaceEventType}: a
   * blocked prompt produces no LLM message and never reaches `deriveMessages()`.
   */
  'prompt/blocked': { content: ContentBlock[]; source: MessageSource; reason: string }
  /**
   * In-session context injection (file-change notices, subdir AGENTS.md,
   * skill content, cron notifications, …). Rendered into the derived history
   * as tagged synthetic context — NOT a user prompt.
   */
  'context/message': { content: ContentBlock[]; source: MessageSource }
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; content: ContentBlock[]; usage?: TokenUsage }
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  'tool/result': { turn: number; step: number; callId: CallId; content: ContentBlock[]; isError: boolean; error?: { name: string; code: string }; meta?: unknown }
  /** Steering content injected between steps of a running turn. */
  'steering/message': { turn: number; content: ContentBlock[]; source: MessageSource }
  /**
   * The agent's whole todo list, carried as a full snapshot and replaced
   * wholesale on each write — the current list is the most recent `todo/write`
   * (last-write-wins on replay, no fold). Appended by an owning agent via
   * `session.append('todo/write', { todos })`.
   *
   * NOT a {@link SurfaceEventType}: it produces no LLM message and never reaches
   * `deriveMessages()`, so it carries no `surfaceOp` and stays off the surface —
   * it is durable, replayable UI state, distinct from the conversation history.
   * It is a `SessionEventMap` member riding the existing `session/event` emit,
   * not a first-class Cordis `interface Events` notification, so it has no
   * cordis-catalog row.
   */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full snapshot of the {@link EpochHeader} the NEXT request is built under,
   * with the {@link RequestHeaderReason} it was recorded whole. Appended by
   * the loop inside the step, before dispatch, on a loop instance's first
   * request-building step (`'initial'`/`'resume'`) or when a delta failed its
   * round-trip guard (`'fallback'`); always records what the request actually
   * used, post-`agent/request`. Anchors the header fold: reconstruction reads
   * the latest snapshot and applies the deltas after it. NOT a
   * {@link SurfaceEventType}: it produces no LLM message — it is the request
   * envelope, logged so every request is a pure function of the session log
   * (the reconstructability RFC).
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
  /**
   * Amendment to the folded {@link EpochHeader}: system line-trim, name-keyed
   * tools delta, whole replacement config, or whole replacement session
   * prefix (an EMPTY array encodes the transition to "none"). The
   * writer verifies `applyHeaderDelta(previous, delta)` reproduces the new
   * header exactly and falls back to a `'fallback'` `request/header` snapshot
   * when it cannot, so a logged delta ALWAYS round-trips. NOT a
   * {@link SurfaceEventType}.
   */
  'request/header-delta': { system?: SystemDelta; tools?: ToolsDelta; config?: LlmCallConfig; messagePrefix?: Message[] }
}
```

### `TodoItem`：一条待办项

`todo/write` 事件全量快照的单元。刻意保持精简：一行 `content` 加一个三态 `status`（无 id、无优先级、无 `activeForm`）。列表在每次写入时整体替换，因此条目不需要稳定标识；三态 status 恰好是 ACP（Agent Client Protocol）的 `PlanEntryStatus`，UI 桥接层可以将待办列表 1:1 映射到 ACP `plan`（再合成 ACP 额外要求的优先级）。见 [todo_write RFC](../rfc/implemented/feature/2026-06-29-todo-write-tool.md)。

```ts type-equiv
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}
```

### 请求头事件：`request/header` 与 `request/header-delta`

请求信封（`EpochHeader`：调用配置 + 渲染后的系统提示词 + 组装好的工具 schema + 会话前缀）是被记录到日志中的会话状态，使得每次对话请求都是日志的纯函数（可重建性 RFC）。`request/header` 快照（reason 为 `'initial' | 'resume' | 'fallback'`）在对话诞生、进程边界和 delta 编码回退时锚定折叠点；`request/header-delta` 事件在运行中修正它。`foldRequestHeader(events)` 可重建任一请求构建时所用的 header；写入器在记录每个 delta 前都会做往返验证，因此格式正确的日志总能折叠。两者都不是 `SurfaceEventType`，不产生 LLM 消息。

```ts type-equiv
export interface EpochHeader {
  /** The conversation's call configuration (model + sampling scalars). */
  config: LlmCallConfig
  /** Rendered system prompt text; absent for a system-less request. */
  system?: string
  /** Assembled tool schemas; absent for a tool-less request. */
  tools?: ToolSchema[]
  /**
   * The session prefix: request-only messages sent BEFORE the entire derived
   * history (the `agent/session-prefix` waterfall's product, composed once
   * per loop instance and reused for every request it sends). Not session
   * history — `deriveMessages()` never returns it — so the header is its
   * only durable record; absent when the instance composed none.
   */
  messagePrefix?: Message[]
}
```

规范形式：空的系统提示词、空的工具列表和空的会话前缀均为 ABSENT 字段，与请求构建方式一致。`messagePrefix` 是 `agent/session-prefix` waterfall（瀑布式事件）产物的持久记录（请求 = `messagePrefix` + 派生历史）；每个 agent loop（智能体循环）实例组合一次，由该实例的快照锚定，因此实际上 loop 不会产生前缀 delta。delta 分支（整数组替换，空数组编码「回到无前缀」的转换）存在是为了编解码的完备性。其他 delta payload（`SystemDelta`：公共前缀/后缀行裁剪；`ToolsDelta`：按名称键控的增/删/改）与事件一起定义在 [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)。

## `SessionEvent<T>`：一条日志条目

基于 `type` 的真正可辨识联合（而非独立的 `type`/`data` 联合），因此 `switch (event.type)` 能直接收窄 `event.data`，无需类型断言。`seq` 是日志中的单调递增位置（`seq = log.length`）；`time` 为 epoch 毫秒。

```ts type-equiv
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of events that are provenance sources of this event
     * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
     * or the surface nodes shadowed by a compaction replace node).
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

`SessionEventType = keyof SessionEventMap`。由于 `SessionEventMap` 可通过合并扩展，对 `SessionEvent` 的 switch 语句禁止使用 `assertNever`：插件添加的变体是合法的未知值；处理已知 case 后在 `default` 中放行。

## Surface 类型

五种产生消息的类型（`SurfaceEventType`：`user/message`、`assistant/message`、`tool/result`、`context/message`、`steering/message`）携带 surface 元数据，声明它们如何加入派生的 surface 链表。见 [session surface RFC](../rfc/implemented/architecture/2026-06-18-session-surface.md)。

### `SurfaceEventType`：事件类型中产生消息的子集

```ts type-equiv
export type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'context/message'
  | 'steering/message'
```

### `SurfaceOp`：事件如何进入 surface

```ts type-equiv
export type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

`'append'` 是正常的尾部追加路径。`replace` 遮蔽从 `start` 到 `end`（含两端）的 surface 节点（两者都必须是有效的 surface 节点 seq），并在其位置插入新节点。

### `SurfaceIntent`：`session.append()` 的参数

```ts type-equiv
export interface SurfaceIntent {
  surfaceOp: SurfaceOp
  sourceEventSeqs?: number[]
}
```

对 `SurfaceEventType` 事件必填：每个产生消息的事件都必须声明它如何加入 surface（派生历史的唯一来源）。非 surface 类型在编译期拒绝此参数。

### `SurfaceNode`：surface 链表中的一个节点

```ts type-equiv
export interface SurfaceNode {
  seq: number
  prev: number | null
  next: number | null
}
```

### `SurfaceFoldReplacement` 与 `SurfaceFoldResult`：完整的 surface 回放

`foldSurface(events)` 返回当前分离的节点，以及每个声明的替换范围实际遮蔽的节点 seq。`SurfaceManager` 对其增量缓存使用相同的转换函数。

```ts type-equiv
export interface SurfaceFoldReplacement {
  seq: number
  start: number
  end: number
  shadowedSeqs: number[]
}
```

```ts type-equiv
export interface SurfaceFoldResult {
  nodes: SurfaceNode[]
  replacements: SurfaceFoldReplacement[]
}
```

## 派生历史：`deriveMessages()` 与 `deriveEventMessage()`

`Session.deriveMessages()` 将事件日志投影为模型看到的 `Message[]`。它是缓存的（每个 surface 节点在首次出现时投影一次；surface 重写触发重建）且冻结的（每次调用返回一个新数组，引用共享的深冻结消息，因此通过投影修改已记录的历史在类型上不可表达）。`deriveEventMessage(event)` 是折叠所应用的逐节点纯函数，公开暴露以便外部重建器和开发不变式检查能以完全相同的规则投影日志前缀，不会与缓存产生分歧。投影规则：

- `user/message` → 一条 user 消息。
- `assistant/message` → 一条 assistant 消息。原始 `assistant/chunk` 事件是回放/UI 数据，在派生中被**跳过**（组装后的消息才是权威的）。**空内容**的 `assistant/message` 也被跳过：一个因 max-tokens 截断且无内容的步骤仍会记录 `assistant/message` 以承载其 `usage`，但无内容的 assistant 轮次不得进入提供方的 transcript（文本记录）。
- `tool/result` → 一条携带 `tool-result` 块的 user 消息。
- `context/message`、`steering/message` → 以 user 角色、按时间顺序插入的消息，包裹在标记信封中（`<context source="…">…</context>`），即「系统提醒」模式；模型通过信封区分它们与真实提示词。

其他一切（`turn/*`、`step/*`）是结构性事件，不投影为消息。token 用量通过 `assistant/message.usage` 观察（产生该用量的步骤）；操作错误的步骤号在 `turn/end.reason` 中（`kind: 'error'` 时）。

## 活跃会话 fork API

`ctx.sessions.create(id, { seed, meta })` 是底层的回放/fork 原语。对于普通的活跃会话 fork，`SessionStore` 暴露一个策略 API：

- `fork(source, boundary?, childSessionId?)` 接受一个活跃的 `Session` 对象或活跃的 `SessionId`，选取到 `boundary` seq（含）为止的源事件（默认为当前最后一个事件），要求 boundary 事件必须是 `turn/end`，然后创建一个活跃的子会话，包含深克隆的种子事件和子会话元数据（`parentSession`、`seedLength` 及继承的 `cwd`）。

显式 `boundary` 允许调用者从之前完成的轮次 fork，即使源会话有更新的事件或正在进行的轮次。API 拒绝非 `turn/end` 的 boundary，而不是静默截断。更广泛的轮次封闭性检查留在既有的 `dsh-invariants` 插件和持久化修复路径中，不在 `fork()` 中重复。`dsh-subagent-fork` 保留其已完成前缀截断逻辑，因为工具时委托通常在父轮次仍然打开时启动；普通的会话分支应显式指定请求的 boundary。

## 轮次的触发原因：`TurnTriggerMap`

```ts type-equiv
interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  /**
   * An out-of-band context injection (`agent.inject()`) made while the agent
   * was idle. The loop wraps the injected `context/message` in a one-shot turn
   * (`turn/start` → `context/message` → `turn/end`) so every event in the log
   * stays turn-enclosed — the durability/replay boundary is the turn, and a
   * bare event between turns would otherwise be indistinguishable from a crash
   * tail on reload.
   */
  injection: { kind: 'injection'; source: MessageSource }
}
```

## 轮次的结束原因：`TurnEndReasonMap`

```ts type-equiv
interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  aborted: { kind: 'aborted'; reason?: string }
  /**
   * The turn failed: a step threw or the model reported a failure. `step` is the
   * step number the failure occurred on (the operational error's location — the
   * single durable record of an in-turn failure; live diagnostics also fire via
   * `agent/error`). `code` is the error's code when one was attached.
   */
  error: { kind: 'error'; step: number; message: string; code?: string }
  disposed: { kind: 'disposed' }
  'max-tokens': { kind: 'max-tokens' }
  /**
   * The turn's entire prompt batch was BLOCKED before any step ran — every
   * drained queued message was vetoed by an `agent/prompt-submit` listener (a
   * hook). The turn still opened (so the boundary stays balanced and the block
   * is a durable in-turn fact), but ran zero steps. `reason` carries the block
   * message from the vetoing decision. Distinct from `aborted` (a user-driven
   * cancel) and `error` (a failure): the prompt was rejected by policy, not
   * interrupted or broken. A UI renders it as "prompt blocked by hook".
   */
  rejected: { kind: 'rejected'; reason: string }
  /**
   * The turn never ended on its own: the process crashed mid-turn and a
   * persistence backend later closed the orphaned (open) turn on reload so the
   * log stays balanced. SYNTHESIZED by the backend's crash-recovery repair — no
   * loop ever emits this. Its events are real (they were durably appended before
   * the crash) and are PRESERVED, not discarded: a single turn can be huge in a
   * long-horizon task (many steps, large tool output), so truncating it would
   * lose real work. The marker records that the turn was cut short, not that the
   * model completed it. See the session-persistence RFC.
   */
  interrupted: { kind: 'interrupted' }
}
```

`max-tokens` 对应同名的模型调用 `FinishReason`：轮次中任何一个步骤出现 `max-tokens`，整个轮次就以 `max-tokens` 结束而非 `completed`（截断事实优先于后续的继续），消费方据此区分正常停止与被截断的情况。但这仅相对于 `completed` 而言：`disposed`/`aborted`/`error` 结果优先级更高。`rejected` 是一个零步骤轮次，其整批提示词被 `agent/prompt-submit` 钩子阻止（ACP 桥接层将其映射为 `cancelled`）。`interrupted` 是唯一不由 loop 发出的原因，由崩溃恢复合成（见 [persistence.md](persistence.md)）。两个 map 均可通过合并扩展。

## 轮次封闭不变式

每个会话事件都存在于一个轮次**内部**（位于 `turn/start` 与其对应的 `turn/end` 之间）。loop 在 `turn/start` *之后*追加排队的 `user/message` 事件；空闲时的 `agent.inject()` 将其 `context/message` 包裹在一个一次性的 `injection` 轮次中。这使得轮次成为唯一的持久性/回放边界：后端可以将最后一个 `turn/end` 之后的任何内容视为中断崩溃的尾部，而不会误丢合法记录的轮次间上下文。`dsh-invariants` 插件在开发环境中强制执行此不变式（在无打开轮次时追加消息事件会抛出异常）。见[轮次封闭不变式 RFC](../rfc/implemented/architecture/2026-06-15-turn-enclosure-invariant.md)。

## 插件贡献的仅日志事件

插件可以通过 declaration merging 添加额外的 `SessionEventMap` 类型。这些是**仅日志**事件：不是 `SurfaceEventType`（不携带 `surfaceOp`，不参与派生历史），但与所有事件一样，必须位于一个打开的轮次内。完整的逐事件枚举（核心与插件贡献的，含 payload 与溯源信息）见生成的[持久化日志事件目录](../persistence-catalog.md)；压缩 seam 的 `compact/*` 语义在 [compaction.md](compaction.md) 中讨论。

钩子桥接的 `hook/invoked` / `hook/result` 溯源对（来自 `@deepseek-ai/dsh-hook-protocol`）通过 `handlerId` 关联。轮次中的钩子点（`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`）在 loop 打开的轮次内触发，因此其 `hook/*` 记录天然满足轮次封闭。`SessionStart` 不产生 `hook/*` 记录（其注入的 `context/message` 就是持久证据），因为它没有打开的轮次来容纳记录（见[钩子桥接 RFC](../rfc/implemented/feature/2026-06-30-hook-bridges.md)）。

## 持久性契约

持久化后端所依赖的约定：持久日志逐字保存每个事件，**包括** `assistant/chunk`。`seq` 必须保持连续，因此不能从规范日志中过滤掉 chunk。所有 `event.data` 必须可 JSON 序列化；`Session.append` 在源头强制执行此约束（对不可序列化的数据抛出异常），因此坏事件永远不会进入日志，`session.events` 始终等于后端能持久化的内容。添加一个携带不可序列化数据的事件类型，或破坏不变式插件所检查的 turn/step 嵌套结构，都是对磁盘格式的破坏性变更。

消费此契约的后端见 [persistence.md](persistence.md)。
