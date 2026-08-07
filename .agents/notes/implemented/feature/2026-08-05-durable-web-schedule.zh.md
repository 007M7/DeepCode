# Agent Note: 持久、仅限 Session 内的 Web 提醒

Status: implemented

[English](2026-08-05-durable-web-schedule.md) | 中文

## 问题

在对话中创建的提醒需要跨进程重启存活，并始终归属于确切的原 Session。进程内 timer 或模型 inbox 项无法提供这种持久性，而全局 scheduler 或私有数据库又会引入第二套身份、持久化和生命周期系统。即使后续 best-effort 模型轮次失败，用户仍需要看到回执；但 dispatch 尚未到达存储的提醒绝不能提前显示。

繁忙的 Agent、长等待、墙钟变化、cold Session、fork、持久化失败和浏览器 history 竞态，使简单 timeout 无法满足要求。设计必须区分持久 record 与可丢弃的 live wait，阻止 fork 继承父 Session 的活动提醒，并合并可能晚于原始 event 到达的 presentation sidecar。

## 决策

[`examples/web-schedule`](../../../../examples/web-schedule/README.md) overlay 显式加载 `@deepseek-ai/dsh-time-context`、`@deepseek-ai/dsh-tool-schedule` 与独立 renderer `@deepseek-ai/dsh-client-ui-schedule`。默认 Web 配置树保持不变。Schedule 只观察插件加载后发布的根 Agent，并在该 Agent scope 中安装三个工具和一个可丢弃 owner。cold history 读取、已发布的根、child Agent 与其他宿主都不会激活它。

用户可见边界固定为 `session-local`：原 Session 只有在 live 时才会准点运行提醒，cold 期间不发送任何外部通知；该 Session 再次 live 后才会处理 overdue 提醒。

| 场景 | 持久事实 | live 行为 | 用户可见结果 |
| --- | --- | --- | --- |
| 创建与管理 | 原 Session 中的 `schedule/change` create／delete event | Agent-scoped 工具在读取前、变更后执行 checkpoint | 稳定 id、UTC 目标、`scheduled`／`overdue` 与 `session-local` 说明 |
| 到期时繁忙 | 活动 create 仍在 fold 中 | owner 等待 `whenIdle()`、认领 idle maintenance、排入一次 followup，再追加 dispatch | 一条可回放提醒回执；模型失败不会撤回它 |
| 进程停止或 Session cold | 活动 create 仍在 persistence 中 | 不存在 timer 或后台扫描；resume 重建 owner | 未来目标继续等待；overdue 目标尝试一次 |
| fork | 父 event 留在继承前缀 | child fold 从 `seedLength` 开始 | history 可显示父回执，但父提醒不会成为 child 活动工作 |

### Session 日志权威与工具

版本 1 `schedule/change` stream 是唯一持久 Schedule 权威。create record 拥有 Session 内不复用的品牌 id、trim 后的用户 prompt、规则与 UTC 目标。delete 和 dispatch 是终结 transition。严格 decoder 与 pure fold 会拒绝未知版本、额外字段、重复 id，以及针对非活动 record 的 transition。普通 Session 折叠完整 stream；fork 只折叠 `SessionHeader.seedLength` 位置及其后的 event。

当前规则 union 接受非空提示词与恰好一个 selector。`after_seconds` 是正 safe-integer delay，其 record 为 `{ id, kind: 'after', prompt, afterSeconds, scheduledAt }`。`at` 可以是带 `Z` 或数字 offset 的严格 RFC 3339 date-time，也可以是结构化的 `{ date, time, time_zone? }` local value；其 record 为 `{ id, kind: 'at', prompt, scheduledAt }`。两种 dispatch shape 都只保存 id，因为活动 record 已经唯一确定 occurrence。`every_seconds` 与 `cron` 仍会被拒绝，不会作为未使用字段隐藏在协议中。工具 value 派生 `scheduled` 或 `overdue`，并始终包含 `deliveryMode: 'session-local'`。

一个 Agent-scoped FIFO 会将每项已接纳的管理事务与 live owner 的到期事务从 preflight 到任何 post-append barrier 全程串行化。每项从 fold 读取或作出判断的工具操作都会先等待 `ctx.sessions.flush(session)`。create 可以在进入 FIFO 前拒绝只依赖输入 shape 的失败；preflight 成功后才分配 id、追加 create，并等待第二个 barrier。delete 在进入 FIFO 前验证其 id，随后在判断 id 是否活动前先 preflight，只有实际追加时才等待第二个 barrier。list 与未知或已终结 delete 绝不会从未确认的 live 后缀作答，也不会在自身的 barrier 前观察到 dispatch。barrier 失败会返回 `persistence_uncertain`，而不是猜测 eager write 是否已经提交。

每次成功的管理 preflight 也会要求 live owner 重新计算。这闭合了 create 已成功追加、但 post-append barrier 拒绝时的恢复路径：后续 list 可以确认 coordinator 保留的 batch、返回活动 record，并在没有 Schedule 私有重试循环的情况下 arm timer。

### Session 与请求时区归属

官方 Web create 路径要求浏览器提供 IANA 时区，在 Host 边界校验并规范化后，将其一次性存为不可变的 `SessionHeader.timeZone`。resume 保留该值，fork 复制该值；若针对相同 id 与 cwd 的另一次 create 得到的规范化时区不同，则发生冲突。Session core 保持该字段可选，使时区支持前的 Session 仍可读取，但其时区明确为 `unavailable`；绝不会用后续浏览器请求回填 legacy header。JSONL 保留该可选 header；SQLite schema v14 增加 nullable `time_zone`，并以原子方式升级自有 v13 数据库，不为既有行猜测值。

这笔精确的 v13 到 v14 事务，是对“预发布阶段默认拒绝旧存储格式”立场的一项窄幅、已规划例外：在引入时区 metadata 前，可能已经存在有效的无时区 Session 数据库。它只接受自有 v13 布局；更旧、更新或伪造的 schema 都会在不修改数据的前提下被拒绝，而且不会建立通用迁移框架。

每条 Web 提示词都会单独采样自己的 `clientTimeZone`；Host 在进入 Agent 前校验该值，并把它绑定到不可变的 `user-rpc` 消息来源。它是请求 provenance，而不是连接或 Session 的可变属性，因此并发 tab 无法相互覆盖，排队、steering（中途引导）、编辑、重试和持久化 history 都会保留来源时区。

Time-context 会委托 `agent/pre-step`，从不可变 Session header 和与消息绑定的浏览器来源为最终进入的非空批次派生时区，再向该批次追加一条模型可见读数。其来源仍是简单插件标记，不会把这些事实复制成另一份持久权威。AgentLoop 领取当前批次后才插入的 steering（中途引导）保留常规 next-step 归属，并在该步骤进入时获得新上下文。`step/start` 之前出现 reject、空决策、取消或失败时，不会记录读数；本功能也不增加 inbox 或 AgentLoop 生命周期状态。

Schedule 要求当前 open turn 中存在 time-context 标记，然后直接从该 turn 的原始 `user-rpc` 来源派生请求时区。只有派生结果包含一个与 Session 时区相等的 client 时区，才会接受隐式 local `at`。无 header 的 Session、client provenance 缺失或 mixed，或 client／Session 不匹配，都会返回 `timezone_confirmation_required` 及已知时区。显式 `time_zone` 可绕过这项歧义检查，但仍要通过相同的 IANA 校验。

### 绝对时间规范化

确定性的日历规范化由 Schedule 负责，而不是模型或进程 locale。显式 offset 输入必须匹配受支持的窄 profile，并标识一个严格位于未来、年份为四位数的时点。结构化 local 输入会校验日历和选定时区，拒绝夏令时空档，并选择重叠时段中首次出现的较早时点。成功的 create 只存储 UTC `scheduledAt`；原 offset、local 字段和用于解释的时区不会形成第二份持久表示。自然语言解释仍由模型完成，time-context 出现在工具调用之前，而不依赖结果回显。

### Persistence checkpoint 与初始化恢复

`SessionStore.flush()` 会等待所有 scoped listener，并把字面量 `true` 视为显式 durability acknowledgement。获得确认的调用会发布受包含的 `session/flushed(session, throughSeq)` observation；其中排他边界在调用入口捕获，append 通知本身不是 durability 证据。仅观察 listener 返回 void；空或只有观察者的 checkpoint 返回 `false`；任一 listener 拒绝都会在全部结算后阻止成功 observation。

persistence coordinator 只有在写路径完全停稳后才给出该确认。live controller 只保留初始 `seedEnd` 标量，不复制 seed。首次初始化拒绝后，后续 flush 会从仅追加 Session 重建该不可变前缀、读取后端实际 cursor，并只追加缺失 suffix。无论失败发生在存储变更前，还是提交后才返回拒绝，一次暂时性错误都不会永久毒化 Session 或重复写入其前缀。

### Live 交付生命周期

Agent-scoped owner 从持久 fold 派生最早目标。超长目标使用有界 timer 分段，每次 wake 都重新读取墙钟，因此回拨不会提前触发，前跳则会形成 overdue。如果 agent 已被某个轮次或另一项 maintenance task 占用，`runMaintenance()` 会拒绝此次认领；record 保持活动，并由一个 `whenIdle()` wait 触发稍后的重试。被拒绝的 persistence preflight 或被收容的 framing／同步入队失败同样会让 record 保持活动，但不会运行私有重试 timer；后续 agent 活动进入 idle，或成功的 Schedule 管理 preflight 会要求 owner 再次尝试。

获得准入的路径会先清空 pending persistence，并通过 `runMaintenance()` 认领真正的 idle phase。该任务会重新折叠确切的 Session 后缀，从而确保在认领竞态中胜出的直接管理变更之后不会跟随陈旧 dispatch；随后只采样一次 decision clock，使用 JSON-escaped id 与 prompt 构造完整固定 reminder frame，同步排入一次 `followup()`，再追加只含 id 的 dispatch。触发唤醒的 input 会保持 parked，直到 maintenance 结束，因此 driver 无法在 dispatch 进入 log 前认领消息；只有该任务释放 phase 后，owner 才会等待 dispatch barrier。framing 或同步入队失败会被收容，且不会追加 dispatch。append 失败会使该 owner fault，因为消息可能已经入队。后续 prompt admission、request checkpoint 或模型失败都不能撤回 dispatch。

Agent 或插件 dispose 会取消 timer、停止新工作、撤销三个工具注册，并等待进行中的 preflight 或 idle wait。teardown 绝不会删除持久 record。同步 followup 获得准入后、durable dispatch 前的狭窄崩溃窗口可能在恢复后重复提醒；本设计选择可见重复而非静默丢失，不承诺模型成功、用户阅读、外部副作用或 exactly-once。

### Commit-aware Web 回执

Schedule package 拥有 `scheduleReminderPresentation()`，从 create 加 dispatch 派生 `{ scheduleId, prompt, occurrenceAt }`。client renderer 会添加固定的 `session-local` 标签。当前 fork 的 `seedLength` 是 child 自有 dispatch 的硬边界。继承的 dispatch 则会与它之前最近的同 id create 配对，因为 `session/end-seed` 也会标记回放或恢复构造，而不仅标记 fork 所有权。这使恢复后的祖先回执仍可渲染，保留嵌套 generation 的 id 复用，并且绝不会改变 live ownership。

Host 在 append 时继续发送所有 raw event。它在 `WeakMap` 中按 exact live `Session` 保存一个单调 watermark；只有 `session/flushed` 前进时，才会用通用 `{ for: 'event', view }` sidecar 重投新覆盖的 dispatch event。持久 `schedule/change` 类型用于选择 client renderer。取最大值可以收容反序完成的并发 flush，按对象身份键控则阻止复用的 Session id 继承另一个生命周期的 cursor。

已附加 history 会独立 inspect persistence，只有 stored event prefix 的 header identity 与每个 event 都和 live Session 匹配时才添加 view。persistence 会把顶层缺失的 `delegationDepth` 规范写成零，因此两种形式在身份上等价；cwd、lineage、origin、时间戳、版本、id 与每个 event 仍必须精确匹配。inspect 缺失、失败、分歧或比 live 更长时，只会省略 view，raw history 仍然返回。已分离 history 本身就是持久前缀。因此复制进 fork seed 的 parent dispatch 只有在 child storage 证明该前缀后才会显示。

浏览器 Session 只有在 durable event 深度一致时才接受重复 seq，随后立即升级 sidecar，不再追加 event。尾部加载与真正的 gap repair 会将尚未覆盖的事件保留在既有 `liveBuffer` 中；已接受的 repair 快照在推进 tail 但仍留下后续已缓冲的 gap 时会启动另一次 pull，身份冲突则会触发全量重新同步。普通旧页分页会让当前数组继续接收 live tail 事件，当前 window 以下的 sidecar 则由 in-flight page 自身暂存，只有该页返回身份完全相同的事件时才附着。重连 generation 会阻止陈旧的 page 或 repair 结果以及 `finally` 块触碰重建后的 window。`TranscriptAdapter` 创建按持久事件类型键控的通用 `PresentedEventNode`。`ui-conversation` 通过 `conversation.chat.eventview` 分发，并保留可展开 JSON fallback；`ui-schedule` 则拥有双语 `schedule/change` 提醒行。

```text
schedule_create → Session create event → persistence
                                      ↓ live owner
due → admission → followup → dispatch → flush(true) → session/flushed
                                                        ↓
                                              Host late event sidecar
                                                        ↓
                                client same-seq upgrade → event-keyed UI receipt
```

## 已考虑的替代方案

**使用 `ctx.tasks`。** Task 拥有进程内工作、终态结果、收集与通知语义，而不是 Session 日志状态和可回放会话回执。复用它会让错误的生命周期成为权威。

**把提醒存入私有 SQLite 表或全局 scheduler。** 这样可以运行 cold Session，却必须增加第二套 Session 身份映射、startup 扫描、ownership lease、崩溃协议与通知政策。当前范围有意只在原 Session live 时运行。

**在 `followup()` 前 claim dispatch，或增加 exactly-once fencing。** claim-first record 会在入队失败时静默丢失用户可见提醒。跨进程 exactly-once 需要 lease、outbox、acknowledgement 与下游幂等边界，而 Session-local best-effort 模型工作不具备这些边界。

**把模型消息当作回执。** 已排队 inbox 项是进程内状态，可能在产生持久 user message 前失败。从 dispatch 派生的 Web 回执不依赖模型成功，仍然可见、可回放。

**在 append 时附加提醒 view。** `session/event` 早于 durability 结果；这样会在 flush 拒绝后显示幽灵回执。成功 watermark 让 presentation 服从提交点。

**增加 Schedule 专属 wire frame、client cache 或管理页面。** 通用 event sidecar、既有 Session window buffer、键控 slot 与面向模型工具已经能承载所需结果。平行 transport 或状态 store 会重复身份与回放逻辑。

**接管既有根或注册全局工具。** 晚接管会让插件加载顺序改变哪些不可见 timer 开始运行，并把工具暴露到支持范围之外。只面向未来根、按 Agent scope 安装，提供了单一明确生命周期。

**将进程时区或最近连接的浏览器用作默认值。** 进程时区属于部署状态，而连接级值会让某个 tab 或后续出行悄然重新解释另一个请求。不可变的 Session 默认值加上绑定到消息的 client provenance，能让分歧显现，而不创建共享的可变时区状态。

**在 Schedule 内解析任意自然语言日期，或持久化 local 输入。** 另一套语言解析器会与模型竞争，而在已解析时点旁保留 local 文本或时区，会为同一个一次性目标形成两种持久解释。模型看到 time-context 后输出一个窄结构；Schedule 校验它并存储一个 UTC 事实。

本设计不会识别或迁移任何未合入的 Schedule 实现或私有存储格式。固定 Session id、claim-before-send record、startup miss 与私有数据库都不是兼容输入。

## 验证

package 测试以逐文件 100% coverage 固定严格 decoding、transition、fork suffix、id 不复用、offset 与 local-calendar profile、IANA 校验、gap 拒绝、overlap-first 选择、mismatch confirmation、时间边界、有界等待、墙钟变化、overdue 准入、固定 framing、入队与 append 失败、barrier 恢复、注册 rollback 和完全停稳 dispose。persistence 测试依据实际 durable cursor 覆盖 new、fork 与 resumed 初始化失败、可选 header round-trip、一次真实 SQLite v13 到 v14 migration，以及 production JSONL restart。组装后的 Loader/Web restart lane 证明 pending 恢复、fork 隔离、单次 durable dispatch、无需激活 agent 的 cold-history rendering，以及再次 restart 后不重投。Host/client 测试覆盖 live、stored 与 concurrent-create 路径中的 zone identity、逐操作提示词 provenance、commit gating、反序 watermark、语义 header identity、逐 event 前缀匹配、same-seq 升级、每个 window merge 出口和 reconnect generation。

Time-context 测试覆盖最终 pre-step 消息、当前 turn 的唯一／混合／缺失时区派生、领取后 steering 进入下一步骤、取消、空值抑制、重试、精确 snapshot 来源校验和执行中释放。Schedule 测试会从持久 `user-rpc` 来源独立派生同一组请求时区，在空的续跑中复用同 turn 标记，并在缺少 open-turn 标记时 fail closed。显式 Loader 组合可以启动 source 与 built package。无密钥真实浏览器场景会通过完整工具 pipeline，针对既有的短 `after` case 和一个 absolute-time case 执行 `schedule_create`，观察 identity-matched 持久前缀，并从已附加 history 渲染 durable reminder card。刻意缺少的模型 adapter 会在 dispatch 后以错误关闭 turn，从而证明模型失败不会移除回执。

## 后果

- 提醒状态通过普通 Session persistence 跨进程重启并回放，无需新数据库或公开 service。
- cold Session 不工作、不发送外部通知；重新打开后可能交付 overdue 提醒，且每个工具／卡片都会显示 `session-local`。
- 每个 live 根只增加从 fold 派生的 timer、可选 idle wait 与一个 in-flight operation。长等待和插件卸载不会创建第二套持久状态机。
- Session 的默认时区不可变，且在较旧 history 中可能始终不可用。因此，旅行或并发 tab 可能需要显式时区，而不是悄然改变“明天 09:00”的含义。
- 通用 commit-aware event-view 路径可供其他持久 event 复用，但为 client Session window 增加了事件身份检查与 generation-aware merge 行为。
- 严格的一次性协议覆盖延迟目标和绝对时间目标。周期性规则系列仍需要显式 transition、catch-up 与 model-budget 语义，而不是休眠字段。
