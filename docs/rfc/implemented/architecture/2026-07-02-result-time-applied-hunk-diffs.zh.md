# RFC：结果时刻的 applied-hunk diff 用于文件变更

Status: implemented

[English](2026-07-02-result-time-applied-hunk-diffs.md) | 中文

## 问题

[带标签的渲染意图联合类型](2026-07-02-tool-render-intent-union.md)为 `dsh-tool-fs` 的 write/edit 在调用时（CALL time）提供了 `card:'diff'`，纯粹从工具参数推导：write ⇒ `{oldText:null, newText:content}`（整个新文件），edit ⇒ `{oldText:old_string, newText:new_string}`（裸替换片段）。编辑器将其渲染为行内 diff，但这是一个**无上下文**的 diff：裸的 `old_string`→`new_string` 没有周围行，而一次 `replace_all` 如果触及五个分散位置，仍然只渲染为一对片段。

驱动 `claude-agent-acp` 自身的 ACP 桥接层可以看到完整编辑器 diff 的样子：变更应用后，它发出第二个 `tool_call_update`，其 diff 是**带 ±3 行上下文的 applied hunk**（`replace_all` 的每个变更位置各一个 hunk），由工具的 `structuredPatch` 重建。这个结果时刻的 hunk 正是让 Zed 在文件中*原地*展示变更（而非浮动片段）的关键。我们的工具止步于调用时片段；完成后的结果只携带纯文本 "updated successfully"，没有 diff。

障碍在于一个 seam 边界：`presentResult(args, result)` 是 **`args` + 面向模型的 `result`（`{content, isError}`）的纯函数**——它在实时流式输出和会话日志回放时都会运行，因此必须具有回放确定性且不能做 I/O。它看不到文件的变更前/后内容，而 `FsEditOutcome`/`FsWriteOutcome` 只携带替换计数 + 版本，没有文本。因此既无法计算、也无法传递 applied hunk 给 presenter。

## 决策

新增一个**持久化的、工具私有的展示通道**，使工具的 `execute` 能附加一个结果时刻的渲染载荷并在回放中存活，并用它来承载 applied-hunk diff。

### 1. 工具结果上的 `meta` 通道（core）

`ToolDefinition.execute` 现在可以返回其面向模型的 `ContentBlock[]`（不变，常见情况）或 `{ content: ContentBlock[]; meta?: unknown }`：

```ts ignore-check
type ToolExecuteReturn = ContentBlock[] | { content: ContentBlock[]; meta?: unknown }
```

`meta` 是工具自有的 `unknown`，core 持久化它但不解释。`Session.append` 拒绝非 JSON 值，回放时将存储的载荷传回 `presentResult`；因此展示无需 I/O 或重新计算即可复现。运行时校验避免了向 tools core 添加共享的 serializable-value 依赖。

这是通用形态（"工具附加持久化的结果展示"），而非 fs 专用——任何工具都可以使用。

### 2. 工具计算 hunk；后端返回变更前/后文本（fs）

按照[能力-seam 拆分](2026-06-13-capability-seams.md)，存储后端只返回**存储事实**，面向模型的工具拥有**展示**：

- `dsh-fs` 扩展 `FsEditOutcome`，增加 `{ before: string; after: string }`；扩展 `FsWriteOutcome`，增加 `{ before: string | null; after: string }`（`before: null` ⇒ 新建文件，或已存在但不可 diff 的二进制/非 UTF-8 文件）。本地后端在写入时已持有两份文本；它以原始 LF 规范化文本返回，**不让任何 diff/UI 概念进入 seam**。
- `dsh-tool-fs` 将带上下文的 hunk 存入 `meta: { diffs: FileDiff[] }`。成功的变更始终以 diff 卡片完成，因为 ACP 结果内容会替换 pending 卡片：新建或无变化的覆写回退为参数推导的全文件 diff，而编辑使用 applied hunk。失败的变更不携带 diff 元数据，正常渲染错误信息。

### 3. 桥接层渲染 `diff` 结果卡片

`ToolResultView` 新增 `DiffResultView { card:'diff'; title?; diffs: FileDiff[] }`；桥接层结果侧的 `switch (view.card)` 增加 `diff` 分支，发出 `{type:'diff'}` 的 `ToolCallContent` 块（与调用侧分支对称）。ACP 的 `tool_call_update.content` 在编辑器中**替换**调用时的内容，因此结果 diff **取代**调用时片段（并防止面向模型的结果文本覆盖它）——两次更新的序列（先调用片段，后结果 diff）与 `claude-agent-acp` 完全一致。

## 曾考虑的替代方案

**手写或 vendor diff 算法。** 带上下文的 hunk 有已知的边界情况，因此 `dsh-tool-fs` 使用带类型的 [`diff`](https://www.npmjs.com/package/diff) 包，并在一个模块中规范化 `structuredPatch` 输出。本仓库的 vendor 策略适用于其框架源码，而非每个叶子工具。

## 后果

`tool/result` 事件现在可以携带工具私有的 `meta` 载荷——属于磁盘词汇的一部分，由 `Session.append` 在运行时限制为 JSON——任何工具都可以附加持久化的结果展示而无需再改 core。diff 卡片在会话重载和快照回放时免费复现：从日志读回，从不重新计算。代价：覆写操作在内存中同时持有变更前和新文本以计算仅用于 UI 的 hunk（`TODO(overwrite-diff-bound)`），且 `dsh-tool-fs` 引入了一个小型、知名的运行时依赖。

## 非目标

- **实时增量 diff 流式输出。** hunk 在变更完成后一次性计算；没有逐按键 diff。
- **对二进制/非 UTF-8 覆写做 diff。** 此类文件的 `before` 为 `null`（没有文本 diff 基础）；写入仍然成功，结果渲染全文件 diff（`oldText: null`）而非带上下文的 hunk。
- **重命名/移动 diff。** 仅对单个已解析路径做内容 diff。
- **限制覆写 diff 基础的大小。** 覆写操作将整个旧文件读入内存以计算带上下文的 hunk（在已持有的新内容之上），因此非常大的文本覆写会为仅 UI 用途的 diff 分配两份文本。后续优化可以设定预读上限，超过阈值时回退到全文件/无上下文 diff；以 `TODO(overwrite-diff-bound)` 标记在读取位置。

## 相关

- 补齐了[带标签的渲染意图联合类型](2026-07-02-tool-render-intent-union.md)中作为非目标列出的最后一项表示差异——该 RFC 的「非目标」一节已更新，记录 applied-hunk diff 在此处交付。
- 建立在[文件系统能力 seam](2026-06-17-filesystem-capability-seam.md)（变更前/后文本是后端返回的存储事实）和[事件溯源会话](2026-06-11-event-sourced-sessions.md)（`meta` 载荷持久化在 `tool/result` 事件上，因此回放可复现卡片）之上。
- `meta` 通道有意设计为通用的：未来的工具（结构化搜索、数据表结果等）可以附加自己的持久化结果展示而无需再改 core。
