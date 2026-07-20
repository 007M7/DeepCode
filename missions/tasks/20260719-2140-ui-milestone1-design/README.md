# UI 首里程碑设计（布局分区 + RPC 调试面板）——实现级设计文档

任务：写 web-runtime 数据层（§A）+ web-ui 组件层（§B）+ 对齐纪律（§C）的实现级设计，读者=无上下文编码 teammate；只写文档不写代码。契约基线 = apiproxy design.md v1.5（冻结，只消费不改）。

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 21:46 | 建档（上一轮 API 超时，内容重来；四份必读上下文已读完） |
| 2026-07-19 21:52 | design.md 首批落盘：§A.0 模块布局/导入纪律、§A.1 store 全切片 TS 类型、§A.2 rpcLog tap+环形 buffer（含 onEnvelope 形状=W3 接缝） |
| 2026-07-19 21:58 | 第二批落盘：§A.3 ConnectionController（退避参数写死/先流后 unary/generation fencing/重连=重建）、§A.4 intents 11 函数全表、§A.5 fixture 两件套、§A.6 boot+apps/web 接线（?fixture 开关）。§A 完 |
| 2026-07-19 22:04 | 第三批落盘：§B.0 文件全清单+包配置增量、§B.1 useWeb 订阅 hook+纪律、§B.2 布局骨架（App 网格/Sidebar 三段/MainArea 三分支占位） |
| 2026-07-19 22:11 | 第四批落盘：§B.3 调试面板完整交互规格、§B.4 selector 订阅表（逐组件 re-render 边界）、§B.5 CSS 变量表（亮色实值+暗色占位）、§C 对齐纪律六条、§D 验收清单九条、拍板对照索引。v1 完稿（与收窄拍板交叉，随即回改） |
| 2026-07-19 22:0x | 收到三条变更（team-lead 转达用户拍板）：①契约严格双向 RPC（签名收 RpcRequest 封装/帧=server request/respond 回填 rpcId），契约名以 apiproxy-design 修订稿为准；②store 瘦身——不存业务对象，只剩 rpcLog+面板 view 态，sessions/connection 走 OOP 演进；③范围收窄——本里程碑只做 RPC 面板，左导航/Settings/主题全部降级下一里程碑 |
| 2026-07-19 22:2x | v2 回改完稿：§A.1 两切片+OOP 演进节、§A.3 状态不进 store、§A.4 收缩至 rpcLog 三件+pingHost（boot 自动一次+面板 dev 按钮）、§A.2 契约类型弱引用化、§B 砍到 App 壳+面板（新增同 rpcId 配对高亮）、§B.5 只落 :root 亮色、§C 七条（新增 store 无业务对象红线）、§D 面板口径八条、新增 §E 降级素材四节。v2 完稿 |
| 2026-07-19 22:3x | 用户点名修订（v2.1）：rpcLog 对齐契约四具名 union——ApiEnvelopeTapEvent/RpcLogEntry 三支改四支（client-request/server-response/server-request/client-response，frame 词从分类退役、stream 挪入 server-request 支）；行方向符四种（→/←/⇐/⇒）；配对高亮升级为按族两组（client-request↔server-response、server-request↔client-response）；tap 时机表补 client-response；注记 v1 仅 respond 产生 client-response、实现留支不填 |
| 2026-07-19 22:4x | 目录组织拍板（随 v2.1 一批）：①面板归位 panel 概念——`components/panels/RpcLog/`，命名全链统一（DebugPanel→RpcLog、PanelBadge/Body→RpcLogBadge/Body、debugPanelOpen→rpcLogOpen、intents open/close/toggleRpcLog），panels/ 为可扩展位（将来 Settings/诊断各占子目录）；②纯函数工具归 utils/——`web-ui/src/utils/formatRelative.ts`，归属 web-ui 理由=唯一消费方是渲染层（消费方就近，两包各自建 utils/ 不共享工具包）。**v2.1 完稿** |
| 2026-07-19 22:5x | 用户批准设计稿，转入编码（任务 #6，fixture 驱动）。web-runtime 7 文件（api-types 契约临时副本/store/rpc-log/intents/connection/fixture/boot+index）tsc 绿；web-ui 12 文件（use-web/utils/global.css/App 壳/panels/RpcLog 五件套+css）tsc 绿（tsconfig 去 composite 走 paths 源码解析）；apps/web main.ts 接线 ?fixture。vite build 绿；dsc web 3080 起服 curl 200；node 冒烟全链路过（boot 3 条台账三象限 kind/开面板清 unread/ping 造一对 describe/清空/暂停全对） |
| 2026-07-19 23:0x | 用户指令改真浏览器验收：装 playwright（chromium 走代理下载 114MB）+ 写 scripts/verify-rpclog-panel.mjs；重启 3080（EADDRINUSE 是旧进程活着、setsid 脱管重起）；首跑 §D-5 暴露脚本前置缺陷（行数不溢出滚不动，补连点 ping 造行）后 **ALL PASS 10/10**（表见上节） |

## playwright 自动验收（scripts/verify-rpclog-panel.mjs）

跑法：dsc web 起在 3080 + dist 最新 build 后 `node scripts/verify-rpclog-panel.mjs`（chromium headless 走 ~/.cache/ms-playwright；不进门禁体系）。改面板代码后重跑此脚本代替人工点验。

2026-07-19 23:0x 首跑结果：**ALL PASS（10/10）**——§D-1 角标+未读、§D-2 三象限方向符+未读清零、§D-3 ping 造对+§D-3b 两族配对高亮、§D-4 JSON 展开收起、§D-5 上滚暂停+继续贴底（脚本先连点 ping 造 ≥30 行溢出，否则列表不滚)、§D-6 清空+周期帧续入。顺带覆盖 team-lead 的 bin.ts mime 修复（页面能载入即 content-type 正确）。

## 接缝问题（契约 v1.5 缺口，只报告不擅改）

1. **`host.describe` 无 host 实例标识**（bootId/instanceId 类字段缺失）：client 无法区分「网络闪断（host 未换）」与「host 重启过」。v1 影响为零——「重连=重建」一刀切让两种情况行为一致；但将来做客户端缓存、mux `since` 续传或乐观 UI 时必须能辨识实例，届时 describe 需 additive 加一个实例标识字段。
2. **`onEnvelope` tap 属载体层选项，契约未列**：设计把它定在 `fetch/client.ts` 的 `CreateApiClientOptions`（见 design.md §A.2，含 tap 事件三形状）。这符合 v1.5「开关是实现细节不进签名」的既有口径，不算契约变更，但 W3 实装需按 §A.2 形状对齐——请 dispatcher 把该小节转发给 W3 作接缝规格。
