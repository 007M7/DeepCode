# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.md)中逐项列举。

该 seam 是典型的[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)：一个抽象服务（[dsh-session-persistence](../../packages/session-persistence/session-persistence)，`ctx.sessionPersistence`）在现有 `SessionEvent` 上定义 locate/create/append/load/list——**没有平行的持久化类型**——以及两个可互换、通过同一套 `runPersistenceContract` 的后端。见 [session-persistence Agent Note（agent 决策记录）](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md)。

## flush 检查点

`session/event` 是一个*同步*通知；持久化插件会将其缓冲（write-behind）至 `session/flush`。循环会 await 普通 turn 的 checkpoint 后再领取下一个队列项；同步的 idle `inject()` 会调度自己的 checkpoint 而不阻塞 `send()`，dispose 仍会将其排空。成功 flush 会把已关闭 turn 作为一个单元持久提交；被拒绝的 flush 通过 `agent/error` 与 logger 报告——绝不会作为已关闭 turn 之后的 session 事件——而后端会保留已缓冲事件供下次 flush 使用。

## 崩溃恢复保留被中断的轮次

后端重新加载一个在轮次中途崩溃的日志时，会发现一个已打开的 `turn/start` 却没有 `turn/end`。它**不会**截断日志：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。后端改为用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关闭这个遗留轮次，保持日志平衡与轮次闭合不变式。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.md#why-a-turn-ended-turnendreasonmap)）。

## `SessionLocation`——可选的逐会话制品目标

`SessionPersistence.locate(meta)` 会同步解析一个归后端所有的独立制品，而不会读取、创建或 flush 它。JSONL 返回其绝对目标路径；SQLite 因各 session 共享一个数据库而返回 `undefined`。因此，返回的路径可能指向尚不存在、或还不包含当前未 flush turn 的文件；它是位置提示，不是授权或新鲜度保证。

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
  /** Unix epoch milliseconds when the session was created. */
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
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
}
```

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时会接收 `seed`（回放/fork 现有事件日志）与 `meta`（store 折叠进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并为 `createdAt` 提供默认值；调用方提供已校验的绝对 `cwd`、`parentSession` 谱系、`seedLength` 种子边界、`delegationDepth`，以及——仅在重建已持久化 session 时——需要保留的原始 `createdAt`。

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Events to seed the new session with (replay/fork). */
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
    readonly delegationDepth?: number
  }
}
```

因此，回放/fork 的调用方式为 `ctx.sessions.create(id, { seed: seedEvents })`；将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## 后端

两者都实现同一个抽象 `SessionPersistence`（在 `SessionEvent` 上执行 locate/create/append/load/list），并通过 `runPersistenceContract`，证明该 seam 确实与后端无关：

- **[dsh-session-persistence-jsonl](../../packages/session-persistence/session-persistence-jsonl)**——每个 session 一份仅追加的逻辑 JSONL 日志，默认存储为带 checksum 的连续 Zstandard frame，也可配置为原始行；支持崩溃安全的原子写入、中断 turn 恢复以及读取/回放路径。
- **[dsh-session-persistence-sqlite](../../packages/session-persistence/session-persistence-sqlite)**：基于 `node:sqlite`，每个 `SessionEvent` 一行。行结构 `(session_id, seq, type, time, data, source_event_seqs, surface_op)` 与事件 1:1 映射（包含可选的 surface 元数据），因此没有需要保持同步的并行持久化 schema。

共享同一磁盘 session 的多个后端通过[共享持久化写入协调器](../../.agents/notes/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)协调写入。
