# Agent Note: 浏览器会话是按日志顺序投影的人类对话记录

Status: implemented

[English](2026-07-30-web-transcript-log-ordered-projection.md) | 中文

## Problem

浏览器客户端从模型可见的 surface 构建会话：`FoldAdapter` 在历史窗口上运行核心 `SurfaceManager` 并读取 `surface.nodes`。一次成功的压缩会用一个检查点节点替换一段 surface 范围，因此该替换一落地，Web 流就把它所遮蔽的每条消息折叠成一行灰暗的上下文——那是用户已经读过的对话。日志中什么都没丢失；缺陷完全在投影层，而[终端与宿主历史网关已按同一方式修复](2026-07-29-human-transcript-append-origin.md)，浏览器留给了本次变更。

surface 顺序还让另外两个问题成为结构性的。一次替换之后它并非按 seq 升序——`SurfaceManager` 把高 seq 的检查点拼接到它所遮蔽范围的位置上——因此按数值 seq 归并进该数组的仅日志节点（斜杠命令行、被打断的冻结节点）可能被冲刷到检查点之前，再也无法交错回保留下来的尾部。而且由于分页不再为 replacement 副本消耗 `maxMessages` 额度，一页现在可以携带一个 `surfaceOp.start` 落在窗口之外的检查点；核心 fold 拒绝该范围，于是 `nodes()` 退回到一次宽容的线性扫描、打印一条 `console.error`，并发布一个描述该失败的 `foldDegraded` 标志。

## Decision

`TranscriptAdapter` 取代 `FoldAdapter`，并且从不查询 surface 顺序。它按日志顺序投影原始窗口：每个 append 来源的 surface 事件（`isAppendSurfaceEvent`）落在它自己的日志位置上，外加每次落地的压缩检查点一个 `CompactionSummaryNode` 标记。于是一次落地的压缩会保留它在模型侧遮蔽掉的对话，标记报告模型从哪里开始看不见那段历史，而不是把它抹掉。仅模型可见的 replacement 副本不进入记录：被裁剪的 `tool/result` 和重新生成的 `assistant/message` 只为模型重写一个节点，不在对话中标记任何边界。凡必须发送模型所见内容的一切仍读 surface；这是人类投影，两者现在在两个前端上都已分离。

节点顺序天然按 seq 单调，由此有三个结果。仅日志的 `command/run` / `command/done` 对折叠成 `CommandNode`，按 seq 插入一个本已单调的数组——无锚点，无重排。`Session` 保留被打断的冻结节点的归属，用一次普通排序按其分数 seq 归并，而这现在恰好就是流顺序。检查点所引被遮蔽范围落在窗口之外的窗口没有范围需要解析，因此标记正常渲染且不打印任何日志。

`foldDegraded` 从 `ConversationSnapshot` 消失，随之消失的是哨兵填充、它们所需的 `baseSeq` 算术，以及 `degradedSeqs()`。它们的存在只为满足核心 fold 的 `seq === index` 断言并在其抛错时存活；它们所描述的 fold 已不再运行。删除该标志是修复的一部分，而非修复之后的清理——`degradedSeqs()` 本身已几乎就是按日志顺序的投影，只是作为抛错后的落点而非本意到达。

标记的摘要文本来自检查点自己的 `compact/summary` 溯源，绝不取自成框的检查点载荷——那是为模型撰写的指令信封。窗口切分把溯源留在窗口外时该行不可展开而非空白，与无调用的工具结果同一种软退让；后续补上溯源的分页会解析出文本。

没有任何持久化事件、RPC 信封、压缩事务或模型可见 surface 发生变化，也不需要迁移。

## 识别检查点：本地字面量与它的漂移陷阱

识别需要三个条件同时成立，与终端一致：`event.type === 'user/message'`、压缩缝隙的检查点插件来源，**以及** `isReplacementSurfaceEvent(event)`。一条 append 的插件来源 `user/message` 是注入上下文——跨会话引用卡片——不是压缩。

客户端把该插件来源重述为一个本地字面量，因为 `dsh-compact` 在**两个**方向上都无法从 `packages/client/runtime` 的程序到达：

- **值**导入会失败于客户端纯度门禁（`packages/client/tsdown.client.ts`），而 `dsh-compact` 的根部会值导入 cordis，因此放行它就会把 `CompactService` 拉进浏览器产物；
- **仅类型**导入会失败于类型检查。`dsh-compact` 的根部会到达 `dsh-session` 的根部，后者的 cordis `Context` 合并声明了宿主侧 `sessions: SessionStore`，与本程序的 `sessions: ISessions` 冲突——`TS2717`，即 [development.md](../../../../docs/development.md#typescript-project-layout) 中每侧一个 program 的规则。这一点原本预期可行，实际不可行：`import type` 在**打包器**运行前被擦除，但不在**编译器**运行前被擦除，而该冲突是编译器事实。

因此漂移保护住在一个测试里，而不是一个类型里：`packages/client/runtime/tests/compact-checkpoint-pin.spec.ts` 运行在客户端**测试**程序中——那里不存在这一冲突——并用由权威 `COMPACT_CHECKPOINT_SOURCE` 本身构造的检查点驱动适配器。重命名缝隙的插件会在那里失败，而不是无声地把每个压缩标记从 Web 记录中删除。`dsh-compact` 只是 `dsh-client-runtime` 的 `devDependency` 以及 `tsconfig.client.json` 的一条引用——绝不是任何 `packages/client/*` 包工程的引用。

这是与终端的一次刻意分歧：终端直接值导入 `isCompactCheckpointSource`，因为宿主侧不适用任何门禁。

## #835 的位置锚点是为什么而存在，以及为什么它是被溶解而非丢失

尚未合并的排队式手动压缩分支用另一种方式修同一个交错缺陷：为每个事件记录一个锚点——追加时的 surface 尾部——并把被遮蔽的锚点重定向到检查点上。该机制的存在是为了让位置锚点在 surface **重排**中存活。人类对话记录永不被重排，因此锚点没有任何东西需要重定向：前提被移除，修复并未被丢弃。该机制在本基线上并不存在，本次也不撰写它。

## Alternatives considered

**把 `dsh-compact` 加入客户端 `INLINE_SAFE` 白名单**，并把谓词搬到一个不含 cordis 的子路径。已拒绝：`INLINE_SAFE` 按标识符*前缀*匹配，因此放行该包也就放行了它那个会导入 cordis 的根部；该白名单是对面向客户端子路径的评审承诺，不是纯度证明。它还需要一个新导出与一处 `files` 修正，而且本来也帮不上忙——真正阻塞的冲突出在编译器，白名单碰不到那里。

**一条纯形状规则**——任何 replacement `user/message` 都是压缩。已拒绝：它今天正确只因为压缩是 replacement `user/message` 的唯一生产者，一旦这点改变便无任何机制能捕获。那个 pin 测试只花一个文件，就精确消除了这一风险。

**在宿主侧给检查点打标**，经投影或线协议。已拒绝：这最贴合“经 cordis 服务协作”的规则，但客户端今天折叠的是原始 `SessionEvent`，因此这意味着一次线协议契约变更——为一个纯谓词付出的代价不成比例。

**把冻结节点的归属移进适配器**（`nodes(extraNodes)`），像那个未合并分支所做的那样。已拒绝：被打断的节点来自 `Session` 已经在窗口上运行的 `turn/end` 清扫，而在按 seq 单调的记录之上，简单形态就是正确的——适配器返回节点，会话按 seq 归并冻结节点。加宽适配器签名什么也换不到，还会把清扫与它的产物拆开。

**把 `foldDegraded` 留作一个防御性标志。** 已拒绝：它描述的是一个已不再运行的 fold 的特定失败。一个消费方无法据以行动、只能通过 `console.error` 到达的标志，是一份虚假契约。

## Consequences

压缩不再抹掉 Web 历史；一个被压缩多次的会话按日志顺序显示每次落地压缩一个标记，而同一窗口在实时与冷恢复之后渲染完全相同。分页缺口是被构造性闭合而非被防御，`ConversationSnapshot` 少了一个已发布字段，这触及十三个文件。

`ConversationNode` 增加第八个分支，因此每个穷尽消费方都多一个分支：`MessageItem` 通过新的 `CompactionItem` 渲染标记，trajectory 布局加宽它的“无单元格”分支，使标记不贡献单元格但仍推进耗时游标。

性能契约未变，且现在更易表述：一次追加物化一个节点，不改变任何节点的事件保持上一次的数组引用——因此分片风暴零成本、`nodes()` 甚至不会重算——未变化的节点保持其对象标识。窗口仍随会话长度而非随 surface 增长，这正是本修复存在所要做的交换；一次压缩过去恰好为压缩所服务的长会话限制了投影规模。

Web e2e 场景现在在它录制的那一轮之上播种一次真实的压缩事务，因此 aria 基准经真实宿主与真实浏览器钉住修复的两半：录制的提问与完整工具输出仍在屏幕上，其后坐着一个标记。录制本身未被触碰、保持模型真实——回放从录制自身的 surface 派生出被压缩的那一轮。

## Deferred

压缩**进度**——压缩运行期间的指示——需要排队式手动压缩工作引入的“先开括号”顺序，与终端一样不在本次范围内。标记同样不携带**规模**信息：检查点的 `sourceEventSeqs` 已经包含被遮蔽的数量，因此一个计数或区间可以告诉读者每一行折叠了多少内容。两者应当放在一起，读者正是在那里遇到同一份信息的两半。
