# RFC：会话持久化——基于既有 `SessionEvent` 的抽象服务

Status: implemented

[English](2026-06-14-session-persistence.md) | 中文

## 问题

会话此前只存在于内存中。示例插件 `session-jsonl.ts`（在两个 examples 目录中逐字节重复）是只写的遥测：它缓冲 `session/event` 并追加 JSON 行，没有读取/回放路径，没有崩溃安全性（无 fsync、无原子写入、dispose 时 fire-and-forget 地排空缓冲区），没有列表功能，也没有格式版本控制。没有任何东西能把磁盘上的历史会话重新注入一个活跃的 agent，因此持久恢复（「继续昨天的任务」）、持久 fork，以及 ACP 的 `session/load` 方法（[ACP 支持](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md)）都不可能实现。

[事件溯源模型](2026-06-11-event-sourced-sessions.md)将仅追加日志作为唯一真源，并从中派生 LLM 历史。持久化必须忠于这一点：直接持久化既有的 `SessionEvent`，不引入需要来回转换的并行「持久化消息」类型。后端也必须可替换——当前是文件存储，将来是数据库存储——统一在一个接口之后。

## 决策

持久化是一个抽象的**能力 seam**（[能力 seam](2026-06-13-capability-seams.md)，`dsh-bash` 模板），而非循环或核心逻辑：

1. **接口**（`dsh-session-persistence`，`ctx.sessionPersistence`）：一个抽象的 `SessionPersistence` 服务，提供 `create`/`append`/`load`/`list`。其持久化单元就是既有的 `SessionEvent`（`{ type, seq, time, data }`），逐字复用，无转换类型。
2. **实现**（`dsh-session-persistence-jsonl`）：每个会话一个仅追加的 JSONL 日志（一行 `SessionHeader`，之后每行一个 `SessionEvent`，逐字保留**包括 `assistant/chunk`**）。

以下关键选择记录于此，因为它们是持久的、有争议的、且出人意料的：

- **规范持久日志逐字保留每个 `SessionEvent`，包括 `assistant/chunk`。** `deriveMessages()` 跳过 chunk，过滤 chunk 的方案（Codex 的 `policy.rs`）很有吸引力，但 `seq = log.length` 以及加载校验 `events[i].seq === i` 要求日志*连续*；过滤掉 chunk 会留下空洞，同时破坏契约和恢复功能。未来可以将过滤 chunk 的投影作为带独立重编号的派生视图，但它不是规范日志。
- **仅追加；崩溃的轮次被关闭，而非截断。** 已刷写的 `turn/end` 之前的事件永不重写，且循环只在轮次结束时刷写。由于一个被中断的轮次可能包含大量有效工作，`load` 会保留其中连续且可解析的事件，并为未应答的工具调用追加错误结果、补一个缺失的 `step/end`，以及带 `{ kind: 'interrupted' }` 的 `turn/end`。这些合成结果使恢复后的 provider transcript 保持有效。只有不完整的最后一条记录会被丢弃；如果在最后一个真实 `turn/end` 或之前出现解析错误或序号间隙，则视为损坏，该会话不可加载。
- **文件后端为规范实现，数据库后端为已验证的可替换方案。** `SessionEvent` 1:1 映射为一行 `(session_id, seq, type, time, data)`：`append` 是 INSERT（在一个断言连续 seq 契约的事务中），`load` 是 SELECT … ORDER BY seq。`dsh-session-persistence-sqlite` 正是如此：一个 `SessionPersistence` 子类，接口不变（opencode 在 SQLite/WAL 上运行的正是这个形状），且它通过与 JSONL 后端相同的 `runPersistenceContract` 套件——因此契约以相同的语义（惰性物化、加载时关闭中断轮次、连续 seq）约束两个后端，一次表达在文件字节上，一次表达在行上。
- **元数据在日志之外。** 格式版本、cwd 和谱系是存储关注点，不是可回放的对话状态，因此它们存放在 `dsh-session` 拥有的 `SessionHeader` 中，通过新的只读属性 `session.header` 附加到 `Session`——永远不在 `SessionEventMap` 中，永远不会到达 `deriveMessages()`。替代方案（一个可合并扩展的 `session/meta` 事件作为日志第 0 行）被否决：日志内事件在 seed/fork 会话时可以免费携带，但元数据不是可回放状态，因此显式的日志外 header seam 是更干净的代价。（header 最初被拆分为不可变的 `SessionHeader` 加可变的 `SessionSummary`，二者的联合类型为 `SessionMeta`；可变 summary 后来因为是死状态而被移除——见 [移除可变会话摘要](../simplification/2026-06-19-drop-mutable-session-summary.md)。）
- **`ctx.agents.create()` 与 `ctx.agents.resume()` 是异步工厂；resume 还额外跨越持久化边界。** `ctx.agents.resume({ resumeSessionId })` 等待 `ctx.sessionPersistence.load`，用加载的事件重建活跃会话（使 `lastTurnNumber`/`deriveMessages` 继续），并在恢复的 id 上启动一个新 agent（不是 `${agentId}-session`）。agent loop 不会硬注入 `sessionPersistence`（那会让非持久化的演示永远挂起）；当 `sessionPersistence` 不存在时，`resume` 以明确的错误拒绝。

## 曾考虑的替代方案

上述每个关键选择在陈述时已记录了其被否决的替代方案：**过滤 chunk 的规范日志**（Codex 的 `policy.rs` 形状）——破坏连续 seq 契约；**截断崩溃的轮次**——静默销毁长时间自主运行的真实工作；**日志内 `session/meta` 事件作为第 0 行**——元数据不是可回放状态；**将 `sessionPersistence` 硬注入循环**——会让非持久化的演示永远挂起。

格式版本控制：header 携带一个 `version`；`load` 拒绝任何非当前版本（不做迁移——预发布的会话格式固定在 `SESSION_FORMAT_VERSION = 0`，按 AGENTS.md 的预发布立场吸收形状变动）。坦率地说：仅追加 + 刷写对部分尾部写入（加载时容忍）是健壮的，但对行写入中途的无 fsync 断电不健壮；数据库/WAL 后端是将来更强的选项。

## 后果

新增两个包（package），以及 `dsh-session` 中的元数据 seam（`session.header`、`create(id?, options?)` 签名）。收获：持久恢复/fork、读取/回放路径、崩溃容忍，以及 ACP `session/load`（[ACP 支持](../../implemented/feature/2026-06-14-acp-agent-client-protocol.md)）所需的基础——全部建立在既有的事件溯源日志之上，后端可在一个接口后替换。可复用的 `runPersistenceContract` 套件以相同的仅追加、连续 seq、惰性物化与可序列化语义约束每个后端。持久化完整日志还确定了事件保真度：`assistant/chunk` 保持逐字保留。
