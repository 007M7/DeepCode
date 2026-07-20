# step1 骨架设计（GUI）

任务：为 DeepSeek Harness GUI「step1 骨架」写中文设计文档，说清动线（boot / 构建 / 请求 / 停机）与五模块的 API 暴露面。设计文档任务，不写实现代码。

## 已拍板约束（2026-07-19，用户定）

- 五模块：`apps/dsc`（bin 入口，node:http 内联静态服务）、`packages/host/apiproxy`（程序化组合 harness core，agents: []）、`packages/client/web-runtime`（浏览器启动层，无 React）、`packages/client/web-ui`（React 层）、`apps/web`（vite build 主入口，产 dist）。
- apps/dsc 通过 workspace 依赖 apps/web 从包内解析 dist；不要 --static-dir。
- 监听 0.0.0.0，打印 http://127.0.0.1:<port>；`--port` 用 node util.parseArgs。
- API key 从根 .env 读；`dsc web` 零参数即起。
- step1 不做：连接协议、/health、session 通信、vite dev server 代理、精细 drain。停机：SIGINT → 关 HTTP → dispose cordis root。
- 前端依赖版本参考 deepseekchat（deepsuite-frontend）基线。
- 不遵循仓库门禁（coverage/doc-sync/JSDoc 等）。
- 禁读 worktree-webpreview 旧 GUI 资产。

## 文件索引

| 文件 | 内容 |
|---|---|
| `deepseekchat-baseline.md` | worker 产出：deepsuite-frontend 前端工程版本基线 |
| `harness-boot-facts.md` | worker 产出：harness 程序化 boot 接线事实（带 file:line） |
| `design.md` | 最终设计文档 |

## 进展

| 时间 | 事项 |
|---|---|
| 2026-07-19 18:43 | 任务下达（team-lead → dispatcher） |
| 2026-07-19 18:47 | 建归档目录；派出两个 background worker（deepseekchat 基线 / harness 接线） |
| 2026-07-19 18:52 | dispatcher 自查 root 工程事实：workspaces=`vendor/*`+`packages/*/*`+`website`；tsdown 只收 vendor/packages；website 是「自带 build、不进 tsc/tsdown 构建图」的 workspace 成员先例；tsconfig.base.json 的 dsh-* paths 通配需为 host/client 组各加一行 |
| 2026-07-19 18:55 | worker1（deepseekchat 基线）完成：deepsuite-frontend 用 Rush+Rspack **无 Vite**；可借鉴 React ^18.2、TS 6.0.3 strict/Bundler/react-jsx、zustand ~4.4.7、CSS Modules+PostCSS；Vite 版本需自定（列入遗留问题） |
| 2026-07-19 18:57 | 已读 `deepseekchat-baseline.md` 全文并确认可用；等待 worker2（harness 接线）后动笔 design.md |
| 2026-07-19 19:12 | dispatcher 两次 idle 未产出，主会话停掉 dispatcher、收回素材直写 design.md 完成（五模块/四动线/包清单/3 个遗留问题） |
| 2026-07-19 20:30 | 重开恢复：前任 teammate 因主会话意外关闭中断（20:14 API 超时又丢一轮），新 owner 从归档恢复历史后重写 design.md 为 v2 实现级（⓪已锁结论/①目录树/②根配置精确编辑/③五包 package.json 全文/④五 tsconfig 全文/⑤bootHost+bin.ts+vite 三件套源文件/⑥12 条验收/⑦step2 接缝只指向 apiproxy 文档/⑧v1 差异）。核实点：app-boot loadEnv 可直接 import；LlmDeepSeek 为函数插件 `import * as`；SessionPersistenceJsonl root 必填；dist 解析定 createRequire |
