# step1 骨架实现（GUI）

任务：照 `../20260719-1843-step1-skeleton-design/design.md`（v2 实现级规格）编码实现五模块骨架，跑通⑥验收清单 12 条。dispatcher：step1-design（升任）。

## 分工

| worker | 范围（design.md 节） | 依赖 |
|---|---|---|
| W-host | ②根配置四处编辑 + packages/host/apiproxy（③-3/④-3/⑤-1） + apps/dsc（③-1/④-1/⑤-5） | 无 |
| W-web | packages/client/web-runtime（③-4/④-4/⑤-2） + web-ui（③-5/④-5/⑤-3） + apps/web（③-2/④-2/⑤-4 三件套） | pnpm install 需等 W-host 根配置落盘 |
| 验收 | ⑥12 条逐条执行记录 | 两 worker 完成后 |

纪律：照 v2 精确实现，文档有误/歧义先报 dispatcher 不自行改设计；小步落盘+回执；干完不 kill 保持存活修 bug；不遵循仓库门禁；禁读 worktree-webpreview。

## 已知风险

- ~~本 worktree 根无 `.env`、环境无 `DEEPSEEK_API_KEY`~~ 已解（20:47）：team-lead 拍板先用假 key 走通全部验收。核实成立——llm-deepseek `apply()` 只查 key 非空后纯构造注册 adapter、零网络（src/index.ts:81-96）。根 .env 已放 `DEEPSEEK_API_KEY=dummy-step1-acceptance`（.gitignore 内）。验收按「假 key，真模型对话未验」口径记；真 key 到位后补一条真对话冒烟。

## 验收结果（2026-07-19 21:10 假 key 初验 12 条全过；21:2x 真 key 到位后复验+冒烟，见表尾三行）

| # | 条目 | 结果 | 实际输出 |
|---|---|---|---|
| 1 | pnpm install | ✅ | 36.7s 完成；五包软链就位（分包 node_modules 下，根无顶层链属 pnpm 正常布局） |
| 2 | vite build | ✅ | `dist/index.html` 0.32kB + `dist/assets/index-BxPPnDLQ.js` 143.83kB（修 §③-2 deps 后） |
| 3 | demo:web 起服务 | ✅ | stdout `dsc web: http://127.0.0.1:3080` |
| 4 | GET / | ✅ | index.html 全文含 `<div id="root">` |
| 5 | GET /assets/*.js | ✅ | 200 + `content-type: text/javascript; charset=utf-8` |
| 6 | 未知路由 | ✅ | 200 + index.html（SPA 回退） |
| 7 | 路径穿越 | ✅* | 编码变体 `/%2e%2e%2fpackage.json` → 403；裸 `/../` 被 server 侧 `new URL()` 先折叠、安全落为 SPA 回退 200 无泄漏（验收命令已 v2.1 修正为编码变体） |
| 8 | 浏览器访问 | ✅（代验） | dispatcher 无浏览器；以容器 IP `http://10.213.93.123:3080/` curl 200 代验网络可达；页面渲染待用户开浏览器抽查 |
| 9 | SIGINT | ✅ | 直接 node 起进程 kill -INT → 退出码 130 |
| 10 | SIGTERM | ✅ | 退出码 0 |
| 11 | 缺 key | ✅ | 退出码 1 + stderr `llm-deepseek: an API key is required (Config.apiKey or $DEEPSEEK_API_KEY)` |
| 12 | 缺 dist | ✅ | 退出码 1 + stderr `dsc web: 前端 dist 未构建，先跑 pnpm --filter @deepseek-ai/dsc-web build` |

加验：验收 3–10 全程 `.sessions/` 未出现（bootHost 无 agent 副作用，符合设计）。

真 key 复验（21:2x，用户填入 .env：DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL 代理端点）：

| 条目 | 结果 | 实际输出 |
|---|---|---|
| 杀假 key 旧进程、真 key 重起 demo:web | ✅ | 打印行照常、GET / 200、SIGTERM 退出 0、`.sessions/` 未出现 |
| bootHost 真 key boot 链 | ✅ | 无 fail-loud，装载全过 |
| 真流冒烟（临时脚本 bootHost→`ctx.llm.stream` deepseek-v4-flash 最小对话，不动产品代码，用后即删） | ✅ | `finish=stop chunks=51 text="SMOKE-OK"`，key 真实有效 |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 20:36 | 用户拍板文档定稿开工；step1-design 升任 dispatcher，建本归档目录 |
| 2026-07-19 20:39 | 并发派出 W-host / W-web（平台限制 teammate 不能再生 teammate，两 worker 为后台 subagent，「干完保活修 bug」降级为「完事出报告、返工另派」；install/build/验收改由 dispatcher 在两者完成后亲自跑，天然满足时序依赖）。核实本 worktree 无 .env 且环境无 DEEPSEEK_API_KEY，已报 team-lead 待解（不阻塞编码与 build，阻塞验收 3–11 条） |
| 2026-07-19 20:42 | W-web 完成：11 文件落盘（web-runtime 3 / web-ui 3 / apps/web 5，index.html 在包根），零 BLOCKER，未越界。等 W-host |
| 2026-07-19 20:47 | team-lead 拍板假 key 方案；dispatcher 核实 llm-deepseek load 期零网络成立，根 .env 放入 dummy key |
| 2026-07-19 20:52 | W-host 完成：根配置四处 + apiproxy 3 文件 + apps/dsc 3 文件（bin.ts 3303B 边界结论逐条落实），照抄前核实 13 个 references/loadEnv 签名/插件导出形状均与文档一致，零 BLOCKER。里程碑②达成，dispatcher 开跑 install→build→验收 |
| 2026-07-19 21:02 | install 过（36.7s）；vite build 两连挂，均为 apps/web deps 缺项（设计缺陷非 worker 错）：①缺 dsh-web-runtime（main.ts 直接 import，严格 node_modules 不可解析）②缺 react/react-dom（plugin-react 强制 dedupe:['react','react-dom']，从项目根解析而非 importer，probe 插件实测 resolve NULL）。修 apps/web/package.json 补三依赖 + design.md §③-2 v2.1 修正。重跑 build 过：dist/index.html 0.32kB + assets/index-BxPPnDLQ.js 143.83kB。里程碑③达成 |
| 2026-07-19 21:10 | dispatcher 亲跑⑥验收 12 条全过（结果表见上）。发现并修正验收 #7 命令缺陷：裸 `/../` 会被 server 侧 URL 解析先折叠、测不到 403，改用编码变体 `%2e%2e%2f`（实测 403）；裸变体安全落为 SPA 回退无泄漏。里程碑④达成，报 team-lead |
| 2026-07-19 21:26 | 真 key 到位（.env 含 DEEPSEEK_API_KEY+DEEPSEEK_BASE_URL）。杀假 key 旧进程→真 key 重起复验（打印行/静态页/SIGTERM 0）→临时脚本冒烟 `ctx.llm.stream` 拉真流：`SMOKE-OK` 51 chunks finish=stop。**step1 验收全量收口，关账** |
