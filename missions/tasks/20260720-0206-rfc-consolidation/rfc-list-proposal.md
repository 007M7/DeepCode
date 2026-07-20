# GUI 设计成果 → 正式 RFC · 清单提案（v2，待用户拍板）

> 2026-07-20。命题：missions/tasks/ 下 GUI 归档是工作记录，不该长期存在；其中已实现的方案设计整理成多份正式 RFC 落 docs/rfc/ 体系。本文是写作前的清单提案——每份 RFC 的名字/归类/覆盖面/素材/篇幅/核实点，外加 web-styling.md 关系、归档去向、注释清扫审计、连带发现四个附带提案。**拍板前不动笔写正文。**
> v2（02:3x）：按用户追加范围补「五、注释清扫审计（翻译+减量）」，含各包存量盘点基数；终局口径同步（RFC 中英文提交后回刷历史 commit：消 missions 工作记录、RFC 插入配对、历史中文注释同批转英）。
> 体裁依据：docs/rfc/README.md（路径=lifecycle/class、Status 头、implemented 骨架 Problem/Decision/…/Alternatives considered/Consequences、Alternatives 强制、日期=首次提出日）。所有候选均过了「durable / contested / surprising」三判据自查。

## 一、RFC 清单（6 份：5 implemented + 1 proposed）

| # | 暂定文件名（docs/rfc/ 下路径） | 覆盖内容一句话 | 素材来源 | 篇幅档* |
|---|---|---|---|---|
| R1 | `implemented/architecture/2026-07-19-gui-host-client-apps-layering.md` | GUI 包拓扑：host/client 按「能力支持方」分层、混合体归 apps；apiproxy 前置层（契约+载体）/ hostruntime 后置装配层 / webserver 承载包三分；startHost 接缝与 RunningHost 四件套；两类消费边界（消费型 client 走 fetch 形 vs 协议桥前门挂 ctx）；目录组前缀命名规则（dsh-host-\*/dsh-client-\*） | 20260720-0101-hostruntime-split-design（design.md v2 ⓪–⑤/⑧/⑨ + README 裁决记录）、20260719-1843-step1-skeleton-design（五模块起源）、20260719-2036-step1-impl（验收事实） | 中长（~150 行） |
| R2 | `implemented/architecture/2026-07-19-four-quadrant-rpc-messaging.md` | 四象限 RPC 消息模型：通道（HTTP/SSE）与消息解耦、四具名判别 union、签名窄形 RpcRequest/RpcResponse、rpcId「谁发起谁 mint/应答回填」纪律、RpcReceipt 载体回执、RpcErrorDetailsMap 强类型错误、形态 B「函数签名即事实源」+ RpcMethodMap、zod 双向校验与 Wire\<T\> 锚定 | 20260719-1902-apiproxy-api-design（design.md v2.0 §0–§2/§4 + README 拍板表全记录）、20260719-2039-rpc-vs-jsonrpc（findings.md——Alternatives 的实证素材）、opencode-crosscheck.md | 长（~200 行） |
| R3 | `implemented/architecture/2026-07-19-apiproxy-contract-passthrough.md` | ApiProxy 契约面与会话语义：TS interface 权威 + fetch 载体同构（进程内注入=第二消费者）、core 结构零 DTO 透传、历史=事件重放+client 单 fold、消息边界分页、重连=重建 + subscribed.lastSeq 缝检测、冷 session 隐式 resume、审批/问答域形态（server-request/resolved 收敛/基线重放）、§8 预留接缝纪律（fail-loud 优于 not-implemented） | 20260719-1902-apiproxy-api-design（design.md §3/§5–§8 + core-coverage.md L1–L7 裁决）、20260719-2119-step2-impl（impl 落地事实） | 中（~120 行） |
| R4 | `implemented/architecture/2026-07-19-web-client-session-oop.md` | web 客户端架构：Session/SessionManager 对象层封装一切带 sessionId 的调用、实例常驻懒建、useSyncExternalStore 直连对象快照（不可变+微任务合批）、逻辑面/展示面分离（容器仅两层、展示组件纯 props）、store 无业务对象红线（zustand 只承载跨视图展示态）、fold 复用 core SurfaceManager（padding 窗口适配 seq 偏移）、intent 普通函数纪律、onEnvelope 咽喉 tap 与 RPC 调试面板 | 20260719-2247-step-session-design（design.md §A–§D + §F 妥协台账）、20260719-2140-ui-milestone1-design（store 红线/tap/ConnectionController/面板形态拍板） | 长（~180 行） |
| R5 | `implemented/process/2026-07-19-web-styling-baseline.md` | 样式体系的「为什么」：deepseekchat 为视觉基线的选择、token 两层不三层、字号/间距不 token 化、边框与 hover 用透明度制、CSS Modules+clsx 无组件库无 tailwind、暗色只在 token 表做（组件零主题选择器）、给 agent 读的编码规范形态（review 对照打勾清单） | 20260719-2315-style-research（style-research.md 调研证据 + upgrade-rpclog-v2.md 首个消费实证）、docs/web-styling.md（现行规则，见「二」分工提案） | 中（~100 行） |
| R6 | `proposed/architecture/2026-07-19-web-cordis-plugin-runtime.md` | 浏览器侧 Cordis 插件系统提案：cordis 内核零裁剪进浏览器的核查结论、web 服务清单（api/connection/sessionHub）、「对等=概念对齐+接口按端裁剪」口径与 `web/` 事件前缀（TS 单类型宇宙约束）、装配与配置 Q1–Q7 开放问题原样入 Proposal | 20260719-2339-web-cordis-design（design.md 全文） | 中长（~150 行） |

\* 篇幅档参照系：仓内 implemented RFC 典型 30–75 行，最重的 package-hierarchy 73 行——GUI 这批决策密度高于均值，中=100 上下、长=200 上下，写作时以「决策+放弃项」为限，实现细节留给包 README/JSDoc 不进 RFC。

### 归类与拆分理由

- **R2/R3 拆两份而非一份**：apiproxy design.md 一文承载两簇独立决策——wire 消息模型（R2，将来任何新载体/新端引用它）与契约面语义（R3，session 域消费者引用它）。合写会超 400 行且引用者各取一半；拆开各自 Alternatives 也不同（R2 对着三信封旧模型/JSON-RPC，R3 对着 DTO 层/物化快照/cursor 续传）。
- **R5 归 process 而非 architecture**：RFC 记的是编码规范与 review 政策（web-styling.md 这类「围绕代码的规范文档」的立法），同类先例 doc-tiers-and-budgets、package-model-experience 均在 process。若用户认为 token 表属 shipped source 结构决策，改 architecture 也成立——请拍板。
- **R6 进 proposed/ 而非 implemented/**：Q1–Q7 未拍板、零代码落地，属「设计完成未实现」，恰合 proposed 体裁（Proposal 可用将来时、开放问题合法）；将来拍板+实现后按 README 的 lifecycle 迁移规则改写为 Decision。
- **RPC 调试面板不独立成 RFC**：面板本体是开发观测工具，durable 的决策是「载体层 onEnvelope 咽喉 tap、契约签名零污染」——归 R4 一节（tap 的协议侧半句话在 R2 提及即可）。
- **playwright 自动验收不立 RFC**：GUI 免门禁期的临时工作纪律，未 settle（README 明言 provisional 决策不进 RFC）；门禁回收轮若升为测试策略再立 testing RFC。
- **「dsc web GUI 前门」feature RFC 暂不立**：对照 TUI 前门 RFC（2026-07-17）本应有一份，但 GUI 功能面仍在里程碑推进中（respond 交互、样式打磨未收）；架构决策已由 R1–R4 承载，功能收尾轮再补一份短 feature RFC 作总览入口。
- **日期规则**：文件名日期=题目首次提出日（R1 的分层题起于 07-19 step1，07-20 只是宪法定稿；R2–R6 均 07-19）。slug 互异，无冲突。

### 每份 RFC 的「以当前代码为准」核实点（写作前必查，CLAUDE.md「Validate RFC premises against current code」）

| # | 核实点 |
|---|---|
| R1 | ①packages/host/{apiproxy,runtime,webserver} 与 apps/dsc/src/{bin,web,headless}.ts 现状文件树；②七包名 dsh-host-\*/dsh-client-\*/dsc\*（已初核一致）；③startHost/RunningHost 真签名（packages/host/runtime/src/start.ts）；④webserver 零 workspace 依赖是否仍真 |
| R2 | ①rpc.ts 四具名 union+RpcReceipt+四错误码（已初核一致）；②rpc-map 6 key（已初核一致）；③fetch/client.ts 有未 commit 改动（git status M）——以写作时真码为准；④Wire\<T\> 锚定注释真身（api/rpc.schema.ts） |
| R3 | ①**respond 仍是 stub**（runtime/src/api-proxy.ts:257 已核）——审批/问答域须如实写进 Deferred 节（契约类型+帧已 shipped，host 侧 pending 表/wire answerer 未实现），不得写成已落地；②history 分页真实现（消息边界/尾页 partial）；③`since`/fork/inject/task/listModels 预留是否仍未进 map |
| R4 | ①web-runtime/src/session/ 七文件与 hooks 两文件（已初核在）；②store.ts 是否仍零业务切片；③SurfaceManager 走 dsh-session `./src/*` 子路径 import 是否仍真；④fold 降级位 foldDegraded、padding 哨兵实现与设计一致性 |
| R5 | ①web-styling.md §1 token 表 vs global.css 实值一致性；②RpcLog v2.1 是否已按规范改造（commit 8372a94b0 称已 styled）；③「PostCSS 零插件」现状 |
| R6 | ①vendor/ 各包浏览器可用性结论按当前 vendor 源码复核（vendor 有 sync 可能）；②step-session/apiproxy 引用锚点更新到落地后真码；③Q1–Q7 在提案期是否已有部分被用户顺手拍掉（查主会话/README 记录） |

## 二、R5 与 docs/web-styling.md 的关系提案

**推荐：分工不合并。**RFC 记「为什么这么定」（基线选择、两层 token、不 token 化字号间距、透明度制、放弃 tailwind/组件库/三层 token 的理由），web-styling.md 继续当活规范（当前规则表、token 权威值、review 打勾清单、偏离记录），两边互链。理由：①RFC 家规「决策不可就地改写，推翻须新 RFC」，而样式规则会持续演进——合并会让每次调 token 都变成「改 RFC」的语义困境；②仓内已有同构先例（doc 标准 RFC ↔ docs/AGENTS.md 活规则）。连带动作：web-styling.md 头部「架构稿拍板」等指向补 RFC 链接；其 §6 对 missions 归档的引用改指 RFC（见「三」断链问题）。

## 三、missions/tasks 归档去向（RFC 落地后）

| 选项 | 内容 | 代价/风险 |
|---|---|---|
| A（推荐） | **整目录删除，git 历史即档案**。RFC 写作时把仍有长期价值的证据（拍板表精华、jsonrpc 对比结论、style-research 取值证据）吸收进各 RFC 的 Alternatives/bespoke 节后删 | 需先解决两处仓内引用：docs/web-styling.md §6 与头部引用了 `../missions/tasks/20260719-2315-style-research/...` 等路径，删除即断链（markdown link lint 会拦）——改指 RFC；后续想查过程细节要翻 git log |
| B | 压缩成一份历史索引（一行一档：日期/命题/结论落点→RFC 链接），删正文 | 索引本身又是一份要维护的文档；与 INDEX.md/git log 职责重叠 |
| C | 原样保留到 GUI 门禁回收轮一起清 | 与命题「工作记录不该长期存在」相悖；归档里的旧包名/旧结论会继续误导读者 |

推荐 A，且删除动作放在**全部 RFC 过 review 合入之后**单独一批（删前 grep 全仓引用清零）。20260720-0206（本目录）随批自删。

**终局口径（team-lead 传达，用户已预告）**：RFC 中英文提交后**回刷历史 commit**——消掉不该提交的 missions 工作记录、把 RFC 插入历史 commit 配对、GUI 系列 commit 触碰文件的中文注释同批转英（见「五」）。上表 A/B/C 只决定「回刷前的工作树形态」；回刷执行细则（rebase 脚本、commit 映射表）等 RFC 确认时另出方案。

## 四、注释清扫审计（翻译+减量，用户追加范围）

**双动作**：①中文注释转英文（gui-code-comments-english 纪律的存量清偿，也是回刷历史时逐 commit 修正的输入）；②**同步减量**——用户明确嫌当前注释密度偏高：保留「非显然契约/约束/防坑」类（Node close 语义、exactOptionalPropertyTypes 与 zod 不兼容、padding 哨兵为何安全这种必须留），删掉叙述性/复述代码/记录设计过程的注释。两动作一次过，不分两遍。

**存量盘点（2026-07-20 02:3x，grep 汉字实测，分母=src 下 ts/tsx 文件数）**：

| 包 | 含中文注释文件 | 备注 |
|---|---|---|
| packages/host/apiproxy | **16/17** | 重灾区：api/ 契约层 14 文件+fetch/ 全在（W1/W2 期中文直写） |
| packages/client/web-ui | **14/25** | 组件层约一半（RPC 面板与 conversation 组件族） |
| packages/client/web-runtime | 4/15 | session-design 已翻过它 touch 的部分，余 4 文件 |
| packages/host/runtime | 0/4 | 迁入时已英文化（hostruntime 拆包批注明「注释英文化」） |
| packages/host/webserver | 0/2 | 已英文 |
| apps/dsc、apps/web | 0/4 | 已英文 |
| scripts/verify-session\*.mjs、verify-rpclog-panel.mjs | 3 文件含中文 | GUI 验收脚本；回刷时若保留进历史则同批转英，若按「脚本按归档价值分流」纪律删除则免翻 |

合计约 **34 个源文件**待翻译+减量（translation-prompt\*.ts 的中文是 i18n 工具的数据不是注释，排除）。执行建议：**不做成独立 RFC**（工作项不是决策），做成回刷准备阶段的一个批处理工单——按包分批（apiproxy → web-ui → web-runtime 余量 → scripts），每批「翻译+减量」一次过、typecheck 绿即收，产出「文件→commit 首次引入」映射供回刷对号。减量的判据直接引用仓规（CLAUDE.md「Comments preserve complete contracts and non-obvious orientation, not reasoning transcripts」），不另立标准。

## 五、连带发现（不在命题内，但拍板时最好一并定）

1. **docs/ui-product.md 与 docs/ui-tech.md 是 2026-07-18 旧定稿，已部分失效**：ui-tech 头部仍称「wire 字段级权威 = docs/ui-design/01-protocol.md」——该目录已删；其协议节被四象限 v2.0 取代；§8「root Context 只 4 服务」已被 web-cordis 设计半推翻。提案：RFC 落地同批**重写或废弃**这两份（产品口径仍有效的部分下沉进 R1/R4 的 Problem/Consequences 或独立瘦身为一份短产品文档），不让与 RFC 矛盾的「定稿」并存。
2. **RFC 语言与 .zh.md 配对**：仓内 RFC 英文正文+可选 .zh.md 配对（现存 19 份 zh）。GUI 这批素材全中文，写英文正文成本不低。请拍板：英文正文（合仓库惯例，i18n 配对随后）/ 先中文后译 / 只英文不配 zh。清单阶段不预设。
3. **门禁适用性**：正式 RFC 进 docs/rfc/ 即受 doc-sync 全家（rfc-format/classification/INDEX 再生成/链接 lint/词数预算）约束——写作阶段要跑 `pnpm run doc-sync`，这批是 GUI 期第一次回到门禁内的产出，工期估算按此放量。
