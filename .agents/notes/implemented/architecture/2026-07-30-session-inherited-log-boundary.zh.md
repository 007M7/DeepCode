# Agent Note: 继承历史日志边界

Status: implemented

[English](2026-07-30-session-inherited-log-boundary.md) | 中文

## Problem

拥有独立开／闭括号的插件无法区分一个已死的标记和一个存活的标记。`compact/start` … `compact/end` 就是已发布的实例：当接手一份日志、而它最后的压缩事件是一个未配对的 `compact/start` 时，"上一个写入方在压缩中途死掉了"与"此刻正有一次压缩在运行"在存储历史中是逐字节相同的。所有方只能二选一：拒绝压缩一份其实空闲的日志（把会话卡死），或者在一份确实繁忙的日志上继续压缩。

日志中没有任何东西标出继承历史在哪里结束。`session/created`、`session/disposed` 与 `session/flush` 是 cordis 运行时信号，不是日志事件；`agent/session-start` 只发射不落盘。`Session.firstLiveSeq` 本来就精确地持有这个答案——本生命周期第一次自有写入的 seq——但只存在于内存中，因此读取存储字节的消费方看不到它。

崩溃修复既没有填上这个缺口，也不应该去填：`interruptedTurnClosers` 合成轮次、步骤与工具边界，是因为核心拥有那套词汇表，而 `compact/*` 属于压缩 seam。一个会关闭插件括号的核心修复流程，等于把每个插件的括号语义都搬进核心。

## Decision

`Session` 的构造函数把仅日志事件 `session/inherited` 作为带种子会话的第一次实时写入追加，位置正是 `firstLiveSeq` 指出的 seq。该事件是那个字段的持久投影：`firstLiveSeq` 为持有对象的消费方回答"我继承了哪一段前缀"，该事件则为只持有存储字节的消费方回答同一问题。它的 payload 为空——位置与 `time` 承载全部含义——并且不是 `SurfaceEventType`，因此不产生消息，也无法扰动派生历史。

`isInheritedSeq(events, seq)`（由 `dsh-session` 导出）是括号所有方在一个未配对开启标记上调用的谓词。为真意味着该标记属于一个已结束的生命周期，不可能仍在运行。核心写入该边界但不从中读取任何内容；每个括号的词汇表仍归其所属插件。

选择构造函数，是因为它是每一个带种子会话都必经的唯一收窄处。全部六个入口都会到达它：`agents.resume()`、在已持久化 id 上的配置驱动启动（`restoreOrCreateConfigured`）、`sessions.fork()`、子代理 fork 子会话、`coordinator.adopt()` 的实时前缀路径，以及裸的 `sessions.create(id, {seed})`。在持久化加载时写入的边界会漏掉两条 fork 路径——而一个继承了仍在运行的父会话开放 `compact/start` 的 fork 子会话，恰恰是该谓词必须判定的场景。在 loop 启动时写入的边界会漏掉 `fork()` 与 `adopt()`，并且不得不在 `SessionStartSource: 'startup'` 上触发——那正是 fork 子会话发布的取值，于是该字段将不再具有区分力。

两条守卫让这个标记不至于变成噪声。空种子不写入任何内容：下方什么都没有的边界标记不了任何东西。种子本身已以该事件结尾时不会重复标记，这让写入具备幂等性。幂等性是承重的，而不是为了整洁——`agentFor()` 会在首次触碰时恢复一个冷会话，因此在客户端里仅仅打开一个会话就是一次接手；没有这条守卫，浏览会让日志每访问一次就增长一个事件。

## 持久化无需任何改动

协调器捕获创建种子时该标记已在 `session.events` 中，因此它通过普通的种子路径落盘——`onCreated` 的 `createCore` + `appendCore`，或无主认领的后缀写入。没有加载路径写入、加载时没有 revision 递增、被拒绝的 `append` 不留下持久标记，只读存储依然可以服务加载。

作为实时事件，它经由后写式 drain（`session/event` → `live.pending` → `scheduleDrain`）而不是同步提交到达磁盘，因此崩溃可能丢掉它。这没有代价：`pending` 按序 drain，所以丢掉一个边界意味着它上面的每个实时事件也一起丢掉，而下一次接手读到的字节与上一次相同，会追加自己的边界，并对括号作出完全相同的判定。进程内消费方应优先使用 `firstLiveSeq`，它在任何写入之前就是精确的。

## 保证的适用范围

该谓词对*本*会话继承的括号成立，而不是关于其他写入方的存活信号。一个并发存活的会话可能在同一段存储历史上持有开放括号，而它自己的边界在别处。必须容忍并发写入方的消费方需要日志之外的存活信号，不能仅凭这个事件就省掉它。

## Alternatives considered

**由持久化协调器的冷加载路径写入边界。** 最先实现的方案，即 [`session/resumed` 边界](../../rejected/architecture/2026-07-29-session-resumed-log-boundary.md)，在合并前被放弃。它完全覆盖不到 fork，而 fork 恰恰是继承括号的所有方可能仍然存活的那一种情形。由于标记是在加载时铸造的，它还必须在读取路径上做持久写入，这把成本铺开到整个 seam：每次冷加载都递增 revision、对一份无需修复的平衡日志也要走 `commitRepair`、需要一个已存储时间下限来维持钳制的单调性，以及加载在只读存储上会失败。

**在 loop 启动时追加边界。** loop 位于 `resumeWith` 上一层，因此覆盖恢复路径，但完全漏掉 `fork()` 与 `adopt()`，而且事件不得不在 `'startup'` 上触发——那是 fork 子会话发布的来源——于是 `SessionStartSource` 将不再具有区分力。它还会在追加标记之前就发布会话，因此 `session/created` 监听方可能观察到一份没有边界的带种子日志。

**复用 `header.seedLength`。** 它是持久的 *fork 血缘*边界，并且刻意在恢复时保留原始 fork 取值——而恢复时构造种子是整份存储日志。这两个事实并不相同，混同会同时失去两者。

**让崩溃修复连同轮次边界一起关闭 `compact/*`。** 否决：这会把每个插件的括号语义搬进核心的修复流程，而核心无法知道关闭另一个包的括号应该记录什么。

## Consequences

买到的：一个谓词，位于一处，对全部六条带种子启动路径都正确——包括持久化层方案触及不到的 fork 缺口。持久化各包保留纯读取路径。`firstLiveSeq` 获得一个持久孪生体，而不是关于同一边界的第二套彼此竞争的概念。

代价：带种子会话的日志长了一个事件，这在九个包（session、agent-loop、持久化契约、jsonl、session-query、session-title、subagent-inprocess、telemetry、token-meter）里挪动了 seq 期望。其中两处更新是承重的而非机械的：telemetry 的收养测试现在断言该边界*会*被导出，因为它是本生命周期的自有写入；而属性测试套件的重放不变式被重述为"种子逐字节复现，外加一个仅日志边界"，并把幂等性补成一条独立属性。

`session/inherited` 加入了落盘词汇表。在预发布立场下（`SESSION_FORMAT_VERSION` 固定为 `0`，不作兼容承诺），更旧的日志只是没有它，而没有边界的日志会正确地报告没有任何内容被继承。

此处未做：还没有任何插件消费 `isInheritedSeq`。把压缩 seam 的陈旧性检查接到它上面，是催生这条边界的后续工作，应当与那个 seam 自己的测试一起完成。
