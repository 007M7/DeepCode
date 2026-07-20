# 多 client 并连可行性调研

- **命题**：两个网页同开同一 sessionId，一边发送另一边实时看流式输出（草稿不共享）——当前架构支持度 + 改造复杂度。
- **状态**：已完稿（2026-07-20）。结论：**零改造已支持**——server 每流独立 FrameQueue + ctx 事件天然 fan-out；实测（curl 双 SSE + playwright 双浏览器）端到端全绿。唯一边界：同浏览器 ≥3 标签页触 HTTP/1.1 每源 6 连接上限。
- **产出**：`report.md`（逐段分析 / 结论矩阵 / 改造清单 / 复杂度总评 S）。
- **实测脚本**：`multiclient-e2e.mjs`（双浏览器主验收）、`streaming-observe.mjs`（对侧流式 DOM 增长）、`three-tabs-pool.mjs` / `two-tabs-pool.mjs`（连接池边界探针）——均从仓库根 `node <path>` 直跑，需 dsc web @3080 在线。
- **纪律**：只调研未改产品代码。
