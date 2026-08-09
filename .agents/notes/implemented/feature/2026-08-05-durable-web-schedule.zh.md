# Agent Note: 持久、仅限 Session 内的提醒

Status: implemented

[English](2026-08-05-durable-web-schedule.md) | 中文

## 问题

在对话中创建的提醒必须始终归属于确切的原 Session，并跨进程重启存活。进程内 timer 或 inbox 项无法提供这种持久性，而全局 scheduler 或私有数据库会引入第二套身份、持久化和生命周期系统。

繁忙的 Agent、长等待、墙钟变化、cold Session、fork、持久化失败和 teardown，使简单 timeout 无法满足要求。设计必须区分持久 record 与可丢弃的 live wait，并阻止 fork 继承父 Session 的活动提醒。

## 决策

[`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay 显式加载 `@deepseek-ai/dsh-tool-schedule`；默认 Web 配置树保持不变。Schedule 只观察插件加载后发布的根 Agent，并在该 Agent scope 中安装三个工具和一个可丢弃 owner。cold history 读取、已发布的根、child Agent 与其他宿主都不会激活它。

用户可见边界固定为 `session-local`：原 Session 只有在 live 时才会准点运行提醒，cold 期间不发送任何外部通知；该 Session 再次 live 后才会处理 overdue 提醒。到期工作会等待 Agent 完全 idle，再通过 `followup()` 进入普通的下一轮队列；它绝不会中途引导当前轮次。原设计中独立 Web 回执的部分已由[对话式 Schedule 交付](../simplification/2026-08-09-conversational-schedule-delivery.md)取代。

| 场景 | 持久事实 | live 行为 | 用户可见结果 |
| --- | --- | --- | --- |
| 创建与管理 | 原 Session 中的 `schedule/change` create／delete event | Agent-scoped 工具在读取前、变更后执行 checkpoint | 稳定 id、UTC 目标、`scheduled`／`overdue` 与 `session-local` 说明 |
| 到期时繁忙 | 活动 create 仍在 fold 中 | owner 等待 `whenIdle()`、认领 idle maintenance、排入一次 follow-up，再追加 dispatch | 稍后的普通对话轮次 |
| 进程停止或 Session cold | 活动 create 仍在 persistence 中 | 不存在 timer 或后台扫描；resume 重建 owner | 未来目标继续等待；overdue 目标尝试一次 |
| fork | 父 event 留在继承前缀 | child fold 从 `seedLength` 开始 | 父提醒不会成为 child 活动工作 |

### Session 日志权威与工具

版本 1 `schedule/change` stream 是唯一持久 Schedule 权威。create record 拥有 Session 内不复用的品牌 id、trim 后的用户 prompt、规则与 UTC 目标。delete 和 dispatch 是终结 transition。严格 decoder 与 pure fold 会拒绝未知版本、额外字段、重复 id，以及针对非活动 record 的 transition。普通 Session 折叠完整 stream；fork 只折叠 `SessionHeader.seedLength` 位置及其后的 event。

当前规则接受非空 prompt 与恰好一个正 safe-integer `after_seconds`。record 形状是 `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`；dispatch 只保存 id，因为 record 已经唯一确定 occurrence。`at`、`every_seconds`、`cron` 与 `time_zone` 会被拒绝，不会作为未使用字段隐藏在协议中。工具 value 派生 `scheduled` 或 `overdue`，并始终包含 `deliveryMode: 'session-local'`。

一个 Agent-scoped FIFO 会将每项已接纳的管理事务与 live owner 的到期事务从 preflight 到任何 post-append barrier 全程串行化。每项从 fold 读取或作出判断的工具操作都会先等待 `ctx.sessions.flush(session)`。create 可以在进入 FIFO 前拒绝只依赖输入 shape 的失败；preflight 成功后才分配 id、追加 create，并等待第二个 barrier。delete 在进入 FIFO 前验证其 id，随后在判断 id 是否活动前先 preflight，只有实际追加时才等待第二个 barrier。list 与未知或已终结 delete 绝不会从未确认的 live 后缀作答，也不会在自身的 barrier 前观察到 dispatch。barrier 失败会返回 `persistence_uncertain`，而不是猜测 eager write 是否已经提交。

每次成功的管理 preflight 也会要求 live owner 重新计算。这闭合了 create 已成功追加、但 post-append barrier 拒绝时的恢复路径：后续 list 可以确认保留的 batch、返回活动 record，并在没有 Schedule 私有重试循环的情况下 arm timer。

### Live 交付生命周期

Agent-scoped owner 从持久 fold 派生最早目标。超长目标使用有界 timer 分段，每次 wake 都重新读取墙钟，因此回拨不会提前触发，前跳则会形成 overdue。如果 agent 已被某个轮次或另一项 maintenance task 占用，`runMaintenance()` 会拒绝此次认领；record 保持活动，并由一个 `whenIdle()` wait 触发稍后的重试。被拒绝的 persistence preflight 或被收容的 framing／同步入队失败同样会让 record 保持活动，但不会运行私有重试 timer；后续 agent 活动进入 idle，或成功的 Schedule 管理 preflight 会要求 owner 再次尝试。

获得准入的路径会先清空 pending persistence，并通过 `runMaintenance()` 认领 idle phase。该任务会重新折叠确切的 Session 后缀，只采样一次 decision clock，使用 JSON-escaped id 与 prompt 构造完整固定 reminder frame，同步排入一次 `followup()`，再追加只含 id 的 dispatch。触发唤醒的 input 会保持 parked，直到 maintenance 结束，因此 driver 无法在 dispatch 进入 log 前认领消息；只有该任务释放 phase 后，owner 才会等待 dispatch barrier。

dispatch 记录的是队列准入，而不是模型完成或用户收到提醒。framing 构造或同步入队失败不会追加 dispatch。append 失败会使该 owner fault，因为消息可能已经入队。后续 prompt admission、request checkpoint 或模型失败都不能撤回 dispatch。Agent 或插件 dispose 会取消 timer、停止新工作、撤销三个工具注册，并等待进行中的 preflight 或 idle wait，且不会删除持久 record。

## 已考虑的替代方案

**使用 `ctx.tasks`。** Task 拥有进程内工作、终态结果、收集与通知语义，而不是 Session 日志状态和对话 follow-up。复用它会让错误的生命周期成为权威。

**把提醒存入私有 SQLite 表或全局 scheduler。** 这样可以运行 cold Session，却必须增加第二套 Session 身份映射、startup 扫描、ownership lease、崩溃协议与通知政策。当前范围有意只在原 Session live 时运行。

**在 `followup()` 前 claim dispatch，或增加 exactly-once fencing。** claim-first record 会在入队失败时静默丢失用户可见提醒。跨进程 exactly-once 需要 lease、outbox、acknowledgement 与下游幂等边界，而 Session-local best-effort 模型工作不具备这些边界。

**接管既有根或注册全局工具。** 晚接管会让插件加载顺序改变哪些不可见 timer 开始运行，并把工具暴露到支持范围之外。只面向未来根、按 Agent scope 安装，提供了单一明确生命周期。

本设计不会识别或迁移任何未合入的 Schedule 实现或私有存储格式。固定 Session id、claim-before-send record、startup miss 与私有数据库都不是兼容输入。

## 验证

package 测试固定严格 decoding、transition、fork suffix、id 不复用、时间边界、有界等待、墙钟变化、overdue 准入、固定 framing、入队与 append 失败、barrier 恢复、注册 rollback 和完全停稳 dispose。production JSONL restart 测试通过真实 Agent 生命周期恢复一条 overdue record，并证明后续再次 restart 不会重复 dispatch。显式启用的 Loader 组合可启动该 package，无密钥浏览器场景会通过完整工具 pipeline 执行 `schedule_create`，并为普通 assistant follow-up 生成快照。

## 后果

- 提醒状态通过普通 Session persistence 跨进程重启并回放，无需新数据库或公开 service。
- cold Session 不工作、不发送外部通知；重新打开后可能交付 overdue 提醒。
- 每个 live 根只增加从 fold 派生的 timer、可选 idle wait 与一个 in-flight operation。
- 同步 follow-up 获得准入后、持久 dispatch 前的狭窄崩溃窗口可能在恢复后重复提醒；本设计选择可见重复而非静默丢失，不作 exactly-once 承诺。
- 严格的 after-only 协议有意保持小型；其他规则系列需要显式 record、时间与 recurrence 语义，而不是 dormant 字段。
