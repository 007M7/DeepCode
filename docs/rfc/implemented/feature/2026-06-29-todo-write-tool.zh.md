# RFC：`todo_write` 工具——将模型任务列表建模为事件溯源的会话状态

Status: implemented

[English](2026-06-29-todo-write-tool.md) | 中文

## 问题

harness 为模型提供了 bash 和 subagent 工具，但没有任何方式记录结构化的任务列表。todo 列表服务于两个同等重要的目的：引导模型规划多步骤工作并保持当前任务明确（最多一个 in_progress，有未完成工作时恰好一个），以及为人类提供实时进度清单。ACP（Agent Client Protocol）协议有原生的 `plan` sessionUpdate，编辑器（Zed）已经在渲染它，但 bridge 从未发出过。调研的每个参考编码 agent（智能体）实现（claude-code、opencode、codex、oh-my-pi、pi）都提供了某种形式的此功能；而 harness 什么都没有。

## 决策

新增一个面向模型的 `todo_write(todos: [{ content, status }])` 工具，其全量列表状态以新的 `todo/write` `SessionEventMap` 变体存在于事件溯源的会话日志上。stdio UI 和 ACP bridge 都从既有的 `session/event` 渲染——ACP bridge 将列表映射为 `plan` sessionUpdate。

### 全量替换，三态 status

模型每次调用发送**完整**列表；新列表替换旧列表（回放时 last-write-wins）。这是 claude-code V1、opencode 和 codex `update_plan` 共同使用的形态，也是模型训练最多的形态——没有逐项 id，没有 delta 协议。`status` 恰好是 `pending | in_progress | completed`：与 codex `update_plan` 相同的三元组，且关键的是**与 ACP `PlanEntryStatus` 完全一致**，因此 bridge 做 1:1 映射，无损失转换。

### 状态在会话日志上，而非服务

列表以 `todo/write` 事件追加，携带完整的 `{ todos }` 快照。harness 是事件溯源的——LLM（大语言模型）历史、工具调用和轮次结构都在日志上——所以 todo 列表也在那里。这免费获得了持久性、回放和 `session/load` 重建：重新打开的会话从最后一条 `todo/write` 重新推导当前列表，ACP bridge 在加载时重新发出 `plan`，无需独立的持久化后端、无需重新注水的内存服务、无需额外接线。一个内存中的 `ctx.todos` 服务需要重新发明所有这些。

### 不是 surface 事件

`todo/write` 被刻意排除在 `SurfaceEventType` 之外。surface 是产出 LLM 消息历史（`deriveMessages()`）的投影；一次 todo write 不产生对话消息。因此它不携带 `surfaceOp`，不加入 surface 链表，不进入 `deriveMessages()`——它是持久的、可回放的 *UI* 状态，伴随对话传播但不属于对话的一部分。（开发模式的不变式仍要求它位于一个打开的轮次内，事实也确实如此：它在工具调用的 mid-step 阶段追加。）

### priority 仅在 ACP 边界合成

ACP 的 `PlanEntry` 要求 `content` + `priority` + `status`，但 `TodoItem` 没有 priority——模型从不推理它。与其在 schema 中增加一个模型每次都必须提供的字段，不如让 bridge 在构建 `plan` 时为每个条目合成一个常量 `priority: 'medium'`。priority 是 ACP 协议格式（wire format）的要求，不是 harness 的概念，因此它恰好存在于需要它的边界处。

### 相比 claude-code V1 去掉的字段：`activeForm`、id、priority

claude-code V1 的 item 是 `{ content, status, activeForm }`；后来（V2）增加了 id、依赖和所有权——但那只是为了支持 agent *集群*（磁盘持久化、锁保护、逐项变更）。本工具将 item 保持在最小集：`{ content, status }`。没有 `activeForm`（现在进行时标签）——UI 直接展示 `content`；没有 id——全量替换不需要稳定标识；没有 priority——见上文。每去掉一个字段，模型每次调用就少产出一项。

### 单一所有者——无集群机制（YAGNI）

每个列表属于调用方 agent 会话，非 agent 调用会被拒绝。没有共享作用域、resolver 或 delta 协议。跨 agent 列表需要逐项日志 delta 和显式作用域选择，因此留作未来独立设计。

### 校验：低成本的中间路线

schema 强制 type/required/enum。在此之上，`execute` 拒绝空 `content`、重复 `content` 以及多于一个 `in_progress` 任务。claude-code 将 single-in-progress 留给 prompt；oh-my-pi 在代码中强制。我们取中间路线：强制那些使计划*连贯*的低成本不变式（无空白任务、无重复、最多一个活跃），但将排序和保持列表最新的纪律通过工具描述留给模型。被拒绝的写入返回 `isError` 结果，模型可自行修正。

## 为什么没有 cordis-catalog 条目 / 没有 `@mode`

`todo/write` 是 `SessionEventMap` 的成员，不是一等的 cordis `interface Events` 事件。catalog 生成器（`scripts/gen-cordis-catalog.ts`）扫描 `interface Events` 声明；`SessionEventMap` 变体搭载既有的 `session/event` emit，不产生新的 catalog 行。因此它不携带 `@mode` 标签（生成器仅对 `interface Events` 成员要求此标签）——加上它也没有意义。

## 测试

四层，预先设计：
- **单元测试**——会话事件（append/snapshot-clone/last-write-wins/not-on-surface）；工具（schema 形状、通过真实 `ctx.tools.execute` 的参数校验、值校验、事件追加与替换、非 agent 拒绝、`presentCall`、HMR 安全性）；ACP `todosToPlan` 映射；stdio 渲染分支。
- **真实 Loader 路径**——插件通过 `Loader.unwrapExports` 运行，断言命名空间导出形状存活（它有 `inject`，因此一个意外的 default 导出会在加载时崩溃——postmortem/0001）。
- **全链路集成**——一个脚本化的 mock 模型通过真实 agent loop（智能体循环）调用 `todo_write`；`todo/write` 事件落地，第二次调用替换它。
- **`session/load` 回放**——一条持久化的 `todo/write` 在新的 ACP bridge 加载会话时重新发出 `plan` 更新。
- **带 key 的 e2e + 快照**——一个真实 prompt 诱导 `todo_write`；快照 golden 新增 `plan` 通知和日志事件。

## 曾考虑的替代方案

- **内存中的 `ctx.todos` 服务**——需要重新发明日志免费提供的持久性、回放和 `session/load` 重建。
- **逐项 delta 协议**——仅在共享多所有者列表时需要，不在本次范围内；全量替换更简单且与参考实现一致。
- **工具放在 `core/`**——`todo_write` 是注册在 `ctx.tools` 上的扩展工具，不属于主干；它与其他工具族一样放在自己的 `packages/todo/` 分组中。

## 后果

todo 列表是持久的、可回放的会话状态：一条持久化的 `todo/write` 在 `session/load` 时重新向编辑器发出 `plan` 更新，日志（而非插件内存）是唯一真源。全量替换意味着每次更新一次工具调用、last-write-wins；没有需要协调的 delta 协议。事件不进入 surface，因此 todo 更新永远不会扰动推导出的模型历史——模型只看到自己的工具调用和结果。
