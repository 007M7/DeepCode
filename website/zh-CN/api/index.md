# API 参考

本节提供 DeepSeek Harness 的完整 API 参考文档，分为两部分：

## 框架 API

Cordis 微内核提供的基础能力，所有插件开发都建立在这些 API 之上：

- [Context](./cordis/context) — 上下文对象，所有服务和方法的入口
- [Events](./cordis/events) — 事件系统 API（emit / on / bail / serial / waterfall）
- [Fiber](./cordis/fiber) — 作用域生命周期（状态机、effect、dispose）
- [Registry](./cordis/registry) — 插件注册（plugin / inject）
- [Service](./cordis/service) — 服务基类

## Harness API

DeepSeek Harness SDK 提供的扩展 API，用于构建 Agent 能力：

- [Tools (dsh-tools)](./harness/tools) — Tool 注册、defineTool DSL、Schema 类型系统
- [LLM (dsh-llm)](./harness/llm) — LLM 服务、适配器注册、StreamChunk 协议
- [Session (dsh-session)](./harness/session) — 会话事件流、消息类型
- [Agent (dsh-agent)](./harness/agent) — Agent 实例管理、生命周期
- [Bash (dsh-bash)](./harness/bash) — Bash 执行接口
- [Filesystem (dsh-fs)](./harness/fs) — 文件系统接口
- [Subagent (dsh-subagent)](./harness/subagent) — 子代理委派接口
