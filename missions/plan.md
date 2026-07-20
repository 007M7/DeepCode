> **【已被取代——历史档案】** 本文是 GUI 立项期的原始任务书（07-18 前）。现行权威=`missions/tasks/20260721-1520-web-plugin-rfc/` 的 api-contracts.md v3（接口契约）+ architecture.md（架构讲解）：当年的「后台 server + React 壳」已演进为 host/client 双 cordis 插件树（12 个 packages/client/* 包、bundle loader 动态装载）；「设置页/Provider 配置」未进 P-I 范围。滚动进度见 missions/progress.md。

DO NOT read AGENTS.md / CLAUDE.md in this project !!

要做的 PLAN
1. 需要做一个 Harness 的 UI 架构，设计模型上同时考虑 TUI / Electron / WebUI 同时对接，目前看到 opencode 的分层挺好的。
  1. WebUI: 基于本地 server localhost + 消息协议
  2. Electron: renderer 与 WebUI 相同，main 仅用于处理桌面专用功能（窗口、更新、Menu）
2. 当前实现Web localhost （后台 server 模式）.
3. Web 整体架构基于 React + vite 可见参考项目 DeepSeek Chat
4. Web 设计上需要引入 Cordis Context （虽然现在不用每个组件都引入，但是先保证有一个 root Context ，能初始化基础 Service 上去，作为 与 React 对等根的形式）
  1. 考虑到合理性诉求，需要确认 vscode 当前的插件隔离模型
5. 首先还是得实现一个简易的对话流和设置页
  1. Session 选择：当前一共有多少个 sessionId ，按时间列
  2. 对话流：输入框、流式输入、Markdown 展示，tool 显示，发送排队，数据走 SSE/WebSocket 不确定
  3. 设置页：Provider 配置/APIKEY 配置、模型列表

最新调研结论，在 
- missions/ui-product.md
- missions/ui-tech.md


前提：
- 说中文，记录中文
- 当前主会话任务非常繁忙，如果有各类调研和编码任务，请启动 agent team subagent （background，不阻塞主会话）。
  - 主会话可以创建 dispatcher，dispatcher 可以创建 worker。
  - dispatcher 负责干完整命题，worker 负责干具体耗时任务，交由dispatcher进行汇总。主会话负责表格化同步所有任务进展
- 主会话和 subagent 的所有工作，需要在 missions/tasks/$具体任务$ 中按照时间（精确到分钟）-任务名归档，边干边记录变化，便于回溯
- 当前 deepseep-harness 项目不需要先投入时间经历分析，先搞其他

参考项目地址可以访问：
- opencode: /weka-hg/prod/deepseek/permanent/ys/private/workspace/github/opencode
- deepseekchat: /weka-hg/prod/deepseek/permanent/ys/private/workspace/gitlab/deepsuite-frontend
