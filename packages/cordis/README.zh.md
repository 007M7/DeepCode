# packages/cordis：Cordis 运行时集成

[English](README.md) | 中文

这些插件把 harness 自有格式集成到 Cordis 运行时：包括自指的模型工具集，以及受限的 repository 插件运行时。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | `cordis_inspect`／`cordis_mount`／`cordis_unmount` 工具：读取当前进程运行时，并在一个自有分组 fiber 下管理内存中的临时插件 | 注册到 `ctx.tools` |
| [`repository-plugin/`](repository-plugin/README.md) | 通过 DSH 自有子插件准备并挂载静态 repository skill（技能）与通用 `.mcp.json` server | 注册一个 loader builtin |
