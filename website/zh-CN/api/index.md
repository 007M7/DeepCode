# API 参考

本节是 DeepSeek Harness 的 API 参考。除本页外，`cordis/` 与 `harness/` 下的所有页面**由脚本从源码生成**（`pnpm run gen-website-api`，CI 校验新鲜度），签名与说明永远与代码一致；生成页目前为英文，中文版将随统一翻译流程提供。

## 框架 API

Cordis 微内核提供的基础能力，所有插件开发都建立在这些 API 之上：

- [Context](./cordis/context) — 上下文对象，所有服务和方法的入口
- [Events](./cordis/events) — 事件系统 API（on / emit / bail / serial / waterfall）
- [Fiber](./cordis/fiber) — 插件生命周期（状态机、effect、dispose）
- [Registry](./cordis/registry) — 插件注册（plugin / inject）
- [Service](./cordis/service) — 服务基类

## Harness API

每个 `ctx.*` 服务一页，按服务名索引：

- [ctx.agentLoop](./harness/agent-loop) — ReAct 循环的创建与恢复
- [ctx.agents](./harness/agents) — Agent 注册表与工厂
- [ctx.approval](./harness/approval) — 用户审批
- [ctx.bash](./harness/bash) — Bash 执行接口（抽象缝）
- [ctx.codeRuntime](./harness/code-runtime) — 代码执行接口（抽象缝）
- [ctx.compact](./harness/compact) — 上下文压缩接口（抽象缝）
- [ctx.fs](./harness/fs) — 文件系统接口（抽象缝）
- [ctx.llm](./harness/llm) — LLM 服务与适配器注册
- [ctx.permission](./harness/permission) — 权限策略
- [ctx.sandbox](./harness/sandbox) — 沙箱执行接口（抽象缝）
- [ctx.sessionPersistence](./harness/session-persistence) — 会话持久化接口（抽象缝）
- [ctx.sessionQuery](./harness/session-query) — 会话检索
- [ctx.sessions](./harness/sessions) — 会话存储
- [ctx.skills](./harness/skills) — 技能加载
- [ctx.subagents](./harness/subagents) — 子代理委派
- [ctx.systemPrompt](./harness/system-prompt) — 系统提示词组装
- [ctx.tasks](./harness/tasks) — 后台任务
- [ctx.tools](./harness/tools) — Tool 注册表
- [ctx.userInteraction](./harness/user-interaction) — 用户交互接口
- [ctx.web](./harness/web) — Web 搜索与抓取
- [ctx.workflows](./harness/workflows) — 动态工作流引擎（抽象缝）

事件总表：[Harness events](./harness/events) — 全部事件按作用域分组，含触发模式与载荷签名。

想学"怎么写一个 tool / 插件"？教程在[开发指南](../develop/basic/)；本节只做精确的接口参考。
