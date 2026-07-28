# SDK 包

[English](README.md) | 中文

用于创建、编辑、构建和运行 DeepSeek Harness 项目的开发者工具，外加从另一进程驱动 harness 运行时的客户端 SDK 栈。

[功能 Agent Note](../../.agents/notes/proposed/feature/2026-07-14-sdk-developer-projects.md)负责开发者工作流；[架构 Agent Note](../../.agents/notes/proposed/architecture/2026-07-15-sdk-project-editing-architecture.md)负责包与项目编辑边界；[TypeScript SDK Agent Note](../../.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md)负责客户端 SDK 栈。

| 包 | 职责 |
|---|---|
| [`helper`](helper/README.md) | 项目聚合、编辑会话、内置功能、项目文档、模板、包管理器与提示词抽象 |
| [`scripts`](scripts/README.md) | `dsh-sdk` 启动器：`start`、`dev`、`build` 和交互式 `config` |
| [`create-sdk`](create-sdk/README.md) | `npm create @deepseek-ai/sdk` 初始化器 |
| [`sdk-protocol`](sdk-protocol/README.md) | 共享的 SDK 运行时线协议：按换行分帧的 JSON-RPC 传输 + 具名请求/通知类型 |
| [`sdk-client`](sdk-client/README.md) | TypeScript 客户端 SDK：走 stdio JSON-RPC 驱动 harness 运行时子进程（Python SDK 的设计孪生） |

`@deepseek-ai/create-sdk` 是仓库 `@deepseek-ai/dsh-*` 命名规则的唯一例外：npm 的 scoped initializer 约定要求使用该名称，才能支持 `npm create @deepseek-ai/sdk`。

生成的项目始终以 `cordis.yml` 作为唯一运行时插件树。`dsh-sdk dev` 只是在同一文件周围增加 TypeScript 与本地工作区解析，不会创建仅供开发环境使用的配置。
