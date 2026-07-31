# Agent Note: 恢复选择器批量投影

Status: implemented

[English](2026-07-31-resume-selector-batch-projection.md) | 中文

## Problem

打开 TUI `/resume` 选择器时，会在一个无界 `Promise.all` 中对每个列出的会话调用一次 `sessionQuery.readSession()`。每次调用都会在 `SessionCorpus.load()` 内部重新列出整个持久化存储（O(N²) 次列表查询）、读取并解压完整日志、通过 `Session` 构造函数对每个事件做回放验证，并将 header 和事件深克隆多达三次——而这一切只为推导一行选择器条目的标题、最近活动时间、最后一个 `turn/end` 标签、提供方/模型路由和目标阶段。在真实存储上（185 个会话、压缩后 87 MB、约 35.3 万个事件），选择器需要数十秒才能打开，且开销随日志总大小而非会话数量增长。

## Decision

`SessionQueryService` 将既有的内部 `SessionCorpus.projectMany` 批量能力公开为 `projectSessions(sessionIds, project, signal?)`：一次持久化列表查询、最多 `persistedInspectConcurrency` 个并发持久化检查、按 id 隔离失败，以及一个在借用的 `LogicalSessionSource` 上运行的同步投影函数——不做回放验证也不克隆。`readTitleSnapshots` 现在经由它实现；`LogicalSessionSource` 和 `LogicalProjectionResult` 被导出，并记录在 session-query 核心数据结构页面中。

`/resume` 选择器通过一次 `projectSessions` 批量调用构建全部候选行；被拒绝的投影会退化为该行的禁用"Unreadable session"回退，与之前 `readSession` 失败时的行为完全一致。`summarizeResumeCandidate` 接受借用的来源，且只保留记录和推导出的标量。移交前的预检仍通过 `readSession` 读取用户选中的单个会话，在进程 re-exec 前保留完整回放验证；其中冗余的实时会话捷径被删除，因为 `readSession` 本身已是实时优先。

选择器 overlay 在 `/resume` 分发时同步打开，早于扫描结算：`undefined` 候选集渲染"Loading sessions…"加载占位符，选择器从第一帧起就拥有终端输入（长扫描期间的按键会进入搜索字段而非编辑器），Enter 提示会话仍在加载，Escape 的取消方式与已加载列表完全相同。关闭 overlay 会通过两个服务方法都接受的 `AbortSignal` 中止扫描，因此被关闭的选择器不会继续解压大型存储；忽略信号的后端在中止后的迟到结算则由过期检查丢弃。扫描完成后通过 `setCandidates`（同时清除过期的仍在加载错误）换入行数据，不替换 overlay；排在正在关闭的前任之后的排队激活会在构造时直接收到已扫描的集合；列表查询与投影共用同一个 catch，因此任何扫描失败都会关闭 overlay 并报告既有的失败通知，而不会让加载占位符悬置。

## Alternatives considered

**只修复 `SessionCorpus.load()` 内部的 O(N²) 列表查询。** 作为主要修复被拒绝：在大日志上，按候选行执行的完整解压、回放验证和三重克隆才是主要开销，且仍是 O(日志总字节数)。`load()` 中的冗余预列表查询仍是一个候选清理项，但它会改变 not-found/一致性错误语义，而且一旦选择器不再按行调用 `readSession`，这项清理就不再必要。

**在 `sessionQuery` 上添加恢复专用的摘要方法。** 被拒绝：恢复是 TUI 概念，服务接缝不应引入消费者词汇。通用同步投影复用了 `readTitleSnapshots` 已在内部使用的接缝，并让 TUI 拥有自己的 fold。

**持久化摘要索引（例如放在 SQLite 查询后端中）。** 暂时被拒绝：对存储做一次有界扫描（在测量机器上约 1–3 秒）是可接受的选择器延迟，而索引会引入失效契约。若存储增长到一次有界扫描仍然过慢时再重新引入。

## Consequences

打开 `/resume` 只执行一次列表查询加一次有界并发扫描，而不是 N 次列表查询和 N 份经验证的完整副本；内存受并发上限约束，因为每个投影完的日志会在其 worker 出队下一个 id 前被释放。选择器行不再经过回放验证——一份可列出、可解析但回放会失败的日志会显示为普通行，直到预检拒绝它，而预检在移交前总会重新检查。TUI 测试中的伪造 `sessionQuery` 服务现在必须在 `listSessions`/`readSession` 之外提供 `projectSessions`。由于选择器立即接管焦点，启动第二次扫描需要先关闭当前 overlay——扫描期间输入的第二个 `/resume` 会落入搜索字段，这正是预期的输入捕获行为。
