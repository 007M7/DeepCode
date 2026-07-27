# packages/cordis — the self-referential runtime toolset

English | [中文](README.zh.md)

Model-facing tools over the live cordis runtime the agent itself runs inside: inspect the loaded plugins and service surface, mount model-written plugins, and dispose them again. Design home: [the toolset Agent Note](../../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | The `cordis_inspect` / `cordis_mount` / `cordis_unmount` tools: read the current-process runtime and manage in-memory temporary Plugins under one owned group fiber | registers on `ctx.tools` |
