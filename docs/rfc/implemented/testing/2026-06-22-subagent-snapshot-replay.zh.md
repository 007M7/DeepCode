# RFC：嵌套 agent 的逐会话快照回放

Status: implemented

[English](2026-06-22-subagent-snapshot-replay.md) | 中文

## 问题

快照测试层（`pnpm run test:snapshot`）启动真实的 `acp-agent` 子进程，通过 [`dsh-llm-replay`](../../../../packages/support/llm-replay) 回放录制的会话，并将归一化后的 stdout transcript（文本记录）与重新持久化的会话日志同提交的 golden 文件做 diff。这是唯一一个端到端验证完整编辑器侧 transcript 的测试层。

它最初为**单会话单进程**而建，这一假设硬编码在两处：

- **`dsh-llm-replay` 没有任何键控。** 它用一个全局游标，将第 N 次 `llm/stream` 调用对应到单一录制序列的第 N 条。当父 agent 和进程内 subagent 同时在一个 context 上流式输出时，调用交错，单一游标会把子 agent 的脚本交给父 agent（反之亦然）。
- **harness 只收割一份日志。** `findSessionLog` 遍历 sessions 根目录，返回找到的**第一个** `.jsonl`。subagent 作为同一 cwd bucket 中的第二个 `Session` 运行、拥有自己的日志，因此子 agent 的 transcript 被静默丢弃。

这正是 [subagent seam RFC](../../implemented/feature/2026-06-21-subagent-capability-seam.md) 中记录的 `TODO(subagent-snapshots)` 延期项：进程内后端（PR2）已有单元测试和 e2e 覆盖，但全 transcript 快照层在本基础设施落地之前无法表达嵌套 agent 的形态。本 RFC 即为该堆叠后续。

## 决策

回放按**调用方会话**键控，harness 收割**所有**会话日志。

### 1. 调用方会话 id 随模型请求传递

`GenerateOptions` 新增可选字段 `sessionId`，在请求组装时从 `agent.session.id` 打入。适配器忽略它；`llm/stream` 监听器用它按发起方会话路由。其类型为 `Branded<'SessionId'>`（来自 `dsh-brand`）而非 `dsh-session` 的 `SessionId`，因为后者所在包导入了 `dsh-llm` 的 `Message`，反向导入会形成循环。两个类型等价，会话 id 赋值无需强制转换。将 brand 移入专用 ids 包属于独立工作，因为它会触及所有 id 导入。

### 2. 回放按首次调用顺序将活跃会话绑定到录制脚本

嵌套场景录制不止一份日志：父会话（`session.jsonl`）加每个 subagent 子会话各一份（`session.1.jsonl`、……）。`dsh-llm-replay` 全部加载，为每个录制会话推导一份脚本，并按 header 中的 `createdAt` 排序（父会话先于子会话创建）。

活跃会话 id 每次运行都是全新随机值，永远不等于录制时的 id，因此活跃会话无法通过 id 相等绑定脚本。取而代之的是**首次调用顺序**绑定：第一个发起模型调用的活跃会话认领排序第一的脚本（即父会话——`createdAt` 最早，且必然最先流式输出，因为它必须先运行一个轮次才能委派），下一个新活跃会话认领下一份脚本，依此类推。之后每个会话独立推进自己的游标。

这按**谁在调用**键控，而非按全局调用顺序——因此即使 subagent 将来并发运行或在后台运行也保持正确（全局游标会导致交错）。不携带 `sessionId` 的调用（直接在单元测试中调用 `stream()`）被视为一个匿名会话、绑定到主脚本，因此单会话路径的行为与旧版逐字节一致。活跃会话数多于录制脚本数是一个 fail-loud 错误（出现了未录制的 subagent），绝不会静默误路由。

子 fixture 按 `createdAt` 排序，在兄弟会话严格顺序执行时与调用顺序一致。id 平局打破只是让退化碰撞确定化。并发或后台子会话必须引入显式的首次调用序号，而非依赖时间戳。

## 曾考虑的替代方案

曾考虑并否决的方案是将父子日志**按调用顺序合并**为一份全局脚本（仅在进程内 subagent 严格嵌套执行——父 agent 阻塞等待子 agent——时才正确）。对当前的同步切面更简单，但把「父阻塞于子」这一不变式烤死了；未来的后台/并发 subagent 会打破它，而逐会话键控不会。

### 3. harness 收割所有日志，主会话优先

`harvestSessionLogs` 收集 sessions 根目录下每个 cwd bucket 中的所有 `.jsonl`（JSONL 后端将父会话与同 cwd 的子会话放在同一 bucket），解析各自的 header，并按主会话优先排序：顶层会话（无 `parentSession`）在前，子会话按 `createdAt` 升序排列。`RunResult.sessionLogs` 是复数结果；spec 在录制时将每份日志写回 fixture（`session.jsonl` + `session.<n>.jsonl`），在回放时将每份收割的日志与对应 fixture 做 diff。归一化器已接受复数会话 id 并折叠任何游离 UUID，因此无需修改归一化器。

### 4. 场景

新增两个嵌套场景，均对真实 API 录制：

- **`subagent-spawn`**：父 agent 通过 `subagent` 工具将一个子任务委派给一个新 spawn 子会话（2 个会话）。
- **`subagent-multi`**：父 agent 委派两个子任务，各自交给独立的 spawn 子会话（3 个会话），以三份并行脚本和同一父会话下两个子会话的 `createdAt` 排序来压测逐会话键控。

两者均在默认门禁中以 keyless 方式回放。

## 后果

- `TODO(subagent-snapshots)` 延期项已解决：嵌套 agent transcript 现在是快照的一等形态。
- `GenerateOptions.sessionId` 是一个小而诚实的 core-seam 新增，在回放之外也有用（遥测、请求路由）。
- `subagent` 工具绑定到单一提供方，因此 `subagent-multi` 中的两个子会话都是 spawn（全新）。键控按会话路由而非按后端路由，因此对 fork 也已正确。但脚本*推导*并非如此：fork 子会话的日志以种子化的父前缀（父会话的 `assistant/chunk` 事件）开头，从整份日志推导脚本会把父会话的响应当作子会话的来回放。这一正确性缺口通过持久化种子边界来弥合——见 [Persist the seed boundary so fork-child replay routes correctly](2026-06-22-fork-child-replay-seed-boundary.md)——录制的 fork 与混合 spawn+fork 场景现在通过一份 transcript 同时验证两种传输方式（见 [Record fork and mixed spawn+fork snapshot scenarios](2026-06-22-fork-snapshot-scenarios.md)）。
- 进程外（ACP）subagent 是完全不同的回放形态（每个子 agent 是独立进程、有自己的 replay），作为 `TODO(acp-subagent-replay)` 记录在 PR3 计划中。
