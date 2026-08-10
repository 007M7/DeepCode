# Agent Note：Web 会话日志导出——session.log RPC + ZIP 下载

状态：implemented

[English](2026-08-10-web-session-log-export.md) | 中文

## 问题

Trajectory 视图没有任何方式把调试工件交到人手里：原始会话日志存放在磁盘与宿主侧，客户端历史面只提供折叠后的投影（而非原始事件），而带子代理的会话横跨多个相互独立的会话日志。bug 报告需要整棵会话树的完整原始日志，并且形态要能在被转发后仍然可用。

## 决策

- **导出是宿主侧的下载面，不是 RPC**：`GET /api/session.export?sessionId=…&includeDescendants=true` 流式返回一个 ZIP 附件。每个文件都是会话**存储工件的逐字原文**：持久化服务新增的 `readRaw` 读取后端自己的持久化字节（jsonl 后端解码其物理 zstd 帧，或直接返回明文）——绝非从解析后事件重建，因此 chunk 打包、键序、换行全部逐字节保留——放在其原始基础文件名下（根为 `session.jsonl`，子代理为 `subagents/<id>/session.jsonl`）。压缩在宿主侧用 fflate 的流式 `Zip`/`ZipDeflate` API 完成，每个条目按有界分块边产出边压缩，响应随生成分块写出，宿主从不把整个归档放进内存（除预载的根外，最多同时持有一条后代的工件文本）。不写清单——每个文件都与持久化工件逐字节一致，并通过自身 header 行自描述。
- **错误词汇是 HTTP 原生的**：服务缺失 → 500，根会话缺失 → 404（两者都在任何字节流出前判定），后代缺少存储工件 → 流失败（fail-loud，绝不静默少导出）。载体（`toFetchHandler`）已对 `/api` 应用信任围栏；GET 分支与既有 SSE GET 路由并列，由 `ApiProxy.downloads.sessionLog`（host-only、无 wire 信封、不在 `IApiClient` 上）实现。
- **UI 只负责下载**：「导出」按钮 fetch 该端点并保存响应；早先迭代发布的 `session.log` RPC 已删除——下载端点是它唯一的消费者，仓库规则是不留无当前所有者的公共接口。客户端 bundle 不再携带 fflate（早先的浏览器入口别名坑随之消失）。
- 「导出」按钮位于 Trajectory 工具栏；插件通过视图的 inject face 暴露 `exportLog`（组件从不接触 ctx），并通过 locale 服务解析视图标签页标题（中文「轨迹」、英文 "Trajectory"）。进行中状态会禁用按钮；失败会在工具栏下方的可见警示条中显示。

## 考虑过的替代方案

- **`session.log` 数据 RPC + 客户端打包**——先发布，后与用户共同否决：浏览器要拉取完整原始 JSON（约为最终 zip 的 10 倍）并在主线程压缩；对实际使用中 23 MB 级别的会话，宿主流式严格更优。迁移时把该 RPC 一并删除，而不是留作无消费者的公共接口。
- **用信封行把多会话编码进单一 JSONL**——与用户共同否决：把多个会话混进一个 JSONL 会失去干净的按文件边界；ZIP 让每个会话保持一个规范文件。
- **jszip**——更重（约 100 kB），依赖图还会拉入 readable-stream 的浏览器映射；fflate 专为此而生且体积小。
- **将 fflate 浏览器入口 vendoring 进仓库**——仓库的 vendoring 流程面向 cordis 级别的固定源码；resolveId 别名在保持维护中的依赖的同时无需复制代码（宿主侧 fflate 根本不需要别名）。

## 后果

- 导出保真度：每个导出文件都与读取时刻的后端持久化工件逐字节一致（活跃会话可能在读取后继续追加；导出反映的是读取时的持久化状态）。压缩包名为 `dsh-session-<sanitized-id>.zip`，归档路径在塑造条目前会先净化会话 id。
- `readRaw` 以具体默认（无每会话工件的后端如 SQLite 返回 `undefined`）加入持久化服务，jsonl 后端覆写并自持压缩解码。`ApiProxy.downloads.sessionLog` 为契约新增一个 host-only 成员，外加宿主侧 query schema，并在 fetch handler 加一个 GET 分支——没有 RPC map 行、信封 schema 或客户端 `IApiClient` 面。
- fixture 模式（无宿主）对导出应答 404，按钮的错误条会解释这个缺口而非挂起；navigation-panes golden 快照包含「导出」按钮。
- 暂缓：transcript.md 以及 report/feedback 打包留待后续；逐字节忠实、无清单的形态让 v2 的打包扩展保持廉价。
