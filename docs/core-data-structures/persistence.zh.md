# 会话持久化

[English](persistence.md) | 中文

事件日志的**持久性 seam**。[session.md](session.md) 描述了内存中的 `Session`：仅追加的 `SessionEvent` 日志即为真源。本页描述如何使该日志持久化：抽象的 `SessionPersistence` 服务、它的后端、flush 检查点、崩溃恢复，以及随日志一同存储的元数据头。日志承载的事件词汇在生成的[持久化日志事件目录](../persistence-catalog.md)中逐项列举。

该 seam 是典型的[能力 seam](../rfc/implemented/architecture/2026-06-13-capability-seams.md)：一个抽象服务（[dsh-session-persistence](../../packages/session-persistence/session-persistence)，`ctx.sessionPersistence`）在已有的 `SessionEvent` 之上定义 create/append/load/list 操作，**没有并行的持久化类型**，以及两个可互换的后端，它们通过同一套 `runPersistenceContract` 测试。详见 [session-persistence RFC](../rfc/implemented/architecture/2026-06-14-session-persistence.md)。

## flush 检查点

`session/event` 是一个*同步*通知；持久化插件对其进行缓冲（write-behind），并在 agent loop（智能体循环）于每个轮次结束时触发的 `session/flush` 检查点处排空缓冲区。flush 使用 `ctx.parallel`（被 await）：一个轮次的事件在下一个轮次开始前已被持久提交，轮次边界即提交边界。flush 拒绝时通过 `agent/error` 和 logger 报告，而非作为会话事件（那样会落在提交边界之后），因此后端保留其缓冲事件等待下一次 flush。

## 崩溃恢复保留被中断的轮次

后端重新加载一个在轮次中途崩溃的日志时，会发现一个已打开的 `turn/start` 却没有 `turn/end`。它**不会**截断日志：在长周期任务中，单个轮次可能非常庞大（许多步骤、大量工具输出），而这些事件在崩溃前已被持久追加。后端改为用一个合成的 `turn/end { reason: { kind: 'interrupted' } }` 关闭这个遗留轮次，保持日志平衡与轮次闭合不变式。`interrupted` 是唯一一个不由循环发出的 `TurnEndReason`（见 [session.md](session.md#why-a-turn-ended-turnendreasonmap)）。

## `SessionHeader`：日志旁的元数据

每个会话的元数据与事件日志**分开**存储：格式版本、cwd、血统与 seed 边界是存储层关注点而非对话事件，因此不进入 `SessionEventMap`，也不会到达 `deriveMessages()`。header 通过 `session.header` 附加到 `Session` 上。

源码：[`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
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
   * How many leading events were INHERITED via a seed rather than produced by
   * this session — the seed boundary. Set when a fork seeds a child with a
   * prefix of the parent's log (= the seeded prefix length); absent/0 means the
   * session produced all its own events. Persisted so a reload reconstructs the
   * boundary instead of re-deriving it from the full stored log, and so a replay
   * harness can skip the inherited prefix when deriving the child's OWN script
   * (the seeded events are the parent's, not this child's model calls).
   */
  readonly seedLength?: number
}
```

## `CreateSessionOptions`：seed 与元数据

通过 store 创建 `Session` 时接受 `seed`（回放/fork 已有事件日志）和 `meta`（store 折叠进 `SessionHeader` 的存储层字段）。store 填充 `version`/`id` 并默认 `createdAt`；调用方提供经过校验的绝对路径 `cwd`、`parentSession` 血统、`seedLength` seed 边界，以及仅在重建持久化会话时提供的原始 `createdAt` 以保留其值。

```ts type-equiv
interface CreateSessionOptions {
  /** Events to seed the new session with (replay/fork). */
  readonly seed?: readonly SessionEvent[]
  /**
   * Creation metadata. The store fills in `version`/`id` and defaults
   * `createdAt` to now; the caller supplies the storage-level fields (validated
   * absolute `cwd`, `parentSession` lineage, the seed boundary `seedLength`, and
   * — when reconstructing a persisted session — the original `createdAt` to
   * preserve it).
   *
   * `seedLength` is EXPLICIT, not inferred from `seed.length`: a reconstruction
   * (resume/load) seeds the WHOLE stored log, so its `seed.length` is the full
   * length, not the original boundary — the caller must pass the persisted
   * boundary back. A fresh fork passes its actual seeded-prefix length.
   */
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
  }
}
```

因此，回放/fork 的调用方式为 `ctx.sessions.create(id, { seed: seedEvents })`；将一个*持久化*会话恢复为活跃 agent 的调用方式为 `ctx.agents.resume({ resumeSessionId })`。

## 后端

两者实现相同的抽象 `SessionPersistence`（在 `SessionEvent` 之上提供 create/append/load/list），并通过 `runPersistenceContract`，证明该 seam 真正与后端无关：

- **[dsh-session-persistence-jsonl](../../packages/session-persistence/session-persistence-jsonl)**：每个会话一个仅追加的 JSONL 日志，具备崩溃安全的原子写入、上述中断轮次崩溃恢复，以及读取/回放路径。
- **[dsh-session-persistence-sqlite](../../packages/session-persistence/session-persistence-sqlite)**：基于 `node:sqlite`，每个 `SessionEvent` 一行。行结构 `(session_id, seq, type, time, data, source_event_seqs, surface_op)` 与事件 1:1 映射（包含可选的 surface 元数据），因此没有需要保持同步的并行持久化 schema。

多个后端共享同一磁盘会话时，通过[共享持久化写协调器](../rfc/implemented/architecture/2026-06-18-shared-persistence-write-coordinator.md)协调写入。
