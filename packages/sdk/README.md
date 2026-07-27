# SDK packages

English | [中文](README.zh.md)

Developer tooling for creating, editing, building, and running DeepSeek Harness projects.

The [feature Agent Note](../../.agents/notes/proposed/feature/2026-07-14-sdk-developer-projects.md) owns the developer workflow; the [architecture Agent Note](../../.agents/notes/proposed/architecture/2026-07-15-sdk-project-editing-architecture.md) owns the package and project-editing boundaries.

| Package | Role |
|---|---|
| [`helper`](helper/README.md) | Project aggregate, edit session, builtin features, project documents, templates, package managers, and prompt abstraction |
| [`scripts`](scripts/README.md) | The `dsh-sdk` launcher: `start`, `dev`, `build`, and interactive `config` |
| [`create-sdk`](create-sdk/README.md) | The `npm create @deepseek-ai/sdk` initializer |

`@deepseek-ai/create-sdk` is the one package-name exception to the repository's `@deepseek-ai/dsh-*` rule: npm's scoped initializer convention requires that name for `npm create @deepseek-ai/sdk`.

Generated projects keep `cordis.yml` as the only runtime plugin tree. `dsh-sdk dev` adds TypeScript and local-workspace resolution around that same file; it does not create a development-only config.
