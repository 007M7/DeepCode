# GUI 设计成果整理为正式 RFC

命题（用户 2026-07-20 02:0x）：missions/tasks/ 的 GUI 归档是工作记录不该长期存在；已实现的方案设计整理成多份正式 RFC 落 docs/rfc/ 体系（包拆分、代码分层、通信协议、React 架构、样式规范等）。负责人：rfc-consolidation（常驻 dispatcher）。

流程：①清单提案 → 用户拍板 → ②分份写作（每份写前按核实点对当前代码验premise）→ ③归档去向执行。当前在 ①→② 之间等拍板。

## 文件索引

| 文件 | 内容 |
|---|---|
| `rfc-list-proposal.md` | 清单提案 v2（历史：六篇方案，已被四篇拍板取代——归档去向/注释清扫/连带发现三节仍有效） |
| `outline.md` | **四篇大纲**（用户拍板后重构）：第一篇分层架构（不含包/apps 关系枚举）/ 第二篇 RPC 协议（R2+R3 合并：四象限+类型 zod+fetch 双向抽象+HTTP/SSE 落地）/ 第三篇 Web 客户端架构 / 第四篇样式体系（RFC+web-styling.md 校准）；每篇章节骨架+包含/不包含表+写前核实点；web-cordis 豁免；体裁冲突点（rfc-format 门禁强制 Alternatives 节 vs「不写取舍」）给 a/b 两案推荐 a |

RFC 正稿**直接住 docs/rfc/**（用户令：missions 是要回刷消掉的工作记录，正式产物不进来）。中文稿占 `.zh.md` 配对名（i18n 惯例：英文主稿+.zh 配对，development.zh.md 先例），review 通过后英文主稿落同目录：

| 篇 | 正式路径（中文稿已就位） |
|---|---|
| 一·分层 | `docs/rfc/implemented/architecture/2026-07-19-gui-host-client-layering.zh.md` |
| 二·RPC 协议 | `docs/rfc/implemented/architecture/2026-07-19-gui-rpc-protocol.zh.md` |
| 三·Web 客户端 | `docs/rfc/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md` |
| 四·样式 | `docs/rfc/implemented/process/2026-07-19-web-styling-system.zh.md` |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-20 02:06 | 任务下达；通读 docs/rfc/README.md+INDEX.md+样例 RFC（package-hierarchy 等）学体裁；通读六份 design.md 定稿 + 三份 impl README + style-research + web-styling.md；初核代码锚点（七包名/rpc-map 6 key/四错误码/respond stub/session 七文件） |
| 2026-07-20 02:2x | `rfc-list-proposal.md` v1 落盘（6 份清单+理由+核实点+三附带提案）；发回 main 等拍板 |
| 2026-07-20 02:3x | 用户追加两条范围（team-lead 转达）：①注释清扫审计进清单（回刷历史 commit 时中文注释同批转英）；②注释密度收敛（翻译+减量双动作，留契约/防坑删叙述复述）。grep 实测存量：apiproxy 16/17、web-ui 14/25、web-runtime 4/15、host/runtime·webserver·apps 0、验收脚本 3——合计约 34 源文件。提案升 v2（新增「四、注释清扫审计」节+终局回刷口径），继续等拍板 |
| 2026-07-20 02:4x | 用户拍板：**四篇重构**（R2+R3 合并为 RPC 协议篇；第一篇聚焦分层概念不枚举包/apps 关系；第四篇=RFC+web-styling.md 校准；web-cordis 豁免不做 RFC 留原路径）；体裁改向：读者=项目开发者、讲「怎么设计的+怎么在上面开发」、不写取舍演变、表格 list 操作性优先。`outline.md` 落盘（四篇骨架+包含/不包含+核实点+体裁冲突 a/b 案），发 team-lead 转用户过目 |
| 2026-07-20 02:5x | 用户细化第三篇范围：主体=①React-free 数据对象层（Session/SessionManager/Connection：状态机/帧路由/fold 累积器/subscribe-getSnapshot 契约）+②hooks 纯数据层（uSES 接线/防撕裂/「数据+操作」形状）；**组件层降权为耗材**（「组件肯定要重做」——分离原则讲、具体组件 props 契约不进规范）。outline.md 第三篇按比重（对象层 50%/hooks 25%/连接 fold 20%/红线收尾 5%）重写 |
| 2026-07-20 03:0x | 写作开闸（先中后译；体裁 a 案「取舍稍写不长篇」；T3 契约补记并入）。对 HEAD 893421d50 重核连接层：createApiClient 已废、AbstractApiClient 类体系（IApiClient caller 视图/doFetch+onEnvelope 两切面/subscribeEnvelopes 实例级批量订阅/InProcessApiClient·WebApiClient·FixtureApiClient 三子类/泵反转 rpcLog 降纯订阅者）。**第二篇中文稿完稿** `drafts/rfc2-rpc-protocol.zh.md`（四象限/类型体系/契约面+帧表/AbstractApiClient 载体/Web 落地/扩展清单/Alternatives 短表；respond stub 如实标注）。**T3 完成**：apiproxy design.md 新增 §4.1 client 载体类体系+§5 图更新，README 拍板表补一行（注明 rfc-consolidation 代笔） |
| 2026-07-20 03:2x | **四篇中文稿全部完稿**（drafts/ 下）：`rfc1-layering.zh.md`（分层角色表/两类消费/startHost 纪律/命名规则/接入新形态清单；核实 start.ts 真签名与三包 deps）；`rfc3-web-client.zh.md`（对象层主体：Session 三组方法面+帧分发表+缝合规则+快照契约+Notifier；fold/累积器；hooks uSES 四条合同+模板；组件层只立分离原则；核实 session/ 真码——含 pendingBuffers 缓冲重放、`dsh-session/surface` 子路径出口等落地演进）；`rfc4-styling.zh.md`（框架五条/工程约束/与 web-styling.md 分工表；抽查 global.css 亮暗 token 与规范一致）。全部发 team-lead 转用户 review |
| 2026-07-20 03:3x | 用户令 RFC 直接落 docs/rfc/：四篇从 drafts/ 迁至正式路径（上表），drafts/ 目录清除；命名按 i18n 惯例中文稿占 `.zh.md` 配对名、英文主稿 review 后落同目录（免二次改名）；四篇头部草稿注记同步改写 |
| 2026-07-20 03:4x | 文档一致性小修（web-dev-2 发现，team-lead 转）：apiproxy design.md §3.3 帧 id 字段名对齐代码（id→approvalId；question requested 删 id、resolved→questionRpcId）+ createApiClient 残留清净（§1 布局/依赖图/map 节/§3.4/§5 超时注记→AbstractApiClient 类体系词汇）；hostruntime split design.md 七处同步（§⑥ 代码块改 InProcessApiClient、Electron 表改 IPC 子类）。两文档仅留两处有意历史注记（「取代 createApiClient」「迁移当时为」） |
