# 消息反馈

[English](feedback.md) | 中文

[`@deepseek-ai/dsh-message-feedback`](../../packages/feedback/message-feedback)拥有针对单条 assistant 消息的可编辑反馈。它刻意与不可变的 Session 级 `feedback/record` 事件分离：message feedback 是本地 storage-domain 伴随记录（sidecar），不是 Session 日志内容或投影，也不执行遥测交接。

来源：[`packages/feedback/message-feedback/src/types.ts`](../../packages/feedback/message-feedback/src/types.ts)

## 数据与并发

每个 Session 的一条伴随记录包含 header 身份 `{createdAt, cwd}` 和以 `MessageId` 为键的反馈条目。每个条目携带好评或差评、可选备注、Host 分配的 `createdAt`/`updatedAt` 时间戳及自己的 opaque version。version 只能用于相等比较，且只与目标消息比较；调用方不能排序或自行合成它。

`put` 采用严格乐观并发：已有条目的每次请求都必须匹配当前 `ifVersion`，即使请求不会改变目标值。冲突会返回权威当前条目（不存在时为 `null`），因此调用方无需额外读取，即可协调丢失响应或并发编辑。删除已经不存在的条目同样成功。按 Session 划分的队列覆盖检查、读取、冲突判断与整行写入，因此这些保证适用于单个 Host 进程中的并发调用。

## 目标与生命周期权威

`SessionPersistence.inspect()` 提供目标 Session 的观测，且不会发布或恢复 Agent，也不会提交 cold repair。cold 路径先由 `listSnapshots()` 预检明确不存在；已进入目录的 Session 若检查失败，会按基础设施故障原样传播。`put` 只接受具有指定 `MessageId` 的非空、append-origin `assistant/message`；replacement-origin、仅承载 usage 的空记录和非 assistant 记录都不是反馈目标。

存储的 `{createdAt, cwd}` 身份必须与检查所得 header 匹配。不匹配按不存在处理：`list` 返回空条目，`put` 则可用绑定当前 header 身份的新记录替换陈旧行。fork 使用新的 Session 身份，即使种子包含相同消息，也不获得伴随记录副本。

## 持久化与 Remote 契约

服务通过 `ctx.storageDomain` 在 `message_feedback` 存储域中保存完整 Session 行。`put` 提交引用目标消息的伴随记录前，身份匹配的 live 目标先经过权威 `ctx.sessions.flush` checkpoint；随后 live 与 cold 路径都会通过 `SessionPersistence.readFrom` 从序列零做物理复读。写入伴随记录前会再次校验所得观测，因此目标日志的持久提交始终先于其伴随记录。`maxNoteBytes` 为必填项，按 UTF-8 字节限制备注文本；Web Host 组合将其设为 `8192`。该包通过 `GatewayService` 与 `@Remote` 发布 Host `messageFeedback.list`、`messageFeedback.put` 和 `messageFeedback.delete` 一元 Remote 契约；下方生成的 Cordis surface 是方法级权威。

## 边界与限制

- 客户端 Remote 聚合挂载与 UI 消费方由各自边界负责并保持延后。
- 变更队列仅在进程内生效。storage-domain 没有跨进程条件写，因此多个 Host 写入同一存储根目录时，不提供 compare-and-swap 或防止丢失更新的保证。
- Session persistence 没有持久删除接口。服务不把 `session/disposed` 或 `host/session-removed` 当作删除，因此不伪造级联；在带外移除日志后，孤儿伴随记录可能继续存在。
- 请求若恰好落在 live detach 之后、persistence catalog 物化 header 之前的极短窗口，可能收到 `session-not-found`；调用方应在 retirement materialization 后重试。
- 只有 `{createdAt, cwd}` 不同时，header 身份才能识别复用的 id；本契约无法区分保留相同 header 身份的克隆日志。
- Host 契约不记录已认证的 actor 或审计身份，因此假设调用方边界可信。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis surface

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` surface lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmessagefeedback--messagefeedbackservice"></a>

### `ctx.messageFeedback` — `MessageFeedbackService`

Storage-domain sidecar service. It inspects persisted Session history and never creates or resumes an Agent or Session.

```ts cordis-catalog
/**
 * Read feedback belonging to the current persisted Session lifecycle.
 * A stale row from a reused Session id is invisible.
 * @param request - Session identity to inspect and list.
 * @returns current immutable items or `session-not-found`.
 */
@Remote('list') async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>

/**
 * Create or replace feedback for one derived append-origin assistant
 * message. Every request must match the addressed item's current version;
 * a matching no-op returns the stored item without changing its revision.
 * @param request - target, desired value, and observed item version.
 * @returns the committed item or an explicit business failure.
 */
@Remote('put') put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>

/**
 * Delete one feedback item. Absence is successful regardless of the
 * supplied version; an existing item requires an exact version match.
 * @param request - Session, message, and observed item version.
 * @returns the stable absent postcondition, or an explicit failure.
 */
@Remote('delete') delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
```

Source: [`packages/feedback/message-feedback/src/index.ts:150`](../../packages/feedback/message-feedback/src/index.ts)
<!-- END GENERATED cordis-surface -->
