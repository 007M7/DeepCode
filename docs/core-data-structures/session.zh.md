# 会话

[English](session.md) | 中文

[dsh-session](../../packages/core/session) 的内存事件溯源模型。`Session` 是一份由类型化 `SessionEvent` 组成的**仅追加日志**，是 agent（智能体）完整交互历史的唯一真源。LLM（大语言模型）消息历史从日志*派生*而来，从不单独存储；回放即从同一组事件重新派生。日志如何实现**持久化**（持久化 seam、后端、崩溃恢复）是兄弟文档 [persistence.md](persistence.md) 的关注点。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

## `SessionEventMap`：事件词汇

仅追加的事件类型。可通过声明合并扩展：插件通过 declaration merging 声明额外的事件类型。例如[压缩（compaction） seam](compaction.md) 添加了 `compact/start` / `compact/summary` / `compact/end`，`@deepseek-ai/dsh-hook-protocol` 添加了仅记录日志的 `hook/invoked` / `hook/result` 溯源事件，用于钩子桥接。与 `compact/*` 一样，这些都不是 `SurfaceEventType`（没有 `surfaceOp`）。生成的[持久化日志事件目录](../persistence-catalog.md)列举了所有成员（核心与合并扩展的），包含其 payload、surface 标记与声明位置。

```ts type-equiv
/**
 * Shared payload for user, injected-context, and steering prompt messages. A
 * direct human prompt, a synthetic `agent.inject()` context, and mid-turn
 * steering all project into the model transcript as verbatim user-role content;
 * they are told apart by `source` (a non-`user` kind marks injected context),
 * not by event type. `meta` carries durable model-hidden producer state.
 */
interface PromptMessageData {
  /** Exact model-facing blocks, including any baked prompt-prefix contexts. */
  content: ContentBlock[]
  /** Producer provenance for the direct prompt. */
  source: MessageSource
  /** Present only when prompt-prefix contexts were baked into `content`. */
  envelope?: PromptMessageEnvelope
  /**
   * Opaque durable JSON state retained on the event but hidden from the model
   * projection. It is the intended channel for a future framing directive (a
   * producer declares the frame, a dedicated renderer applies it — see the
   * deferred note in
   * ../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md),
   * so the surface keeps projecting `content` verbatim rather than wrapping it.
   */
  meta?: JsonValue
}
```

```ts type-equiv
/**
 * The merge-extensible, append-only source of truth for an agent interaction.
 * Message history is derived from this log. Every event is lossless JSON and
 * sequence numbers stay contiguous, including raw chunks, so persistence can
 * store the canonical log verbatim.
 */
interface SessionEventMap {
  /**
   * Opens turn `turn`. `trigger` records what started it — one claimed queued
   * message or an idle-time injection. The turn is the durability/replay
   * boundary: every event sits between a `turn/start` and its matching
   * `turn/end` (the turn-enclosure invariant).
   */
  'turn/start': { turn: number; trigger: TurnTrigger }
  /**
   * Closes turn `turn` with the {@link TurnEndReason} that ended it. The loop
   * awaits `session/flush` after an ordinary turn ends before claiming the next
   * queued item. Success commits the turn; rejection is reported live and does
   * not prevent later work.
   */
  'turn/end': { turn: number; reason: TurnEndReason }
  /** Opens step `step` of turn `turn` — one model call plus the tool executions it requested. */
  'step/start': { turn: number; step: number }
  /** Closes step `step` of turn `turn`. */
  'step/end': { turn: number; step: number }
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an admitted goal continuation round. All three
   * project their `content` verbatim; `source` (with a non-`user` kind marking
   * injected context) is the only channel that tells them apart. An idle
   * injection wraps this event in a one-shot turn so the log stays turn-enclosed.
   */
  'user/message': PromptMessageData
  /**
   * Durable record of a prompt veto and its reason. It is log-only: the blocked
   * prompt never enters the model-visible surface, and its turn runs zero steps.
   */
  'prompt/blocked': { content: ContentBlock[]; source: MessageSource; reason: string }
  /** Raw stream chunk — token-level replay fidelity. */
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  /**
   * Assembled assistant message for one step (derived history uses this).
   * Carries the step's `usage` when the adapter reported token accounting, so
   * the model output and its accounting travel together (there is no separate
   * usage record). `usage` is absent when the adapter reported none.
   */
  'assistant/message': { turn: number; step: number; content: ContentBlock[]; provenance: AssistantProvenance; usage?: TokenUsage }
  /**
   * The model requested one tool invocation: `name` with the raw `arguments`
   * JSON string exactly as the model produced it (unparsed). `callId` pairs the
   * call with its `tool/result`.
   */
  'tool/call': { turn: number; step: number; callId: CallId; name: string; arguments: string }
  /**
   * A completed tool call's model-facing result, optional internal failure
   * identity, and optional tool-private `meta` presentation payload. `meta` is
   * opaque to the core (the producing tool owns its shape and reads it back in
   * `presentResult`) but MUST be JSON-serializable: `Session.append`
   * runtime-validates all event data with `isJsonValue`, so a non-serializable
   * `meta` is rejected at the source, and the durable log reproduces the
   * identical card on replay. Absent
   * unless the tool attaches one (e.g. `dsh-tool-fs` carries its result-time
   * contextual diff here).
   */
  'tool/result': {
    turn: number
    step: number
    callId: CallId
    content: ContentBlock[]
    isError: boolean
    error?: { name: string; code: string }
    meta?: JsonValue
  }
  /** Steering content injected between steps of a running turn. */
  'steering/message': PromptMessageData & { turn: number }
  /** Whole-list snapshot; latest write wins on replay. Log-only UI state; never derived history. */
  'todo/write': { todos: TodoItem[] }
  /**
   * Full header for the next request, appended inside its step before dispatch.
   * It is log-only; the latest snapshot reconstructs the request header.
   */
  'request/header': { header: EpochHeader; reason: RequestHeaderReason }
}
```

`PromptMessageData.content` 始终是确切的模型可见内容。当附加上下文声明 `prompt-prefix` 放置方式时，AgentLoop 会依次把它的块、一个 `## My request:` 分隔符以及最终生效的直接提示词拼接进该数组。可选且对模型隐藏的 `envelope` 会保留 `displayContent`，以及按顺序排列的前缀上下文来源/元数据描述信息，使 transcript（文本记录）、标题与重新引用消费方无需改变可重建历史，就能呈现人类提示词。`displayPromptContent()` 负责该选择，并为普通事件和较早的事件回退到 `content`。

### `OutOfBandSessionEventMap`：受限的带外追加显式准入

仅属于 `SessionEventMap` 并不表示事件可以脱离 agent loop（智能体循环）的常规生命周期追加。事件所有方必须通过声明合并将同一键加入这个空标记映射，`ctx.sessions.appendOutOfBand()` 才会接受该事件；派生类型还会排除所有 surface 事件。被接受的更新会并入已打开的轮次；如果没有打开的轮次，系统则为它创建一个边界配平且已刷新完成的零步骤轮次。

```ts type-equiv
/**
 * Marker map for plugin-owned log-only events accepted by
 * `SessionStore.appendOutOfBand()`. A plugin extends this map with the same key
 * it adds to {@link SessionEventMap}; surface and lifecycle events stay
 * ineligible unless their owner explicitly opts them into this narrow seam.
 */
interface OutOfBandSessionEventMap {}
```

### `TodoItem`：一条待办项

这是 `todo/write` 事件全量列表快照中的单元。它有意保持精简：一行 `content` 加一个三态 `status`（没有 id、优先级或 `activeForm`）；列表在每次写入时整体替换，因此条目无需稳定标识，而这三个状态值恰好对应 ACP 的 `PlanEntryStatus`，所以 UI 桥接层可以将待办列表一一映射为 ACP `plan`（并合成 ACP 额外要求的优先级）。见 [todo_write Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-06-29-todo-write-tool.md)。

```ts type-equiv
/**
 * One entry in an agent's todo list — the unit of the `todo/write`
 * {@link SessionEventMap} event's whole-list snapshot.
 *
 * Deliberately minimal: a human-readable `content` line and a three-state
 * `status`. No id, priority, or `activeForm` — the list is replaced wholesale
 * on every write (last-write-wins), so entries need no stable identity, and the
 * status triple is exactly the ACP `PlanEntryStatus`, so a UI bridge can map a
 * todo list onto an ACP `plan` 1:1 (synthesizing the priority ACP additionally
 * requires).
 */
interface TodoItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single task being worked now. */
  status: 'pending' | 'in_progress' | 'completed'
}
```

<a id="the-request-header-event-requestheader"></a>

### 请求头事件：`request/header`

请求信封（即 `EpochHeader`：调用配置 + 渲染后的系统提示词 + 已组装的工具 schema + 会话前缀）会作为会话状态写入日志，因此每个对话请求都是日志的纯函数（见可重建性 Agent Note）。带有 reason `'initial'` 或 `'resume'` 的完整 `request/header` 快照记录每个 agent loop 实例的边界；之后请求发生变化时，系统会以 reason `'change'` 记录另一份完整快照。`foldRequestHeader(events)` 通过选择最新快照重建请求头。该事件不是 `SurfaceEventType`，不产生 LLM 消息。

```ts type-equiv
/**
 * Logged request state outside derived history: call config, system prompt,
 * tools, and prefix. The latest full `request/header` snapshot reconstructs it;
 * canonical empty optional fields are absent.
 */
interface EpochHeader {
  /** The conversation's call configuration (provider, model, and sampling scalars). */
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

规范形式：空系统提示词、空工具列表和空会话前缀都表示为字段缺失，与请求构建方式一致。`messagePrefix` 是 `agent/session-prefix` waterfall（瀑布式事件）产物的持久记录（请求 = `messagePrefix + derived history`）；每个 agent loop 实例只组合一次，并包含在该实例记录的每份完整快照中。包含已移除的 `request/header-delta` 事件或完整快照原因为 `fallback` 的旧版 v0 日志，会在 seed、append 和持久化加载边界被拒绝，而不会以不完整方式回放。

## `SessionEvent<T>`：一条日志条目

基于 `type` 的真正可辨识联合（而非独立的 `type`/`data` 联合），因此 `switch (event.type)` 能直接收窄 `event.data`，无需类型断言。`seq` 是日志中的单调递增位置（`seq = log.length`）；`time` 为 epoch 毫秒。

```ts type-equiv
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`, `steering/message`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
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
     * or the surface nodes shadowed by a compaction replace node). An
     * `assistant/message` may carry a present empty array for a known empty
     * provider stream; omission means unrecorded provenance.
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

`SessionEventType = keyof SessionEventMap`。由于 `SessionEventMap` 可通过合并扩展，对 `SessionEvent` 的 switch 语句禁止使用 `assertNever`：插件添加的变体是合法的未知值；处理已知 case 后在 `default` 中放行。

对于 `assistant/message`，存在的 `sourceEventSeqs: []` 表示提供方流已知且完整地为空；字段缺失则表示旧格式或其他未记录溯源信息的情况。agent loop 会为每次成功的模型调用写入该字段；其他 surface 事件只要包含该字段，其列表就必须非空。

## Surface 类型

四种产生消息的类型（`SurfaceEventType`：`user/message`、`assistant/message`、`tool/result`、`steering/message`）携带 surface 元数据，用来声明它们如何加入有序的派生 surface。见 [session surface Agent Note](../../.agents/notes/implemented/architecture/2026-06-18-session-surface.md)。

### `SurfaceEventType`：事件类型中产生消息的子集

```ts type-equiv
/**
 * The subset of {@link SessionEventType} values whose events produce LLM
 * messages and are eligible to appear on the ordered surface. Only these
 * event types may carry {@link SurfaceOp} and {@link SessionEvent.sourceEventSeqs}.
 */
type SurfaceEventType =
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'
  | 'steering/message'
```

### `SurfaceOp`：事件如何进入 surface

```ts type-equiv
/**
 * How a session event entered the ordered surface. Only valid on
 * {@link SurfaceEventType} events.
 *
 * - `'append'`: added to the tail — normal path for user/assistant/tool/steering
 *   messages.
 * - `{ op: 'replace', start, end }`: replaces surface nodes from `start`
 *   (inclusive) through `end` (inclusive) with this node. Both must exist as
 *   surface nodes in the current surface. `start === end` replaces a single
 *   node. The node's {@link SessionEvent.sourceEventSeqs} must include every
 *   shadowed surface node. Used by compaction and possible other manipulations.
 */
type SurfaceOp =
  | 'append'
  | { op: 'replace'; start: number; end: number }
```

`'append'` 是常规的尾部追加路径。`replace` 会遮蔽从 `start` 到 `end`（含两端）的 surface 条目（两者都必须是有效的 surface seq；`start === end` 时仅替换单个条目），并在原位置插入新事件。

### `SurfaceIntent`：`session.append()` 的参数

```ts type-equiv
/**
 * Surface placement and provenance for {@link Session.append}. Required on
 * message-producing events and forbidden on log-only events.
 */
interface SurfaceIntent {
  surfaceOp: SurfaceOp
  /**
   * Complete known provenance source set. `assistant/message` may use a
   * present empty array for a known empty provider stream; omission means its
   * provenance was not recorded. Other surface events require a non-empty set
   * when this field is present.
   */
  sourceEventSeqs?: number[]
}
```

对 `SurfaceEventType` 事件必填：每个产生消息的事件都必须声明它如何加入 surface（派生历史的唯一来源）。非 surface 类型在编译期拒绝此参数。

此处适用相同的溯源区分：只有 `assistant/message` 可以携带存在但为空的 `sourceEventSeqs`；省略该字段并不表示其源流为空。

### `SessionSurface`：实时只读 surface 投影

`Session.surface` 返回会话稳定的 `SessionSurface` 视图。同一个增量管理器在提交前校验追加候选事件，并根据已提交事件推进该投影；调用方可以观察成员关系和替换代次，但不能调用校验。

```ts type-equiv
/** Readonly live projection of the message-producing session events. */
interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly number[]
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number
}
```

### `SurfaceFoldReplacement` 与 `SurfaceFoldResult`：完整的 surface 回放

`foldSurface(events)` 返回一份独立的当前事件 seq 列表，以及每个声明的替换范围实际遮蔽的 seq。实时管理器复用同一套状态转换，但不保留替换历史。每提交一次替换，其 `replaceGeneration` 就递增一次，使增量消费方能够区分纯尾部增长与重写。

```ts type-equiv
/** One replacement operation observed while folding a session surface. */
interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface entries removed by the operation, in surface order. */
  shadowedSeqs: number[]
}
```

```ts type-equiv
/** Complete result of replaying the surface operations in a session log. */
interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  nodes: number[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}
```

## `Session` public API

去除方法体的声明与源码中的普通类保持同步，覆盖其公共构造函数、状态访问器、追加边界和历史投影。存储操作仍由生成的 [`ctx.sessions` 服务目录](../cordis-catalog/services.md#ctxsessions--sessionstore)记录。

```ts public-api
/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create instances via `ctx.sessions.create()`.
 * Seeding with an existing event log replays/forks a session.
 */
declare class Session {
  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface;
  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is constructed bare (tests, ad-hoc replay), a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader;
  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId;
  constructor(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader);
  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[];
  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number;
  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` records provenance (the seq
   *   numbers of events this one derives from). REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier provenance, positional replacement validity, and complete
   *   shadowed-node coverage). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T>;
  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined;
  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[];
  /**
   * Project a single event into the LLM message it derives to, or null when
   * it produces none — a non-surface event (chunk, boundary, log-only record)
   * or an empty-content assistant/message (which exists only to host usage).
   * The per-node pure function {@link deriveMessages} folds over the surface;
   * an external reconstructor (or the dev invariant) folds the same function
   * over a log prefix's surface to rebuild the exact messages any request was
   * built from (the reconstructability Agent Note). The returned message wrapper is
   * fresh; its content reuses the logged event's already deep-frozen durable
   * data, so changing the wrapper cannot rewrite the log and changing content
   * throws.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null;
}
```

## 派生历史：`deriveMessages()` 与 `deriveEventMessage()`

`Session.deriveMessages()` 将事件日志投影为模型看到的 `Message[]`。它是缓存的（每个 surface 节点在首次出现时投影一次；surface 重写触发重建）且冻结的（每次调用返回一个新数组，引用共享的深冻结消息，因此通过投影修改已记录的历史在类型上不可表达）。`deriveEventMessage(event)` 是折叠所应用的逐节点纯函数，公开暴露以便外部重建器和开发不变式检查能以完全相同的规则投影日志前缀，不会与缓存产生分歧。投影规则：

- `user/message` → 一条携带确切 `content` 的 user 消息；可选 envelope 仅作为日志中的展示元数据保留。
- `assistant/message` → 一条 assistant 消息，包含事件的提供方/模型溯源信息和可选的适配器私有回放状态。原始 `assistant/chunk` 事件属于回放/UI 数据，在派生时会被**跳过**（组装后的消息才是权威）。**内容为空的** `assistant/message` 也会跳过：因 max-tokens 而截断且无内容的步骤仍会记录一条 `assistant/message` 以承载用量和溯源信息，但无内容的 assistant 轮次不得进入提供方 transcript。
- `tool/result` → 一条携带 `tool-result` 块的 user 消息。
- `user/message`（注入上下文，即非 `user` 来源）→ 按时间顺序在相应位置生成一条 user-role 消息，并原样承载其 `content`。可选的 JSON `meta` 保留在事件日志中，绝不渲染。
- `steering/message` → 按时间顺序在相应位置生成一条携带确切 `content` 的 user-role 消息；可选 envelope 仅作为日志中的展示元数据保留。

其余所有事件（`turn/*`、`step/*`、插件所有的 `llm/retry`）均为结构信息，不会投影为消息。token 记账读取每个步骤的 `assistant/chunk { type: 'usage' }` 记录；如果没有用量分片，则将 `assistant/message.usage` 作为已提交步骤的后备。失败的模型请求尝试没有 assistant 消息，因此其用量分片是持久化的记账记录。操作错误的步骤号记录在 `turn/end.reason`（`kind: 'error'`）中；如果是最终模型请求失败，其中包含规范化的 `LlmFailure` 事实，其他实时错误则包含消息/代码。由于这一尚未发布的格式有意不提供兼容性承诺，seed/load 校验会拒绝缺少提供方和模型的请求头，以及缺少提供方/模型溯源信息的 assistant 消息，而不会猜测历史数据应走的提供方路由。

## 活跃会话 fork API

`ctx.sessions.create(id, { seed, meta })` 是底层的回放/fork 原语。对于普通的活跃会话 fork，`SessionStore` 暴露一个策略 API：

- `fork(source, boundary?, childSessionId?)` 接受一个活跃的 `Session` 对象或活跃的 `SessionId`，选取到 `boundary` seq（含）为止的源事件（默认为当前最后一个事件），要求 boundary 事件必须是 `turn/end`，然后创建一个活跃的子会话，包含深克隆的种子事件和子会话元数据（`parentSession`、`seedLength` 及继承的 `cwd`）。

显式 `boundary` 允许调用者从之前完成的轮次 fork，即使源会话有更新的事件或正在进行的轮次。API 拒绝非 `turn/end` 的 boundary，而不是静默截断。更广泛的轮次封闭性检查留在既有的 `dsh-invariants` 插件和持久化修复路径中，不在 `fork()` 中重复。`dsh-subagent-fork` 保留其已完成前缀截断逻辑，因为工具时委托通常在父轮次仍然打开时启动；普通的会话分支应显式指定请求的 boundary。

## 轮次的触发原因：`TurnTriggerMap`

```ts type-equiv
/**
 * What started a turn.
 * Merge-extensible sum type (same pattern as MessageSourceMap).
 */
interface TurnTriggerMap {
  message: { kind: 'message'; source: MessageSource }
  /**
   * An out-of-band context injection (`agent.inject()`) made while the agent
   * was idle. The loop wraps the injected `user/message` (a non-`user` source,
   * plugin by default) in a one-shot turn (`turn/start` → `user/message` →
   * `turn/end`) so every event in the log stays turn-enclosed — the
   * durability/replay boundary is the turn, and a bare event between turns would
   * otherwise be indistinguishable from a crash tail on reload. The trigger's
   * `source` mirrors that message's producer.
   */
  injection: { kind: 'injection'; source: MessageSource }
}
```

<a id="why-a-turn-ended-turnendreasonmap"></a>

## 轮次的结束原因：`TurnEndReasonMap`

`aborted` 有意作为一种粗粒度的持久结果：它只记录取消中断了实时轮次，不记录是哪个运行时调用方发起取消。仅属于运行时的调用方词汇由 [`AgentCancelCause`](core.md#the-agent-handle) 定义；未来若有审计需求，应新增独立的控制请求事件，而非让终止结果承载这一信息。

```ts type-equiv
/**
 * Why a turn ended. Merge-extensible sum type.
 */
interface TurnEndReasonMap {
  completed: { kind: 'completed' }
  /** A cancellation request interrupted the live turn. */
  aborted: { kind: 'aborted' }
  /**
   * The turn failed: a step threw or the model reported a failure. `step` is the
   * step number the failure occurred on (the operational error's location — the
   * single durable record of an in-turn failure; live diagnostics also fire via
   * `agent/error`). Final model-request failures retain their normalized facts
   * as one `failure`; other turn failures retain their live Error message/code.
   */
  error: { kind: 'error'; step: number } & (
    | { failure: LlmFailure; message?: never; code?: never }
    | { message: string; code?: string; failure?: never }
  )
  disposed: { kind: 'disposed' }
  /** At least one step reached its output-token ceiling, even if a plugin continued the turn. */
  'max-tokens': { kind: 'max-tokens' }
  /**
   * Policy blocked the turn's claimed prompt before the first step. The
   * zero-step turn still records a balanced durable boundary and veto reason.
   */
  rejected: { kind: 'rejected'; reason: string }
  /**
   * A persistence backend closed a crash-orphaned turn on reload. The loop never
   * emits this marker, and the events recorded before the crash remain intact.
   */
  interrupted: { kind: 'interrupted' }
}
```

`max-tokens` 与模型调用中同名的 `FinishReason` 对应：只要轮次内有任何步骤以 `max-tokens` 结束，整个轮次就以 `max-tokens` 而不是 `completed` 结束（即使之后继续执行，截断事实仍优先），让消费方能够区分正常停止和截断停止；但它只优先于 `completed`，`disposed`/`aborted`/`error` 结果的优先级更高。`rejected` 表示一个零步骤轮次，其已认领的提示词被 `agent/prompt-submit` 钩子阻止（ACP（Agent Client Protocol）桥接层将其映射为 `cancelled`）。`interrupted` 是唯一不会由任何 loop 发出的原因：它由崩溃恢复合成（见 [persistence.md](persistence.md)）。两个 map 均可通过合并扩展。

## 轮次封闭不变式

每个会话事件都位于一个轮次**之内**（在 `turn/start` 和对应的 `turn/end` 之间）。loop 在 `turn/start` *之后*追加已排队的 `user/message` 事件；空闲时的 `agent.inject()` 会用一次性的 `injection` 轮次包住其 `user/message`；没有打开的轮次时，`appendOutOfBand()` 同样会用一个轮次包住符合条件的仅日志事件。这使轮次成为唯一的持久性/回放边界：后端可以将最后一个 `turn/end` 之后的任何内容视为崩溃中断尾部，而不会丢失合法记录在轮次之间的上下文。可选的 `dsh-session/invariant` 配套插件通过 `ctx.invariants` 在开发环境中强制此不变式（消息事件若位于打开的轮次之外便会抛出）。见[轮次封闭不变式 Agent Note](../../.agents/notes/implemented/architecture/2026-06-15-turn-enclosure-invariant.md)。

## 插件贡献的仅日志事件

插件可以通过 declaration merging 添加额外的 `SessionEventMap` 类型。这些是**仅日志**事件：不是 `SurfaceEventType`（不携带 `surfaceOp`，不参与派生历史），但与所有事件一样，必须位于一个打开的轮次内。完整的逐事件枚举（核心与插件贡献的，含 payload 与溯源信息）见生成的[持久化日志事件目录](../persistence-catalog.md)；压缩 seam 的 `compact/*` 语义在 [compaction.md](compaction.md) 中讨论。

钩子桥接层的 `hook/invoked` / `hook/result` 溯源对（来自 `@deepseek-ai/dsh-hook-protocol`）通过 `handlerId` 关联。轮次中间的钩子点（`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`）在 loop 已打开的轮次内触发，因此其 `hook/*` 记录天然位于轮次之内。`SessionStart` 不生成 `hook/*` 记录：它注入的 `user/message` 已是持久证据，而且当时没有已打开的轮次可容纳该记录（见[钩子桥接 Agent Note](../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md)）。

## 持久性契约

持久化后端依赖的契约如下：持久日志无损保存每个事件，**包括** `assistant/chunk`；`seq` 必须连续，因此不能从规范日志中过滤分片。后端可以为事件批次选择自己的存储编码，只要 `load` 返回与追加时完全一致的事件即可（JSONL 后端可选启用的打包分片行就是此类编码；见 [persistence.md](persistence.md)）。所有 `event.data` 都必须可序列化为 JSON；`Session.append` 会从源头强制这一要求（遇到不可序列化数据时抛出），因此错误事件绝不会进入日志，`session.events` 始终与后端可持久化的内容一致。新增携带不可序列化数据的事件类型，或破坏会话不变式配套插件所检查的轮次/步骤嵌套，会构成磁盘格式的破坏性变更。

消费此契约的后端见 [persistence.md](persistence.md)。
