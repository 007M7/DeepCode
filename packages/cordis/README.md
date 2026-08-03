# packages/cordis — Cordis runtime integration

English | [中文](README.zh.md)

Plugins that integrate Harness-owned formats with the Cordis runtime: the self-referential model toolset and the restricted repository Plugin runtime.

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | The `cordis_inspect` / `cordis_mount` / `cordis_unmount` tools: read the current-process runtime and manage in-memory temporary Plugins under one owned group fiber | registers on `ctx.tools` |
| [`repository-plugin/`](repository-plugin/README.md) | Prepare and mount static repository skills plus common `.mcp.json` servers through DSH-owned child Plugins | registers a Loader builtin |
