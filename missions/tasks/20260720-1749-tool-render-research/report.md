# tool 调用展示调研报告

> owner: tool-render，2026-07-20。为 session 界面 tool 卡改造立项打地基。零 commit，只调研。
> 三批：①全量 tool 清单 → ②协议表达力缺口 → ③展现形式表。分叉问题清单置顶。
> （批 2/3 曾与 arch-research 撞车双写；本稿为 owner 审校后的单一合稿，冲突处以盘上实证为准，G 编号已统一为 G1-G11。）

## 0. 分叉问题清单（不替用户拍，供立项时逐条裁决）

- **F1（=arch-research P9）**：tool 渲染语义归属——core 下发渲染意图（现状 presentCall/presentResult 在 tool 定义里，Node 侧纯函数）vs client 插件按 tool 名自带渲染器。选项空间详见 20260720-1640-gui-arch-research/report.md P9 节，此处不重写。
- **F2（=arch-research P10）**：widget 卡（表格/列表/键值）落在哪层——core 扩第四型卡（动闭合 union，全 UI 桥同落）vs 归插件渲染（core 词汇不动，依赖 F1 选 b/c）。
- **F3**：执行中间态（bash 渐进 stdout、workflow 进度、subagent 嵌套事件）要不要进 session 事件流；进的话是新帧型（如 `tool/progress`）还是复用现有机制（解法空间见 §2.6）。牵连「Model-visible ⟺ logged」红线的边界解释：中间态不是模型可见输入，红线不强制持久化，但归哪类先例要拍（§2.6 四象限）。
- **F4**：中间态若不进 session log，replay/快照语义怎么定——回放时 tool 卡只有始末两态、live 时有中间态，两者不一致是否可接受。
- **F5**：`meta`（tool 私有展示载荷，现役 fs write/edit 的 applied hunks + run_code 的 logs）要不要成为 web 端富卡的通用扩展点（逐工具补产机器形），还是维持 tool 私有黑盒。
- **F6**：可交互卡的回程通道——tool 卡上的动作（edit&re-run、widget 选项、任务 kill）要打回 host，现契约唯一先例是审批/问答的 requested 帧+respond 回填模式。照此扩「卡片交互域」vs 一切交互降级为普通 prompt（「重跑」=发一条新消息）vs 随 arch-research P10/P11 一并拍。
- **F7**：workflow/subagent 的过程数据通道——workflow 六事件（start/phase/log/agent-start/agent-end/end）只在 cordis 总线（packages/workflow/workflow/src/index.ts 的 declare module），不进 SessionEventMap、mux 透传不到 web；subagent 子会话是独立 session 但「callId→childSessionId」关联无事件记录。分叉：镜像进 session log（log-only 词汇）vs mux 加「host 过程帧」类别（打破 mux=session 事件透传的单一语义）vs 最小加法只记关联锚、过程展示=跳转/内嵌子 session 视图（workflow 无子 session 则覆盖不到）。
- **F8**：模型自造 tool（`harness.defineTool` 经 cordis_mount 挂载）的展示是**未设计灰区**——教学文档（cordis_mount description）只教 name/description/parameters/execute，不提 presenter；但机制上 `sandboxDefineTool` 的 `...tool` 展开会把 presentCall/presentResult 一并透传（guard.ts:170-185）：execute 有 JSON 往返+形状校验防护，presenter 只有 defineTool 的软校验包装——vm 域函数直接被 ACP/TUI 调用，返回值不做 JSON 归一化、执行无超时管束（mount 的 vmTimeoutMs 只管挂载求值）。unmount 后无残留（presenter 经 `tools.get` 现场解析，未注册即 generic 兜底）；真实残留风险是**同名重挂载后旧 log args 进新 presenter**。分叉：正式化（教学文+presenter 同款 JSON 防护+超时）vs 显式剥离（`...tool` 改白名单挑字段，自造 tool 恒 generic）vs 归 F1 的 client 插件渲染线。现状既不宣传也不设防，不拍也得先堵灰区（剥离是保守缺省，但这也算改动方向，列此供裁决）。

---

## 1. 全量 tool 清单（第一批）

方法：grep `packages/*/src` 的 `ctx.tools.register(defineTool(...))` 全部注册点逐个读实现。「模型可见」以注册进 ToolRegistry 为准。

### 1.1 render intent 词汇（core 现有，先立坐标）

`packages/core/tools/src/presentation.ts`：tool 通过 `presentCall(args)` / `presentResult(args, result)` 两个**纯函数**声明渲染意图（纯函数是因为 live 流式与 session 回放都会调用，只能依赖 args/result）。词汇 = 三种卡型 tagged union：

- `generic`：title + kind 图标（read/edit/delete/move/search/execute/fetch/other 八类）+ rawInput（重点输入，展开区）+ content（ContentBlock[]）+ locations（文件跟随跳转）。
- `terminal`：title=命令 + description + cwd；result 侧 output（stdout+stderr 合并串）+ exitCode/signal 徽章。
- `diff`：title + diffs[]（path/oldText/newText，oldText=null 表新建）+ locations。

result 侧另有约定：字段是**替换语义**（ACP update 替换 content），所以 write/edit 的 presentResult 必须重发 diff 卡，否则原始文本会顶掉 pending diff 卡。`ToolResult.meta` 是 tool 私有展示载荷（execute 对象返回形式附带，随 `tool/result` 事件持久化，presentResult 时窄化回来）——现役唯一用户是 fs write/edit（applied hunks）和 run_code（logs）。

### 1.2 清单表

| tool 名 | 所在包 | args 概形 | result 概形（模型面） | presentCall | presentResult |
|---|---|---|---|---|---|
| `bash` | bash/tool-bash | command\*, description\*, timeoutMs, workdir, run_in_background, sandbox_permissions+justification | 文本：stdout/stderr 尾部截断 + `[exit code: N]`/sandbox 标记；后台模式返回 task id | 前台=**terminal**（title=命令, cwd）；后台=generic(execute) | 前台成功=**terminal**（output+exitCode/signal 解析自文本）；后台/错误=generic fenced console |
| `task_output` | tasks/tool-tasks | task_id\*, wait, timeout_ms | 增量输出文本 + `[status: ...]` 尾行 | generic(read, title=Read output from task X) | —（原文） |
| `task_list` | tasks/tool-tasks | （无） | 任务列表文本（id/kind/status/label 行） | generic(read) | — |
| `task_kill` | tasks/tool-tasks | task_id\*, reason | 确认文本 | generic(execute) | — |
| `read` | fs/tool-fs | file_path\*, offset, limit | 行号文本窗口（字节/行数截断） | generic(read, title=Read path (窗口), locations[line=offset]) | — |
| `write` | fs/tool-fs | file_path\*, content\* | 确认文本；meta.diffs=applied hunks（覆写时） | **diff**（oldText=null，新建样式） | **diff**（meta hunks 优先，fallback args 整文件） |
| `edit` | fs/tool-fs | file_path\*, old_string\*, new_string\*, replace_all | 确认文本；meta.diffs=applied hunks | **diff**（old_string→new_string 字面替换） | **diff**（meta hunks；错误→undefined 走原文） |
| `grep` | fs/tool-fs-search | pattern\*, path, include | 分组匹配行文本，截断+spill 文件路径 | generic(search, title=Grep pattern) | — |
| `glob` | fs/tool-fs-search | pattern\*, path | 路径列表文本（mtime 排序），截断+spill | generic(search) | — |
| `web_search` | web/tool-web | query\* | 摘要+来源 markdown 链接列表 | generic(search, title=query) | — |
| `web_fetch` | web/tool-web | url\* | 页面文本（截断提示） | generic(fetch, title=url) | — |
| `todo_write` | todo/tool-todo | todos\*[]（content+status 三态） | 计数确认文本；**真数据走 session `todo/write` 事件** | generic(other, rawInput=todos) | — |
| `skill` | skill/tool-skill | name\* | skill 全文 | generic(read, title=Load skill X) | — |
| `subagent`（toolName 可配） | subagent/tool-subagent | description\*, prompt\*, run_in_background | 子 agent 最终输出文本；后台模式返回 task id | **无 presenter**（走默认：title=tool 名+raw args） | — |
| `workflow`（toolName 可配） | workflow/tool-workflow | script\*, meta\*(name/description/phases…), args | 脚本 return 值渲染文本（maxResultChars 截断） | generic(title=meta.name) | generic（空对象=保留 pending 标题，原文 content） |
| `cordis_inspect` | cordis/tool-cordis | what(六选一), name | 六节 markdown 文本 | generic(read, title=按 section) | — |
| `cordis_mount` | cordis/tool-cordis | code\* | mounted id/state 文本 | generic(execute, rawInput=code) | — |
| `cordis_unmount` | cordis/tool-cordis | id\* | 确认文本 | generic(delete, title=id) | — |
| `ask_user_question` | ui/tool-ask-user | questions\*[]（id/question/header/options/multi_select） | 用户答案 JSON 文本 | **无 presenter** | — |
| `run_code`（code mode 保留名） | core/tools（code-mode.ts） | code\* | logs+返回值文本；meta.logs | generic(execute, title=整段代码) | generic（content=logs；不带 title 保程序标题） |
| `mcp__<server>__<name>`（动态 N 个） | mcp/mcp-client | 上游 inputSchema 原样 | 上游 content blocks 降级文本透传（见 G10） | **无 presenter** | — |
| `structured_output`（子 agent 私有） | subagent/subagent-inprocess | 按 caller 给的 JSON schema | 捕获结构化结果 | 无 presenter（只在子 agent scope 注册） | — |

\* = required。「—」= 未声明 presentResult（UI 保留 pending 标题+渲染模型面原文）。

### 1.3 清单观察（供后两批引用）

- **O1**：22 个 tool（+MCP 动态族）里只有 bash / write / edit 用了非 generic 卡型（terminal 1 家、diff 2 家）；presentResult 只有 5 个 tool 声明（bash、write、edit、workflow、run_code）。绝大多数 tool 的 UI 表达 = generic 卡 + 模型面文本原文。
- **O2**：presenter 是纯函数、只能看 args/result 两个瞬时值——**协议层面就不存在「执行中间态」的口子**，这是第 2 批缺口分析的根。
- **O3**：多个 tool 的模型面 result 是「已格式化文本」（grep 分组、task 状态行、bash exit 标记），bash 的 presentResult 甚至靠**正则反解析自家文本**（parseExitStatus）取回 exitCode——结构化数据在 execute 内是有的，出了 execute 就只剩串。meta 通道是现役唯一的结构化旁路。
- **O4**：todo_write 是特例：真数据不在 tool result 里而在 session `todo/write` 事件，web 端已有独立 Todo 面板消费，tool 卡本身只是确认行。
- **O5**：subagent、ask_user_question、MCP 族完全没有 presenter，subagent 尤其显眼——后台模式只返回 task id 一行字，子会话所有过程细节都锁在子 session 里（tool-subagent 注释原话：no readOutput, the child session owns intermediate detail）。

---

## 2. 跨 tool 通用数据架构：现状链路与表达力缺口（第二批）

### 2.1 一次 tool 调用在协议上的完整生命线（live 与 replay 同源）

```
【流式 args 期】 StreamChunk 'tool-call-delta'（index+CallId+name?+argumentsDelta，llm/types.ts:155）
                  ↳ 逐 delta 落 session 日志（assistant/chunk 事件）
                  ↳ web PartialAccumulator 累积 argsRaw（partial.ts:38-49），执行前是残缺 JSON 串
【调用定格】     tool/call 事件（callId+name+完整 arguments 串，session/types.ts:232，agent-loop tool-calls.ts:228）
【执行期】       ——— session log 空窗（G1）———
【结果定格】     tool/result 事件（callId+content+isError+error?+meta?，types.ts:242；surface 事件，sourceEventSeqs=[callSeq]）
【展示翻译】     presentCall(args) / presentResult(args, result)——Node 侧纯函数、只吃两个定格时点
                  （标准消费模式=ACP 桥 ToolPresenter，acp/index.ts:1143+；pending 表记 (name,args,card)，
                   result 到达按 callId 取回、result 卡是替换语义）
```

执行期 core 内部**有**一条管线（`tools/pre-execute`→guard→`tools/execute` waterfall→`tools/post-execute`→`tools/result`，core/tools/src/index.ts），但这些是 cordis 总线上的**策略/观察 seam**，不是进度通道：全部围绕「一次调用一个终值」，且不进 session log。协议层结论：**session 事件流里 tool 执行期没有任何中间态词汇**——不是某个 tool 没实现，是 `SessionEventMap` 就没有这个帧型。

web 端管道现状（对照 .agents/notes 2026-07-19-gui-web-client-architecture）：mux = `session/event` 全量透传 + `session/subscribed`；host 通道另有 `host/session-added`（**带 parentSessionId**）、`host/session-status`（running 位）、`host/agent-error`；交互占位走 requested/resolved 帧。web 端 tool 卡材料 = `RunningToolCall{callId,name,argsRaw,turn,step}`（tool/call 折出）+ `ToolResultNode`（tool/result 折出）——presenter 在 web 链路**零消费**（G7=F1/P9 的题面），ToolCallCard 只渲染「执行中…/完成/失败」三态 + args JSON + result 文本原文。

### 2.2 core render intent 词汇的三个关键性质

1. **两时点纯函数**——「执行中」在词汇层就不存在；ACP 的 terminal live 感是假象（见 2.3），core 词汇只有 result.output 一次性交付。
2. **闭合 union**——加第四型卡=动 core+全 UI 桥同落（家规），即 F2/P10 的分叉。
3. **卡型词汇与数据词汇是两层**——presentation 管「怎么摆」，SessionEvent 管「有什么」。web 端缺的首先是「怎么摆」的传输（F1/G7），其次才是「有什么」的过程性扩充（G1-G4）。

### 2.3 ACP 桥的渐进更新机制（参照系）

packages/ui/acp/src/index.ts：`tool/call`→`tool_call`(status: in_progress)、`tool/result`→`tool_call_update`(completed/failed)，**每个 call 恰好两条通知**。要点：

- ACP 协议本身支持**多次 tool_call_update、字段级替换语义**（update 只替换携带的字段）——桥只发一条不是协议限制，是**上游没有中间事件可驱动**。
- terminal 卡的「live scrollback」在 ACP 侧也是假的：输出数据只在完成时随 `_meta.terminal_output` 一次性到达（index.ts:1393）；pending 卡只有 terminal 占位块+cwd 头。Zed 看起来像流式，实际是完成时整段灌入。
- 桥有防御性约定可借鉴：result 侧 terminal 卡必须配对 call 侧 terminal 卡（orphan guard，防孤儿 terminal）；generic result 无 content 时回填原文防白卡。

### 2.4 各 tool 执行期数据「存在面 vs 通道面」逐个核实

| tool | 执行期中间数据（在哪儿真实存在） | 现在谁能看到 | web 事件流可见性 |
|---|---|---|---|
| bash 前台 | stdout/stderr 在 `OutputCollector` 进程内实时累积（bash-local/run.ts:341 `child.stdout.on('data')`）；`BashProcess.readOutput()` 增量接口**存在** | 没人——前台 `run()` 只返回终值，readOutput 只有后台任务在用 | **零**：空窗到 tool/result 一次性到达 |
| bash 后台 | 同上 collector + tasks 服务 `read()` 增量游标 | **只有模型**（调 task_output 才读一次）；产生的 delta 以 task_output 的 tool/result 形式进 log | 间接、碎片化：scrollback 散落在 N 张 task_output 卡里，节奏由模型轮询决定 |
| 任务生命周期（bash/subagent 后台） | tasks 服务内 TaskSnapshot（status/detail） | 模型（task_list/task_output）；完成时 `onTaskDone`→owner.inject 一条 context/message | 起点卡只有「started task N」文本；状态翻转无事件，完成通知混在 context 消息里；起点卡↔后续 task_output 卡无关联键 |
| workflow | **六个专用事件已存在**：`workflow/start|phase|log|agent-start|agent-end|end`（packages/workflow/workflow/src/index.ts declare module） | 只有 cordis 总线监听者；**不进 SessionEventMap、不持久化**；grep 全仓当前零 UI 消费者 | **零**：mux 只透传 session/event。一个跑几分钟、几十个子 agent 的 run，web 上是一张静止 generic 卡 |
| subagent 前台 | 子会话是**完整独立 session**：`session/created` 触发 mux `session/subscribed`，子 session 全事件流对 web 可见；header.parentSession + `host/session-added.parentSessionId` 给出**会话级**父子关系 | web 理论上已能拿到全部子会话事件（数据面近乎完备） | **关联缺口而非数据缺口**：`callId → 子 sessionId` 无任何事件记录（`subagent/start` 事件带 runId+子 id，但在 cordis 总线且不带 callId）；web 只能靠时序猜哪张卡对应哪个子会话 |
| subagent 后台 | 同上 + tasks；tool-subagent 明确不给 readOutput（「the child session owns intermediate detail」） | 同前台 | 同上 + 起点卡只有 task id 文本 |
| run_code（code mode） | **每次嵌套派发已有 log-only session 事件** `tool/code-dispatch{parentCallId, subCallId, name, arguments, isError, resultSummary}`（声明 code-mode.ts:34，append :208，turn-enclosure 由 execute 期间 append 保证） | 任何 session log 消费者——**全仓唯一现成的「tool 内部时间线」词汇** | 事件到得了 web，但 fold-adapter 落 default 分支成 `unknown` 节点，UI 没做卡；嵌套关系（parentCallId）无人消费 |
| write/edit | applied hunks 在 execute 内算出，经 `meta.diffs` 随 tool/result 持久化 | ACP diff 卡已消费；结构完备 | 事件到达 web（meta 原样在 ToolResultNode.meta），**web 卡未消费**（当 JSON 块展示） |
| task_output/grep/glob/web_search 等 | 结构化数据（匹配列表/来源列表/状态枚举）在 execute 内存在，**格式化成文本后即丢弃** | 模型看文本；bash presentResult 靠正则反解析自家文本找回 exitCode（O3） | 只有文本；web 想做富卡（表格/链接列表/状态徽章）得再 parse 一遍文本 |
| ask_user_question / 审批 | `approval/asked{id,toolName,callId,reason}`/`approval/decided{id,outcome}`/`approval/policy` 是 **log-only session 事件**（user-approval/src/index.ts:323） | session log 消费者 | 事件可达但未与 tool 卡关联：web 的等待占位来自 requested/resolved rpc 帧，跟卡两套体系；callId 关联键其实已有 |
| todo_write | `todo/write` session 事件（全量快照语义） | web Todo 面板已消费 | ✅ 无缺口（现状体系里最完整的一条：专用事件+专用面板） |

### 2.5 缺口清单（G1-G11，统一编号，第三批表格引用此处）

- **G1（根缺口）**：`SessionEventMap` 无 tool 执行期中间态帧型；`tool/call`→`tool/result` 两点式对「持续刷新型」tool 表达力为零（全仓无 `tool/progress` 类词汇；presentCall/presentResult 纯函数签名连表达口子都没有）。下列缺口某种意义上都是 G1 的投影。
- **G2**：bash 输出数据存在但无 UI 通道——前台 stdout 渐进流在进程内累积、增量 readOutput 接口存在但无人消费；后台输出与状态翻转依赖模型轮询才进事件流，scrollback 碎片化在 N 张 task_output 卡、起点卡与后续卡无关联键。terminal 卡的 live scrollback 全生态（含 ACP）都是完成时一次性灌入。
- **G3**：workflow 六事件（phase/log/agent-start/agent-end…）cordis-only、不持久化、mux 不可达——进度卡/嵌套时间线的数据源整体缺席；replay 时同样没有（未持久化），连「事后重建时间线」都不行。
- **G4**：subagent 的 callId→子 sessionId 关联无事件；子会话数据面已可达（mux 全订阅+parentSessionId），缺的只是一个锚点。
- **G5**：结构化 result 数据出 execute 即降级为文本（O3 的架构面）；meta 通道是唯一旁路但**单点终态**（结果时刻交付一份），现役只有 write/edit(diffs)+run_code(logs)。富卡（表格/链接/徽章）要么 UI 反解析文本，要么逐工具补产 meta（词汇现成、不动协议，即 F5）。
- **G6**：流式 args 期 UI 语义弱：argsRaw 是残缺 JSON，client 只能整串展示或 parse 失败兜底（ToolCallCard.tsx:39-42）。diff 卡想流式期渐进显示 new_string、terminal 卡想早显 command，需要容错局部解析——纯 client 技术，协议无缺口；但若 F1 选 host 算卡，host 也得会算「部分卡」。
- **G7**：presentCall/presentResult 是 Node 侧 ToolDefinition 上的纯函数，web 端拿不到（=P9 的技术根源；ACP/TUI 能用是因为同进程）。
- **G8**：`tool/code-dispatch` 嵌套时间线词汇已存在但 web 未消费（fold 落 unknown）；它同时证明「执行期结构化过程进 log-only 事件」家规内可走，是 F3 新帧型的现成先例——但它是工具私有词汇，无通用形，要不要通用化正是 F3。
- **G9**：审批/问答与 tool 卡的关联键（callId）在 approval/asked 里已有，但 web 用 requested/resolved 帧另起一套占位体系，卡上看不到「此调用等待审批中」。
- **G10**：MCP 多模态结果块被丢弃：image/audio/resource 降级为占位文本（mcp-client tools.ts extractText），根因是 core ContentBlockMap 无对应块型——与 gui-arch P13（图片输入）同一条 core 词汇线，输入输出两面。
- **G11**：MCP 族/模型自造 tool 恒无 presenter（自造 tool 教学不教、机制灰区见 F8）；任何渲染方案都需要 generic 兜底路径。

### 2.6 G1/G2 的解法空间与红线定位（供 F3/F4 拍板参考，不拍）

| 分叉 | 机制 | 代价 |
|---|---|---|
| A：core 通用 `tool/progress` log-only 事件 | callId 锚定+工具自定 opaque payload；回放可重建执行过程 | 日志体积（bash scrollback 全量落盘≈chunk 风暴第二个来源）；需明确 log-only 定位（先例在，见下） |
| B：live-only 旁路帧（mux 新帧型不落 log） | 断线丢段、以 result 收敛——与 web 端 partial 恢复哲学同构（token 增量不补发，以 assistant/message 定稿收敛，web-runtime 现行为） | 回放时无过程（F4 的不一致问题）；mux 帧型第一次出现「无日志对应物」的类别 |
| C：逐工具自造 log-only 事件（G8 模式推广） | 零新通用机制；每 tool 语义最贴身 | N 个 tool N 支词汇；client 逐支消费；「通用进度条」组件无统一数据形 |
| D：混合——低频结构化里程碑走 A/C 落日志，高频原始输出走 B 旁路 | 各取所长 | 两条通道都要建；每个 tool 要划分「里程碑 vs 原始流」 |

红线定位：「Model-visible ⟺ logged」只约束模型可见输入必须可从 log 重建；执行期中间态不是模型输入，红线不强制持久化。仓里已有三类先例可归：**log-only 事件**（approval/\*、hook/\*、todo/write、tool/code-dispatch——持久化但不进模型面）、**cordis-only 事件**（workflow/\*、subagent/start|end——不持久化）、**meta 通道**（持久化、随 tool/result、tool 私有）。F3 本质是在问中间态归哪一类，或是否新增第四类——持久化与否 × 进不进 mux 的四象限里，「不持久化但进 mux」这格现在是空的（`host/*` 帧勉强算，但那是 host 级不是 session 级）。

### 2.7 F1（谁算卡）与 G1 的耦合（提醒，不拍）

- F1 选 host 算卡下发：进度顺势由 host 折成「卡片更新帧」推送，client 薄；但 presentCall 纯函数要扩成多时点，core 词汇动静大。
- F1 选 client/插件渲染：G1 只需把原始过程数据送到 web（2.6 任一通道），折卡是插件的事；core presentation 不动，但每个 tool 的 web 半边要自带渲染（连到 web-cordis 蓝图）。
- 双轨则两条数据通道都要。

---

## 3. 每 tool 理想展现形式表（第三批）

卡型词汇（本表用，不预设归 core 还是 client——那是 F1/F2 的裁决）：**纯文本折叠** / **diff 卡** / **terminal 卡**（scrollback+exit 徽章）/ **进度卡**（阶段+计数+活动行）/ **widget 卡**（表格/链接列表/键值）/ **嵌套时间线**（卡内展开子调用/子 agent 序列）/ **交互卡**（含回程动作）。「理想卡型」列是**候选素材**（供产品拍板，非定稿）。数据需求：一次性=call/result 两时点够；持续刷新=需 G1/G2/G3 类通道；可交互=需 F6 回程通道。

现状 web 渲染统一为 generic JSON 折叠卡（ToolCallCard：状态点+tool 名+args JSON 块+result 文本/JSON 块），无一例外——「现 web 渲染」列略。

| tool | 理想卡型候选 | 数据需求 | 卡上该有什么（超出现状的部分加粗） | 依赖缺口 |
|---|---|---|---|---|
| bash 前台 | **terminal 卡** | **持续刷新**（stdout 渐进）；完成后一次性可接受为第一档 | 命令+cwd 头、**scrollback**、**exitCode/signal 徽章**（现在靠正则反解析）、sandbox 拒绝标记 | 完成态：G5（exitCode 结构化）；live：G1+G2 |
| bash 后台 | terminal 卡+**任务状态徽章**；或启动即折叠成「后台任务 chip」链接任务列表 | 持续刷新 | task id、**实时状态（running/killed/done）**、**连续 scrollback**（而非 N 张 task_output 卡碎片） | G2；任务变更帧=gui-arch E7 线 |
| task_output / task_list / task_kill | 纯文本折叠（保持轻量）；task_output 可选 terminal 风格正文；task_list 可作**表格 widget** | 一次性 | 状态行徽章化（`[status: ...]` 是稳定文本约定，可 UI parse 兜底） | 无硬缺口；徽章结构化归 G5；widget 归层 F2 |
| read | 纯文本折叠（行号代码块） | 一次性 | 文件路径可点击（locations 词汇已有）、行窗标注、**语法高亮** | 无（传输面 G7 而已） |
| write / edit | **diff 卡**（词汇现成） | 一次性；流式期渐进显示 new_string 可选 | applied hunks 渲染（**数据已在 meta.diffs 里到达 web**，只是 UI 当 JSON 展示）——全表唯一「零协议改动、纯 client 工作」就能落地的富卡 | 仅 G7（或 client 按 tool 名+meta 约定渲染，即 F1 路线 b 最小样本）；流式增强=G6 |
| grep / glob | **widget 卡**（匹配列表：文件分组、行号可点）/ 纯文本折叠兜底 | 一次性 | 结构化匹配列表、spill 文件提示、**点击跳文件** | G5（列表出 execute 即文本化） |
| web_search | **widget 卡**（来源链接列表+摘要条目化） | 一次性 | 可点击来源列表（现为 markdown 文本，UI 可 parse 兜底） | G5 |
| web_fetch | 纯文本折叠（URL 头+markdown 预览折叠） | 一次性（阶段进度可选） | URL 可点击、truncated 标记 | 无硬缺口；阶段进度=G1 |
| todo_write | 现状即可（独立 Todo 面板）；卡本身保持确认行；面板可升级**todo 清单 widget**（勾选态） | 一次性（事件天然全量快照） | — | 数据零缺口（O4）；widget 归层 F2 |
| skill | 纯文本折叠 / 一行 chip（skill 名+状态） | 一次性 | skill 名徽章 | 无 |
| subagent 前台/后台 | **子会话卡/嵌套时间线**：子 session 状态点+末次活动摘要+计数，点击进子 session（内嵌或跳转）；运行中活动脉冲 | **持续刷新**（子会话事件流） | **callId→子 session 链接**、子会话状态、末次活动摘要 | G4（只差锚点事件，数据面已可达）；展示深度随 F7 |
| workflow | **进度卡**（phase 进度+agent 运行/完成计数+log 尾行）→ 展开成**嵌套时间线**（agent-start/end 泳道） | **持续刷新** | **phase 标题、agent 计数、log 流尾行**——数据在 workflow/* 六事件里都有，一个都到不了 web | G3（含 replay 缺席）；F7 主战场，**全表缺口最深** |
| run_code | terminal 风格正文（代码高亮+logs 区）+ **嵌套时间线**（sub-dispatch 子调用列表逐条展开） | 准持续（code-dispatch 事件随执行陆续到达） | **卡内子调用列表**（name/args 摘要/isError）——事件已到 web，只是 fold 落 unknown | G8（纯 client 消费即可开工，协议零改动）；执行中刷新=G1 |
| cordis_inspect | 纯文本折叠（markdown 渲染）；可升级服务/插件表 widget | 一次性 | section 徽章 | G5（轻）；widget 归层 F2 |
| cordis_mount / unmount | **mount 卡**：代码高亮+挂载产物（新服务/工具清单）+guard 报错友好显示——「Vibe a plugin」主视觉载体 | 一次性 | mount id/state 徽章、waiting-services 提示（在结果文本里） | G5（轻，挂载产物文本化）；自造 tool 展示=F8 |
| ask_user_question / 审批中的任意 tool | **交互卡**（web 作答里程碑后）；当前至少「等待中」状态徽章 | 可交互（respond 模式已有先例） | **卡上显示等待审批/提问状态**（callId 关联键在 approval/asked 已有）；作答回程走 respond 帧 | G9；回程归 F6；pending registry 实装是前提（gui-arch E-pending） |
| MCP 族 | generic 兜底（保底路径必须存在）；按内容类型分型、image 块可显 | 一次性为主 | args/result JSON 折叠即现状 | G10（多模态块丢弃）+G11 |
| 模型自造 tool | generic 兜底 | 一次性 | — | G11；F8 |
| structured_output | 不渲染或一行 chip（子 agent 私有） | 一次性 | — | 无 |

### 3.1 从表格反推的结构性观察（事实性汇总，不是方案拍板）

1. **富卡需求分三档，成本完全不同**：
   - **零协议改动档**（client 纯前端工作）：write/edit diff 卡（meta.diffs 已到达）、run_code 嵌套列表（code-dispatch 已到达）、read/grep 等文本 parse 兜底富化、审批状态徽章（approval/asked 可达）。
   - **补锚点/搬运档**（小协议加法）：subagent 的 callId→子 session 锚（G4 一个事件）、workflow 六事件入 session log 或 mux（G3）、bash exitCode 等结构化 result（G5 扩 meta 约定即可，有 write/edit 先例）。
   - **新通道档**（真正的架构决策）：bash 前台 live scrollback、后台任务推送（G1/G2）——需要 F3 拍板中间态帧型。
2. **「持续刷新」需求只集中在四个 tool**（bash 前台、后台任务、subagent、workflow），且对应三种不同数据源形态：executor 内存流（G2）、独立子 session（缺关联锚，G4）、cordis 总线事件（不进 log，G3）——单一通用 `tool/progress` 方案未必同时优雅覆盖三者，2.6 的分叉值得对着这三个实例拍。真正需要从零造数据源的只有 bash scrollback 一个。
3. **一次性 tool 的理想化大多只差两样**：卡型传输到 web（F1/G7）+ 工具侧往 result meta 补产机器形（G5——词汇现成、逐工具小改、不动协议）。
4. **widget 卡的真实候选**（F2/P10 素材）：task_list 表格、todo 清单、web_search 结果列表、grep 命中列表、cordis_inspect 服务表——五个里四个是「结构化列表/表格」，一个「列表卡」词汇可能覆盖大半；「表格/图表/键值/svg」全家桶未必都有现实消费者。
5. **diff/terminal 两型的消费者集中度极高**（O1：terminal 1 家、diff 2 家）——若 F1 选 host 下发，三型卡通道的第一批受益者明确且窄；generic+meta 结构化（G5）反而是覆盖面最大的改进杠杆。
6. **G7 不阻塞第一档**：web 端按 tool 名硬编码渲染器与 presentCall 纯函数语义等价（都只依赖 args/result/meta），F1 拍板前可先用「client 按 tool 名分派」过渡，正式路线定了再收编。

---

## 4. 与既有工作的衔接

- F1/F2 即 arch-research report（20260720-1640）P9/P10，选项空间与依赖在彼处（含「P9/P10 压到 cordis 设计轮」结论），本报告不重复；本报告补充的新证据：三型卡实际用量（O1）、widget 真实候选五例（3.1-4）、presenter 传输断点的技术根源（G7）、自造 tool presenter 灰区（F8）。
- 本报告新增、彼报告未列的缺口：G1 执行期进度通道（最大单一缺口）、G3/G4（F7 的两个实体）、G5 结构化退化成串（覆盖面最广的小改杠杆）、G9 审批与卡两套体系、G10 MCP 多模态块丢弃（与 P13 同一条 core 词汇线）、F6 可交互卡回程通道。
- E-cordis-types（类型子路径出口）是 F1 无论选哪条路线的前置，已在 arch-research E 表立项；blueprint-v2（web-cordis）承载 F1 路线 b 的 renderer slot 设计，F8 天然归入该线。
- E-consume（client 消费扩面）线获得具体优先级素材：code-dispatch 卡数据已齐可直接消费（G8）；workflow 六事件数据到不了 client，消费前提是 F7 拍板（G3）。
- 若立项，建议按 3.1-1 三档切工作包：第一档不等任何分叉裁决即可开工。
