# GUI 功能点 → 架构演进预判（调研报告）

> 2026-07-20 · owner: arch-research。输入=[feature-list.md](feature-list.md)（用户功能点清单，多为待定/远期）。**产出不是实现方案，也不替用户拍产品形态**：清单里的（待定）项本来就是没定的方向。本报告做两件事：①把「架构结论依赖产品形态」的点整理成**分叉式问题清单**（选 A 则架构要 X、选 B 则要 Y，不下结论），放最前供拍板；②只把**形态无关的架构事实**（不管产品怎么定都成立的）写成演进项结论。所有「已覆盖」均盘上核实（file:line 以本 worktree 时点为准）。

---

## 第零部分：待拍问题清单（先行）

### A. 产品形态待拍（形态决定架构分叉）

> 「架构要改什么」列=最短判定（⓪ 标零改动项）；选项细节在末列。

| # | 问题 | 架构要改什么 | 分叉：选什么 → 架构要什么 |
|---|---|---|---|
| P1 | project 分组：自动按 folder / 手动 / 都要？ | 自动：不改⓪ / 手动：新建元数据存储 | 自动按 cwd → **零新增**（`session.cwd = project 路径`已实装并进 summary，[feature-session 裁决](../20260720-1030-feature-session/README.md)）。手动分组 → 需要 session log 之外的**元数据 sidecar 存储**（结构级新面，同 P3 title 共用） |
| P2 | band 分组（观察/迭代/运行时）三态的定义是什么？ | client 折算：不改⓪ / 手动标记：元数据存储 / host 新概念：改 core | 若=client 按活动态折算 → 零演进。若=用户手动标记 → 落元数据面（同 P1 手动）。若=host 运行时新概念 → core 先定义、再进契约 |
| P3 | session 行显示基本信息（标题/最近活动/事件·工具计数，均待定）采哪些？ | 只活动时间：不改⓪ / 计数·摘要：新建 host 统计面 / 标题：元数据存储 | 只采「最近活动」→ 零新增（updatedAt 已有，[sessions.ts:27](../../../packages/host/apiproxy/src/api/sessions.ts)）。采任一「计数/末事件摘要」→ 必须 **host 侧统计/索引面**（client 拉全量 history 折算不可行）。采「标题」→ 元数据存储 + P4 |
| P4 | 标题自动摘要的生成方式？ | 截断：host 小逻辑 / LLM 摘要：加模型调用链 | 首条用户消息截断 → 零成本，纯 host 逻辑（旧定稿方案，[ui-product §6](../../ui-product.md)）。LLM 摘要 → 每 session 一次模型调用，成本与触发时机归属要定 |
| P5 | quick chat 的 session 归属？ | 进列表：不改⓪ / ephemeral：元数据 hidden 标记 | 正常 session 进列表 → **零演进**（多 client 并连已实测零改造，[multiclient 报告](../20260720-0356-multiclient-research/report.md)）。ephemeral 不进列表 → 需元数据 hidden 标记（压 P1/P3 的元数据面） |
| P6 | 子 session 要不要区分「fork 来源」与其他谱系关系？ | 不区分：不改⓪ / 区分：core header 加一字段 | 不区分 → 零新增（parentSessionId 已齐）。区分 fork/spawn → core `SessionHeader` 加谱系 kind 字段（[types.ts:47](../../../packages/core/session/src/types.ts) 现在只有 parentSession 无关系类型；pre-release 可直改） |
| P7 | 聚合视图三子视图（Tree/Topology/Board，均待定）采哪个？ | Tree/Board：新建统计面（同 P3）/ Topology：mux 订阅集改造 / 卡片 fork：契约升格座 | Tree/Board 的计数·摘要·todo 列 → 压统计面（同 P3）。Topology 常开 → session 量大时压 **mux 全量广播承载**（订阅集/背压演进；`since` 座只覆盖续传，[events.ts:20](../../../packages/host/apiproxy/src/api/events.ts)）。Board 点卡片 fork → 压 fork(boundary) 进契约（E-fork 的参数面） |
| P8 | trace 独立一级页 vs 并入 session 界面 tab？ | 单 session：不改⓪（放哪都行）/ 跨 session 索引页：新建 host 聚合面 | **单 session 内**：放哪都一样——数据源=session log（零新数据面，形态无关，见事实 F4）。**跨 session 索引页**（成本/错误率/P50/P99/tokens 汇总表）→ 需要 host 侧聚合面（同 P3 统计面的扩展维度）+ 成本价目表归属。真正的拍板点是「要不要跨 session 一级页」 |
| P11 | edit & re-run / 消息 edit-rerun（均待定）：改写算新分支还是修订历史？ | 新分支：fork 扩展 / 修订历史：独立 RFC（动日志真实性） | 两者底座都是 core `Session.fork(source, boundary)`（[session/index.ts:843](../../../packages/core/session/src/index.ts) 已有）。「新分支」→ fork 语义扩展（改写种子）；「修订历史」→ 触碰日志真实性（改写如何标记），需要独立 RFC。形态先定，架构随之 |
| P12 | feedback 标注（optional/待定）的数据归宿？ | 不采：不改⓪ / 采：新建标注存储（可与 P1/P3 元数据同居） | sidecar（seq 锚定、不进 session log）vs 进 session log——标注非模型可见，「model-visible⟺logged」纪律不要求进 log，但也没禁止独立存储。与 RL/rubric 链路打通的导出格式是外部输入，需用户给对接方 |
| P13 | 图片输入（optional）采不采？ | 不采：不改⓪ / 采：core 内容块+adapter+compaction+载体四线全动（最贵单项） | 采 → core `ContentBlockMap` 扩多模态块（[llm/types.ts:44](../../../packages/llm/llm/src/types.ts) 现只有 text/reasoning/tool-call/tool-result）+ 家规「新 core 块必须连 adapter、UI、compaction 支持一起落」+ 二进制上 wire 的载体设计（base64 vs 旁路上传）。**optional 项里架构成本最高的一个**，值得单独拍 |
| P14 | bash 模式（optional，直接跑命令）采不采？ | 不采：不改⓪ / 采：契约新增直接执行通道（安全边界先划） | 采 → 契约新增「不经模型直接执行」通道：web client 从「对话投影」变成有绕过 agent loop 审批链的命令面，与「Host 权威/唯一通道」原则的边界要先划。不采 → 零演进 |
| P15 | slash 命令在哪端展开？ | 两选项都只需 skill 目录透出（契约加法）；host 端展开另加一种命令语义 | client 拉 skill 目录本地展开成 prompt（薄，host 零新语义）vs host 端 prompt 预处理（跨端一致，但契约多一种命令语义）。两选项都需要 skill 目录透出（形态无关部分，见事实 F7） |
| P16 | plugin 安装 / GUI 直接改 cordis.yml 采不采？（与旧定稿「界面不承担插件管理」冲突，[ui-product §13](../../ui-product.md)，需重拍） | 采：host 装配 Loader 化+配置写通道（**最大 R**）/ 不采：只列表展示（契约加法） | 采 → **host 装配 Loader 化 + 配置写通道**（结构级：bootHost 现在是手工 `ctx.plugin()` 序列、无配置文件可改，[boot.ts:50-61](../../../packages/host/runtime/src/boot.ts)；vendor/loader 的 EntryTree write-back 能力现成，[loader/index.ts](../../../vendor/loader/src/index.ts)）。不采 → 只做列表展示（契约加法，见事实 F8） |
| P17 | config 视图形态：「打开 cordis.yml」按钮 vs 界面表单？ | 按钮：路径透出一个方法⓪级 / 表单：随 P16 全套 | 按钮 → 最小面=文件路径透出（与 Find in Finder 同款 locate 通道）。表单 → 需要 P16 的写通道全套 + 逐插件 Config schema 透出 |
| P18 | Onboarding（optional）采不采？ | 不采：不改⓪ / 采：llm 空载态（core 小改）+凭据写入通道 | 采 → 「先起 host 再配 key」与现状 fail-loud boot 矛盾（key 缺失插件加载即 throw，[settings-research B3](../20260720-0920-settings-research/settings-inventory.md)）：需要 llm 插件「未配置」空载态 + 凭据写入通道与脱敏纪律。不采 → 零演进 |
| P19 | plugin Playground（待定）立不立项？ | 无独立改动项（复用 P16+fork）；只定立项与否 | 架构上无独立新项（=「一次性 session + 指定插件集」，落在 P16 装配可配置 + fork 原语之上）；产品形态完全未定，仅需确认立不立项 |
| P20 | 飞书图片缺失 | 待补图 | config 视图原文一张图未能获取，该处功能点可能有本报告未覆盖的要求，补图后增补 |

### B. 架构路线待拍（功能点已列但实现路线分叉）

| # | 问题 | 架构要改什么 | 分叉 |
|---|---|---|---|
| P9 | tool 卡展示的 web 端路线（「plugin 自定义 tool call 展示”未标待定，但路线没定）：presentCall/presentResult 是 node 侧纯函数（[presentation.ts](../../../packages/core/tools/src/presentation.ts)），wire 只透传原始事件——谁来算展示？ | a：host 投影下发（契约加法）/ b：browser 插件渲染（web-cordis 全线）/ c：双轨（a+b 都做） | 路线 a：host 算好 ToolCallView/ResultView 随帧/投影下发——契约加法，三型卡（generic/terminal/diff）先能用；新卡型受 core 闭合词汇限制。路线 b：browser 半边插件对原始事件自渲染——走 web-cordis（[blueprint-v2](../20260719-2339-web-cordis-design/blueprint-v2.md)），开放但依赖双端插件落地。路线 c：双轨（第一方走 a、插件走 b）。 |
| P10 | widget 卡（待定：表格/图表/选项/键值）落在哪层？ | core 扩第四型卡（动闭合 union）/ 归插件渲染：core 不改⓪ | core 三型卡扩第四型 → 动闭合 union，按家规每型全 UI 桥同落。归插件渲染 → core 词汇不动，依赖 P9 选 b/c |
| P21 | Goal 功能与 round 层级：Goal 未标待定但 core 无此概念（agent-loop 只有 turn/step 边界，[types.ts:187-197](../../../packages/core/session/src/types.ts)）——它是 core 产品路线上的确定项，还是 GUI 侧速记？round 边界谁开谁关？ | 需 core 新概念定义（事件词汇追加机制已备，追加本身⓪级） | 形态无关的部分：`SessionEventMap` merge-extensible + client documented-default 兜底（[RFC 透传节](../../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md)）——round 边界事件将来可无痛追加、旧 client 不坏。形态相关的部分：round 语义本身，先要产品定义 |

### 速览汇总

- **全走 ⓪ 则零工程**：P1 自动分组、P2 client 折算、P3 只活动时间、P5 进列表、P6 不区分、P8 单 session、P12/P13/P14/P18 不采、P10 归插件——这一档全选时，除既定 A 级演进项（第一部分 E 表）外不新开任何工程线。
- **真正开工程线的四个大件**：①**P16 Loader 化+配置写通道**（牵 P17 表单、P18 onboarding、P19 playground——四条一起拍）；②**P3/P8 host 统计聚合面**（牵 P7 Tree/Board——计数、摘要、跨 session 汇总同一个面）；③**P1/P5/P12 元数据 sidecar**（手动分组、hidden 标记、标注存储一次拍三条，可与 ② 合并设计）；④**P13 多模态**（独立、单项最贵）。
- **P9/P10 压到 cordis 设计轮**：tool 卡路线与 widget 卡归层跟 web-cordis（blueprint-v2）设计一起定，不单独拍。

---

## 第一部分：形态无关的架构事实与演进项

以下结论不依赖任何（待定）项的走向——无论产品怎么定，只要对应功能簇做任何一种版本，这些就成立。

### F. 已覆盖事实（零架构演进，直接消费）

| # | 事实 | 依据 |
|---|---|---|
| F1 | **树形 session 列表的数据已齐**：summary 带 parentSessionId/cwd/running，`host/session-added` 帧带谱系锚，client lineage 扁平化已实现 | [sessions.ts:24-34](../../../packages/host/apiproxy/src/api/sessions.ts)、[events.ts:41](../../../packages/host/apiproxy/src/api/events.ts) |
| F2 | **多 client / quick chat 载体零改造**：mux fan-out、并发 prompt FIFO、审批 resolved 收敛面天然支持多消费者（实测）；唯一限制=浏览器每源 6 连接 | [multiclient 报告](../20260720-0356-multiclient-research/report.md) |
| F3 | **发送三态（idle/queue/steer）与停止已 1:1 映射 core**，无缺口 | sessions.ts:54、[agent.ts send/steer/cancel](../../../packages/core/agent-loop/src/agent.ts) |
| F4 | **单 session 甘特图/时序/trace/全量回放零新数据面**：「model-visible⟺logged」纪律下，每事件带 seq+time、turn/step 边界、callId 配对、per-step usage（[types.ts:226,330](../../../packages/core/session/src/types.ts)）全在 log；数据源=history 重放 | RFC 会话语义节 |
| F5 | **原始记录/JSON 右栏零缺口**：wire 上就是原始 SessionEvent（透传纪律，不造 DTO） | RFC 透传节 |
| F6 | **思考流/step 行的 token+时长折算零缺口**：reasoning 块、usage、time 齐备，纯 client 折算 | 同 F4 |
| F7 | **skill 目录 host 侧现成**：`ctx.skills.list()` 已有（[skill/index.ts:230](../../../packages/skill/skill/src/index.ts)），透出是契约加法（P15 只影响展开端，不影响目录读） |
| F8 | **plugin 列表数据源现成**：cordis registry 枚举与 tool-cordis inspect 同源（[tool-cordis](../../../packages/cordis/tool-cordis/src/index.ts)），透出是契约加法 |
| F9 | **「Vibe a plugin」的模型侧闭环已存在**：tool-cordis mount/inspect/unmount（demo:cordis）；GUI 面=消费其 tool 事件 + 既有 approval 通道，无独立新原语 |
| F10 | **session 级设置覆盖有已验证模板**：`bash/sandbox-mode` durable log-only 事件 + fold 最新生效（[session-mode.ts:20](../../../packages/bash/bash/src/session-mode.ts)）——thinking/model/permission 照此扩词汇是同构加法 |
| F11 | **settings 读面已逐项盘点**：describe 已有项 + 契约加法项 + core 改动项的完整清单在 [settings-research](../20260720-0920-settings-research/settings-inventory.md)，圈选即用 |

### E. 形态无关演进项（不管待定项怎么拍都要长的）

| # | 演进项 | 分类 | 说明 |
|---|---|---|---|
| E-pending | 审批/问答 pending registry 实装（respond stub 转正） | **A**（纯 host impl，契约已齐） | 既定欠账（[audit R4/挂起 T4](../20260720-0300-web-dev-2-onboarding/audit.md)）；「wait for input 状态」「审批卡可答」全部压它 |
| E-fork | `session.fork` 预留座升格 | **A**（RFC 预留清单座位） | Fork session 未标待定；boundary 参数是否一并进契约取决于 P7/P11 的采用面 |
| E-inject | `prompt.mode` 加 `'inject'` 升格 | **A**（预留座） | btw/side 未标待定；core `agent.inject()` 已有（[agent.ts:249](../../../packages/core/agent-loop/src/agent.ts)） |
| E-models | `host.listModels` 升格 | **A**（预留座） | 输入框改 model 未标待定；host 侧 `llm.listProviders/listModels` 现成（[llm/index.ts:143,153](../../../packages/llm/llm/src/index.ts)） |
| E-settings-w | session 级设置写通道（thinking/model/permission 的事件族 + unary） | **A+core 事件词汇** | 「改设置」未标待定；机制=F10 模板复制，具体设置项集合等圈选 |
| E-settings-r | host.settings 读域 | **A** | config 视图读面未标待定；范围=F11 清单圈选 |
| E-locate | session 文件路径透出（Find in Finder） | **A** | 未标待定；persistence seam `locate()` 现成 |
| E-plugin-ls | plugin.list/状态域 | **A** | 「当前已安装 plugins」未标待定；数据源=F8 |
| E-skill-ls | skill.list 域 | **A** | slash 命令未标待定；数据源=F7；展开端归 P15 |
| E-consume | client 事件消费扩面：code-dispatch（[code-mode.ts:18](../../../packages/core/tools/src/code-mode.ts)）、workflow 六事件（[workflow 包](../../../packages/workflow/workflow/src/index.ts)）、cordis mount/inspect、compact 三事件（[compact/types.ts](../../../packages/compact/compact/src/types.ts)）、context/steering 卡 | **A**（零契约改动，RFC「消费一种新帧型」三步批量应用） | code mode/cordis/workflows 展示未标待定；compact/context 卡虽标待定但消费机制同一条路，做与不做只差渲染支 |
| E-cordis-types | 核心包纯类型 `/types` 子路径出口整备 | **A**（exports 加条目+import 改道） | [cordis-spike 实证](../20260720-1620-cordis-spike/README.md)：apiproxy `/api` 闭包经 barrel 拖进 7 个 node 增补——**「plugin 自定义 tool 展示」（未标待定）无论 P9 选哪条路线，双端插件的类型隔离都是前提**，此项是它的前置 |

### 条件演进项（被 P 触发，此处只登记不展开）

| 触发 | 演进项 |
|---|---|
| P1 手动分组 / P3 标题 / P5 ephemeral / P12 sidecar | session 元数据 sidecar 面（log 外第二存储归属，R；旧 [ui-tech §5.1](../../ui-tech.md) SessionIndex/metadata store 设计可参考，载体换四象限） |
| P3 计数·摘要 / P7 Tree·Board / P8 跨 session 索引页 | host 侧统计/索引服务（R；读底座可用 [sessionQuery](../../../packages/session-query/session-query/src/index.ts) / persistence seam） |
| P7 Topology 常开 / 全局事件流规模化 | mux 订阅集/背压（R-lite；audit R2 台账的正式化） |
| P8 trace 语义信号（loop/重复调用高亮） | 分析器产出 log-only 事件（A 级机制；[repeat-tool-guard](../../../packages/guard/repeat-tool-guard/src/index.ts) 已有 host 侧观测先例）或 client 启发式——载体形态随 P8 |
| P6 谱系区分 | core header 谱系 kind 字段（A+core） |
| P9/P10 tool 卡路线 | 路线 a=投影通道（A）；路线 b=web-cordis renderer slot（R，蓝图在途） |
| P11 edit&re-run | 分支/重放语义 RFC（R） |
| P12 标注 | 标注域（R-lite） |
| P13 图片 | 多模态内容块（R，三线同落） |
| P14 bash 模式 | 直接执行通道（R-lite，安全边界先行） |
| P16/P17 写通道 / P18 onboarding / P19 playground | host 装配 Loader 化 + 配置写通道（R）；onboarding 另需 llm 空载态（R-lite） |
| P21 goal/round | core 概念定义（R）+ 事件词汇追加（A，机制已备） |
| P8 跨 session 成本汇总 | 价目表配置归属（随统计面） |
| trace tri-view 溯源（随 P8） | sessionQuery 透出域（A，服务现成） |
| P7 Board 后台任务聚合 | `task.list` 预留座升格 + 任务变更帧（A；`ctx.tasks` 现成，[tasks/index.ts:153,283](../../../packages/tasks/tasks/src/index.ts)） |

---

## 第二部分：功能簇逐张表

> 「缺口」列凡依赖产品形态的，只指向 P 条目不下结论；只有形态无关项直接给 E/F 编号。

### 簇 1 左边栏（session 列表）

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 子 session 展开/谱系 | F1 | 无 |
| fork 来源标注 / 父不在列表 | F1（parentSessionId 有；关系类型无） | P6 |
| project 分组 | cwd 语义已实装（P1 依据列） | P1 |
| live 状态点 | `host/session-status` + mux 活动信号（F1/F2） | 无 |
| 状态细分（wait for input / ask question） | 帧型已契约（events.ts:33-35） | E-pending；「计数进列表」部分随 P3 |
| 标题/重命名 | 无现状机制 | P3+P4 |
| 最近活动/计数 | updatedAt 已有 | 计数随 P3 |
| band 分组 | — | P2 |
| 页面收纳/自定义 | client 本地偏好（web-cordis 候补 `ctx.storage` 预留，[design.md §B.2](../20260719-2339-web-cordis-design/design.md)） | 无 host 演进 |
| quick chat / 新建入口 | F2 | P5 |

### 簇 2 聚合视图（Tree / Topology / Board）

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| Tree 子视图 | 谱系+running（F1） | 计数/摘要/标题随 P3、P7 |
| Topology DAG | 谱系数据齐；mux 聚合流提供活动脉冲 | 规模承载随 P7（Topology 分叉列） |
| Board todo 看板 | `todo/write` 全量快照事件（core types.ts:246），live 可从 mux 折出 | 冷 session todo 投影随 P7→统计面；点卡片 fork 随 P7→E-fork boundary 参数 |
| 后台任务聚合 | `ctx.tasks` 现成 | task.list 升格随 P7（条件演进项表） |

### 簇 3 session 界面

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 发送/queue/steering | F3 | 无 |
| Fork session | core fork 已有 | E-fork |
| Goal / round 层级 | — | P21 |
| btw/side | core inject 已有 | E-inject |
| 思考展示/上滚不跟随 | F6；纯 client | 无 |
| plugin 自定义 tool 展示 | blueprint-v2 + cordis-spike 已实证类型隔离可行 | E-cordis-types 前置；路线随 P9 |
| 第一方三型卡 | render intent 词汇 core 一等（presentation.ts） | 路线随 P9 |
| code mode / cordis / workflows 展示 | 事件全在 log（E-consume 依据列） | E-consume |
| widget 卡 | — | P10 |
| step 行融合 | F6 | 无（纯 client） |
| edit & re-run | fork(boundary) 原语已有 | P11 |
| 右栏原始记录/JSON | F5 | 无 |
| feedback 标注 | — | P12 |
| 改设置 | F10 模板 | E-settings-w |
| Find in Finder | locate() 现成 | E-locate |
| compact 可视化 | 事件齐全（compact/types.ts） | E-consume（渲染支随待定拍板，机制无分叉） |
| context 注入可见 | context/steering 是 surface 事件 | E-consume |
| md 渲染/html 预览 | — | 纯 client 选型（旧定稿 [ui-tech 决策 17](../../ui-tech.md) 存档可查），无 host 演进 |

### 簇 4 甘特图 / trace / session log 视图

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 单 session 甘特/时序 | F4 | 无 |
| trace tri-view / 语义信号 | F4；sessionQuery 服务已有溯源结构 | 页面归属与信号载体随 P8；透出域见条件表 |
| 跨 session 索引页 | usage/错误逐条在 log | P8（真正拍板点） |
| session log 视图/过滤/右栏 | history 分页+透传（F5） | 无 |
| 全量回放 | history 翻到头 | 无 |
| 全局实时事件流 | mux 本身就是全局流；rpcLog 面板是现成调试面（[web-client RFC](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)） | ring buffer/过滤=纯 client；规模随 P7 同款承载题 |

### 簇 5 输入框

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 多行输入 | 已实现 | 无 |
| 图片输入 | 无（ContentBlockMap 四型） | P13 |
| slash 命令 | F7 | E-skill-ls；展开端随 P15 |
| bash 模式 | — | P14 |
| 改 model/thinking | E-models 依据列 | E-models + E-settings-w |
| 改 permission/sandbox | F10 | E-settings-w |

### 簇 6 plugin 视图

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 已安装列表 | F8 | E-plugin-ls |
| 安装/改 cordis.yml | Loader write-back 能力在 vendor；bootHost 无配置文件（P16 依据列） | P16 |
| Vibe a plugin | F9 | browser 半边热挂载随 P9 路线 b（blueprint-v2 §4 更新面） |
| Playground | fork/subagent 原语已有 | P19 |

### 簇 7 config 视图

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| 配置读面 | F11 | E-settings-r |
| 配置写面 | — | P16+P17 |
| （飞书图片缺失） | — | P20 |

### 簇 8 Onboarding

| 功能点 | 已覆盖 | 缺口 |
|---|---|---|
| choose model → api key | — | P18 |
| 勾选插件+配置 | — | P16（装配可配置是前提） |

---

## 第三部分：依赖关系（粗略）

```
无条件先行（全 A，不等任何 P）：
  E-pending ─ E-fork ─ E-inject ─ E-models ─ E-locate
  E-settings-r ─ E-settings-w ─ E-plugin-ls ─ E-skill-ls ─ E-consume（持续增量） ─ E-cordis-types

P 拍板后激活（按压的接缝聚类）：
  元数据 sidecar 面        ← P1手动/P3标题/P5/P12     ┐ 可合并为一个「log 外第二存储」RFC
  统计/索引面              ← P3计数/P7/P8跨session    ┘（同一存储归属题）
  web-cordis 落地（含 renderer slot） ← P9 路线 b/c（E-cordis-types 是其前置；蓝图+spike 已备）
  Loader 化装配+写通道      ← P16/P17表单/P18/P19（四者共同地基；影响面最大的 R）
  分支/重放 RFC            ← P11（依赖 E-fork 先落）
  多模态内容块              ← P13（独立重项）
  mux 订阅集/背压           ← P7 Topology / 全局流规模化
  直接执行通道              ← P14（安全边界先行）
  goal/round               ← P21（core 产品定义先行）
```

**跨 P 的一个共性观察**（事实陈述，非建议）：P1/P3/P5/P12 四个分叉的「重」选项都落在同一个新面上（session log 外的第二存储）；P16/P17/P18/P19 四个分叉的「重」选项都落在另一个面上（Loader 化装配+写通道）。拍板时这两组各自一起看，能一次定出两个最大 R 项的立项与否。

---

## 附：现状核实中的两个「反直觉」结论（防后续误判）

1. **多 client/quick chat 不是演进项**：mux fan-out、并发 prompt FIFO、审批 resolved 收敛面都已天然支持（[multiclient 报告](../20260720-0356-multiclient-research/report.md)实测），协议本来就是按多消费者设计的。唯一真实限制是浏览器每源 6 连接。
2. **单 session trace/甘特图不是演进项**：这是「model-visible⟺logged」+「事件带 seq/time/usage/callId」纪律的直接红利。需要长出来的只是跨 session 聚合（随 P8）和查询透出，不是新数据源。
