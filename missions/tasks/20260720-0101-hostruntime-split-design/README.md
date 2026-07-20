# hostruntime 拆包 + dsc 双命令设计

命题（用户定）：apps/dsc 现在 bin.ts 一个文件耦合 bootHost+createApiProxy+toFetchHandler+静态服务；将来要接 Electron 与 headless cli。**Electron 本身不做，只拆出包与接口层**（将来零重构接入）。

已定方向（team-lead 传达）：
1. cli 双能力：`dsc web`（起 HTTP）与 `dsc -p "task"`（apiproxy 进程内同构注入，不起 HTTP，ApiProxy 接口直调——协议第二个真实消费者），跑完打印结果退出。
2. 新建 hostruntime 包：bootHost + createApiProxy 装配 + `startHost()` 启动接缝（返回 api/handler/defaults/dispose，套 HTTP/套 IPC/进程内直用由壳决定）；dsh-apiproxy 退化为纯契约+载体（api/ + fetch/）。
3. apps/dsc 瘦身为命令行入口：parseArgs 子命令分发 + web 时起 node:http + 信号停机。

产出：`design.md`（实现级）。负责人：step1-design（常驻）。

**属地警示**：impl/ 迁出动 packages/host/apiproxy 现码，与 apiproxy-design 的文件属地有交集——设计完成先交 team-lead，由其协调 apiproxy-design review 契约侧影响后才动码。

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-20 01:01 | 任务下达；现状核实完成（bin.ts 122 行现码 / apiproxy 三层结构 api+fetch+impl / cli-demo runOneShot 的 turn 相关性判定先例 / web-runtime 只吃 /api /client 子路径）；建本目录 |
| 2026-07-20 01:14 | design.md v1 全稿落盘（⓪已锁结论/①包拆分+依赖图/②startHost=RunningHost 四件套/③迁移属地清单+deps 收缩/④bin 四文件/⑤-p 动线+consumeUntilTurnEnd/⑥迁移六步/⑦Electron 接缝表/⑧妥协台账六条三段式/⑨验收六条/⑩属地交接）。**待 team-lead 转 apiproxy-design review §③，通过前不动码** |
| 2026-07-20 01:20 | 用户五问裁决（Q1–Q5）+分层补钉（host/client 按能力支持方，混合归 apps）+Electron 载体澄清（HTML file://、fetch 走 IPC 桥、webserver 不复用）+acp 前瞻（ctx 升格正式接缝）到达，design.md 整体重写为 **v2 全稿**：⓪总纲六条宪法/①依赖图（webserver 零依赖收 handler 注入）/②startHost（ctx=前门挂载点+stdout 纪律）/③apiproxy 摘除/④webserver 包/⑤dsc 三文件/⑥-p 动线/⑦迁移六步/⑧Electron(IPC 桥)+acp 接缝/⑨台账七条/⑩验收八条/⑪属地交接/v1→v2 变更记录。待 review |
| 2026-07-20 01:24 | review 已过（apiproxy-design 四结论适用 v2）；team-lead 授权动码（直写）+两约束（错峰 session-design/package.json 单独批）。核实：apiproxy 无未收编改动（W2 批2 已 commit 8d7f77ac0，api-proxy.ts 为最新版含 history/prompt/cancel 真实现——stub 坑不存在）；web-runtime 有 session-design 未 commit 改动，未触碰 |
| 2026-07-20 01:45 | **迁移完成，验收全过**。批1 hostruntime 六文件（api-proxy.ts 取 8d7f77ac0 最新版、注释英文化、import 改包路径）；批2 apiproxy 摘除（git rm impl/、index 退化、exports 补 "./api/*"、deps 16→6、tsconfig 收缩）；批3 webserver 四文件（SSE abort 的 res.on('close')+writableEnded 语义随最新 bin.ts 平移）；批4 apps/dsc 三文件+manifest。tsc -b apps/dsc 全绿。验收：web 回归（打印行/GET 200/js mime/403 编码变体/SPA 200/api 桥 session.list ok/SSE 开流/SIGTERM 0/SIGINT 130/EADDRINUSE 报错退 1）+ `dsc -p` 真流 `SPLIT-OK` 退 0（期间无新端口监听）+ usage 退 1 + session jsonl 持久化 + impl/ 引用清零。**注**：验收期发现一常驻旧 web 进程占 3080（pid 2347367，拆包前旧码起的），未杀——待 team-lead 确认是否谁的在用 |
| 2026-07-20 01:55 | **改名落地 + live server 拉起**。用户定命名规则：host/client 目录下包名必含目录前缀（写进 design.md ⓪ 总纲）。执行：目录 hostruntime→runtime、包名 dsh-host-runtime / dsh-host-webserver；tsconfig.base.json 通配确认**命不中**（通配按「包名尾段=目录名」解析，host-runtime≠runtime），加两条显式 paths；全部 import/deps/references 改毕，清 stale lib/，install+tsc -b 绿。杀掉中间态旧 server（2347364/2347367/2365234，team-lead 证实是它误重启的），nohup 拉起新码 live server：GET / 200、/api/session.list ok。**12s 请求计数断言过**（playwright 首页 12s 仅 4 个 /api 请求：mux/host/describe/list ≤10，session-design 连接风暴修复同场验证）。存量包名改名台账已按用户口径记（必改/冻结窗口/用户择机） |
| 2026-07-20 02:05 | 改名与 session-design 的全仓统一改名并发撞车后收敛：它把存量三包也一并改了（dsh-host-apiproxy/dsh-client-web-runtime/dsh-client-web-ui，tsconfig.base.json 显式条目也是它加的），我删掉自己重复加的两条 paths 条目、共同收敛到其条目集。最终七包名全审计一致，老名引用全仓清零，install+tsc -b 绿。live server 重拉至 pid 2393780（02:01 起，改名后代码）：GET / 200、session.list ok、SSE 通、**12s 断言复验过（仍 4 请求）**。浏览器侧用户已可验证（列表已见新建 session） |
