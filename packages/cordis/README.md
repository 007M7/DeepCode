# packages/cordis — the self-referential runtime toolset

Model-facing tools over the live cordis runtime the agent itself runs inside: inspect the loaded plugins and service surface, mount model-written plugins, and dispose them again. Design home: [the toolset RFC](../../docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md).

| Package | Role | ctx key |
|---|---|---|
| [`tool-cordis/`](tool-cordis/README.md) | The `cordis_inspect` / `cordis_mount` / `cordis_unmount` tools: read the runtime, evaluate model-written plugin code in a `node:vm` sandbox, and manage the dynamic mounts under one group fiber | registers on `ctx.tools` |
