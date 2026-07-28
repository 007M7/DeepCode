# packages/cordis：自指运行时工具集

[English](README.md) | 中文

面向模型、作用于 agent（智能体）所在实时 Cordis 运行时的工具：检查当前 DSH 进程，并挂载或卸载仅存于内存的临时 Plugin。设计归档见[工具集 Agent Note（agent 决策记录）](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)。

| 包（package） | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_mount`／`cordis_unmount` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理临时 Plugin | 注册到 `ctx.tools` |
