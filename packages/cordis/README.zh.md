# packages/cordis：自指运行时工具集

[English](README.md) | 中文

这些面向模型的工具作用于 agent（智能体）自身所在的实时 Cordis 运行时，可检查已加载的插件和服务接口、挂载模型编写的插件，并将其 dispose（资源释放）。设计说明见[工具集 Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

| 包（package） | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_mount`／`cordis_unmount` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的临时插件 | 注册到 `ctx.tools` |
