# 任务理解 — tool 调用展示调研（为 session 界面 tool 卡改造立项打地基）

派发：team-lead，2026-07-20 17:49。owner：tool-render（常驻 teammate；P9/P10 分叉对齐 gui-arch-research 报告，不重写）。

## 三层命题

1. **全量 tool 清单**：harness 里现在到底有哪些 tool（以 grep packages/ 实际为准，不凭印象）。
2. **跨 tool 的通用数据架构**：数据协议现状哪里不好——tool 不一定「一次调用一次结果」，有的内部数据持续刷新（流式 args 累积、执行中进度、terminal scrollback）。现有 `tool/call`→`tool/result` 两事件模型 + partial argsRaw 累积够不够表达？对照 ACP render intent（generic/terminal/diff 三型 + locations）盘 core 已有词汇。
3. **每 tool 理想展现形式**：表格 = tool × 现有渲染 × 理想卡型（diff/terminal/widget/纯文本折叠…）× 数据需求（一次性 vs 持续刷新 vs 可交互）× 现协议缺口。

## 材料

- packages/ 全部 tool 定义：bash 族、fs 读写编辑、web 搜索抓取、todo_write、skill、subagent 委派、workflow、cordis 自省、code-runtime（以实际 grep 为准）。
- docs/architecture.md、docs/cookbook/adding-a-tool.md（render intent 是设计的一部分）。
- core `tool/call`/`tool/result` 事件定义、StreamChunk。
- gui-arch-research report 的 P9/P10 节。
- web-ui 现有 ToolCallCard/PendingCard。

## 纪律

- 数据协议怎么改、卡型归 core 还是插件（P9/P10）**不替用户拍**，列分叉。
- 只调研零 commit；分批落盘（清单批→架构批→表格批），每批回执。
