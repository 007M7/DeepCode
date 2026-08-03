# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.md)中逐项列举。

该 seam 是典型的[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：一个抽象服务（[dsh-session-persistence](../../packages/session-persistence/session-persistence)，`ctx.sessionPersistence`）在现有 `SessionEvent` 上定义 locate/create/append、会执行崩溃修复的 load、不会修改数据的 inspect，以及轻量的 list/snapshot 观察——**没有平行的持久化类型**——以及两个可互换、通过同一套 `runPersistenceContract` 的后端。见 [session-persistence Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)。

## flush 检查点

`session/event` 是一个*同步*通知；持久化插件会将事件复制到逐会话控制器，并立即启动写入而不阻塞生产方。并发事件会加入当前批次；在该批次写入期间接纳的事件会触发后续批次。`session/flush` 会等待当前与待处理批次全部清空，因此循环仍将其用作在领取下一个普通轮次之前的顺序与错误观察检查点。立即写入被拒绝时会保留对应事件；显式 flush 会重试这些事件，并通过 `agent/error` 和 logger 报告失败，绝不会把失败记录成已关闭轮次之后的会话事件。dispose（资源释放）会执行同样的最终排空。

## 崩溃恢复保留被中断的轮次

后端重新加载一个在轮次中途崩溃的日志时，会发现一个已打开的 `turn/start` 却没有 `turn/end`。它**不会**截断日志：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。后端改为用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关闭这个遗留轮次，在不改变其前后任何独立事件的情况下配平被中断的执行。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.md#why-a-turn-ended-turnendreasonmap)）。

修复仅适用于冷会话。对于活跃 id，`SessionPersistence.load(id)` 会对内存日志拍摄快照，等待该快照完成持久化，并且只在日志平衡时连同已存储的 header 返回；若活跃轮次仍未闭合，则拒绝操作，而不是添加合成的中断边界。由协调器管理的冷加载会在后端读取和修复写入期间占用该 id，因此并发发布同 id 的活跃会话会被拒绝并回滚。HMR 也会接管活跃前缀，而不会关闭其中正在进行的轮次。

`SessionPersistence.inspect(id)` 是恢复机制面向观察方的对等操作：它返回已存储有效前缀的独立副本，不截断不完整记录、不添加中断结束事件，也不发布写入状态。同 id 串行化确保它与后端写入保持一致。派生读取模型使用 `inspect`，绝不使用 `load`，因此即使活跃所有权并发建立，观察已落检查点但仍未闭合的轮次也不会修改日志。

## `SessionLocation`——可选的逐会话产物目标

`SessionPersistence.locate(meta)` 会同步解析一个归后端所有的独立产物，而不会读取、创建或 flush 它。JSONL 返回其项目/会话目录内 transcript（文本记录）的绝对路径；SQLite 因各会话共享一个数据库而返回 `undefined`。因此，返回的路径可能指向尚不存在、或还不包含当前尚未 flush 的轮次；它是位置提示，不是授权或新鲜度保证。

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

## `SessionHeader`：日志旁的元数据

每个会话的元数据与事件日志**分开**存储：格式版本、cwd、血统与 seed 边界是存储层关注点而非对话事件，因此不进入 `SessionEventMap`，也不会到达 `deriveMessages()`。header 通过 `session.header` 附加到 `Session` 上。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
}
```

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时会接收 `seed`（初始回放或 fork 历史）与 `meta`（store 折叠进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并为 `createdAt` 提供默认值；调用方提供已校验的绝对 `cwd`、`parentSession` 谱系、`seedLength` 种子边界、可选的粗粒度 `origin`、`delegationDepth`，以及——仅在重建已持久化会话时——需要保留的原始 `createdAt`。`origin: 'subagent'` 让产品导航能够隐藏重复的 child 行；它不证明描述符有效，也不证明 child 可以恢复。

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
  }
}
```

因此，回放/fork 的调用方式为 `ctx.sessions.create(id, { seed: seedEvents })`；将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## 轻量源修订号

派生状态的消费方会在加载完整事件日志之前比较一个低开销的不透明修订号。其表示由持久化后端拥有，并随 append 或会修改数据的 load 修复以事务方式改变；调用方仅比较修订号是否相等。

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/** Lightweight immutable source identity returned without loading a full log. */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
}
```

## 后端

两者都实现同一个抽象 `SessionPersistence`（在 `SessionEvent` 上执行 locate/create/append/load/inspect/list/listSnapshots），并通过 `runPersistenceContract`，证明该 seam 确实与后端无关：

- **[dsh-session-persistence-jsonl](../../packages/session-persistence/session-persistence-jsonl)**——每个会话一份仅追加的逻辑 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；支持崩溃安全的原子写入、被中断轮次的恢复以及读取/回放路径。
- **[dsh-session-persistence-sqlite](../../packages/session-persistence/session-persistence-sqlite)**：基于 `node:sqlite`，每个 `SessionEvent` 一行。行结构 `(session_id, seq, type, time, data, source_event_seqs, surface_op)` 与事件 1:1 映射（包含可选的 surface 元数据），因此没有需要保持同步的并行持久化 schema。
