# @deepseek-ai/dsh-tool-fs

The **model-facing filesystem tools** — `read`, `write`, `edit` — over the `ctx.fs` seam ([`@deepseek-ai/dsh-fs`](../fs)). This is the consumer third of the filesystem capability; it owns tool names, JSON schemas, argument validation, prompt sections, and result formatting, and **never** touches filesystem I/O (no `node:fs`/`node:path`, no implementation import).

```ts ignore-check
// Load a ctx.fs provider first, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(ToolFs)                                   // this package — registers read/write/edit
```

Each tool also ships as a subpath plugin for focused deployments:

```ts ignore-check
import * as readPlugin from '@deepseek-ai/dsh-tool-fs/read'
import * as writePlugin from '@deepseek-ai/dsh-tool-fs/write'
import * as editPlugin from '@deepseek-ai/dsh-tool-fs/edit'
```

## Tools (schemas per [the filesystem tool schemas RFC](../../../docs/rfc/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at 2000 lines. |
| `write` | `file_path`, `content` | Create or fully replace a file. Overwriting an existing file requires a prior `read` (the backend enforces it); creating a new file does not. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. Requires a prior `read`. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

## How the read-before-write policy is enforced

The tools do **not** check whether a `read` ran or inspect any cache. Each tool resolves the path via `ctx.fs.resolve()`, then calls `ctx.fs.read/write/edit(target, …, exec)` — passing the current tool execution context straight through. `ctx.fs` derives the file-state owner (normally the agent session) from that context and owns the prior-observation and stale-version policy. Backend errors (`FsError`) flow through `ToolRegistry.execute()` and become `isError` tool results with their `{ name, code }` attached.

Tool schemas reach the system prompt automatically via the tool registry; this package additionally registers short prose guidance through `ctx.systemPrompt.section(...)`.
