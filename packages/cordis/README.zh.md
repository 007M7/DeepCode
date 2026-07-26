# packages/cordis：自指运行时工具集

[English](README.md) | 中文

面向模型、作用于 agent（智能体）自身所在实时 Cordis 运行时的工具：检查已加载插件与服务接口、挂载模型编写的插件，以及再次释放这些插件。设计归档见[工具集 Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

| 包（package） | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_mount`／`cordis_unmount` 工具：读取运行时、在 `node:vm` 沙箱中求值模型编写的插件代码，并在同一个分组 fiber 下管理动态挂载 | 注册到 `ctx.tools` |
