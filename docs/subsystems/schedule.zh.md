# 仅限 Session 内的 Schedule

[English](schedule.md) | 中文

Schedule 拥有持久提醒；这些提醒会作为普通的后续对话轮次返回原 live Session。[持久 Schedule Agent Note](../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) 负责持久化与生命周期决策，[对话式交付](../../.agents/notes/implemented/simplification/2026-08-09-conversational-schedule-delivery.md) 负责无回执边界。本页记录 [`packages/schedule/tool-schedule/src/types.ts`](../../packages/schedule/tool-schedule/src/types.ts) 中的持久数据形状和面向模型的数据形状；[包 README](../../packages/schedule/tool-schedule/README.md) 负责组合、工具行为与确切的提醒 framing。

## 持久记录

`ScheduleId` 是[品牌化 id](core.md#branded-ids)，在单个 Session 内唯一且绝不复用。版本 1 最初只支持正的安全整数 `after_seconds` 选择器。创建操作会将选定目标规范化为使用四位年份的 RFC 3339 UTC `scheduledAt`；记录仍保留提交的延时，以便 list 结果说明生成该目标所用的规则。

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator; v1 supports only delayed one-shot reminders. */
  readonly kind: 'after'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** The v1 durable reminder record union. */
type ScheduleRecord = AfterScheduleRecord
```

## 持久变更与回放

版本 1 的 `schedule/change` 会话事件是 Schedule 唯一的持久权威。create 保存完整记录。delete 与 dispatch 是一次性提醒的终结性、仅含 id 的转换；dispatch 表示 follow-up 已同步入队，而不表示模型答复成功或用户已读取答复。

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface ScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Strict version-1 durable Schedule mutation union. */
type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange
```

严格 decoder 与 fold 会拒绝未知版本、额外字段、重复使用的 id，以及针对非活动记录的 delete 或 dispatch 转换。普通 Session 折叠完整事件流。fork 只折叠 `SessionHeader.seedLength` 位置及其后的事件，因此保留历史，但不会接管父 Session 的活动提醒。`schedule/change` 声明和源码位置也编入[持久化目录](../persistence-catalog.md#schedulechange--log-only)。

## 活动视图与管理

工具值将持久记录与根据当前墙钟派生的交付状态组合起来。`session-local` 表示原 Session 必须处于 live 状态：不存在外部通知渠道或 cold Session scheduler。

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Fixed v1 delivery boundary: the original session must be live. */
type ScheduleDeliveryMode = 'session-local'
```

```ts type-equiv
/** Complete model-facing view of one active after reminder. */
interface ScheduleView extends AfterScheduleRecord {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}
```

生成的[工具目录](../tool-catalog.md#deepseek-aidsh-tool-schedule)负责 `schedule_create`、`schedule_list` 和 `schedule_delete` 的参数与结果 schema。一条 Agent-scoped 队列将管理调用与到期工作串行化。每次读取或判断都会先等待共享的 Session 持久化 barrier；create 与实际执行的 delete 在追加后还会再次等待。barrier 失败会报告 `persistence_uncertain`，而不是猜测 eager write 是否已提交。其他稳定错误代码是 `invalid_prompt`、`invalid_selector`、`invalid_rule`、`time_out_of_range`、`corrupt_schedule_log` 和 `internal_error`。

## Live 交付

进程内 owner 根据持久 fold 派生最早的 timer，并在每次有界等待后重新读取墙钟。cold Session 不执行任何工作；重新打开后会重建 timer，并使已经过去的目标进入 overdue 状态。overdue 提醒会先等待 Agent 完全 idle 并认领 maintenance phase，再重新折叠状态、将 `followup()` 排入队列并追加 dispatch。它绝不会调用 `steer()`，也绝不会中断当前轮次。

获得准入的 follow-up 会启动一个普通的后续轮次，且只通过普通对话 transcript（文本记录）出现；Schedule 不提供独立的持久 Web 回执或浏览器渲染器。如果 framing 构造或同步队列准入失败，则不会记录 dispatch，提醒仍保持活动。follow-up 获得准入后、持久 dispatch 前的狭窄崩溃窗口可能使提醒在恢复后重复，因此该边界提供的是尽力而为的至少一次交付，而非恰好一次交付。
