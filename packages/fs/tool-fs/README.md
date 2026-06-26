# @deepseek-ai/dsh-tool-fs

The **model-facing filesystem tools** — `read`, `write`, `edit` — over the `ctx.fileContext` policy layer ([`@deepseek-ai/dsh-file-context`](../file-context)). This is the consumer layer of the filesystem stack; it owns tool names, JSON schemas, argument validation, prompt sections, and result formatting, and **never** touches filesystem I/O (no `node:fs`/`node:path`, no implementation import) or reaches around the policy layer to `ctx.fs`.

```ts ignore-check
// Load a ctx.fs provider, the policy layer, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FileContext)                             // @deepseek-ai/dsh-file-context
await ctx.plugin(ToolFs)                                  // this package — registers read/write/edit
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
| `write` | `file_path`, `content` | Create or fully replace a file. Overwriting an existing file requires a prior `read` at the unchanged version; creating a new file does not. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. Requires a prior `read` (any window) and the file unchanged since. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

## How the read-before-write/edit policy is enforced

The tools do **not** check whether a `read` ran or inspect any cache. Each tool resolves the path via `ctx.fileContext.resolve()`, then calls `ctx.fileContext.read/write/edit(target, …, exec)` — passing the current tool execution context straight through. `ctx.fileContext` derives the observed-state owner (normally the agent session) from that context and owns the freshness policy: a recorded read at the file's current version authorizes a write/edit, and any windowed read counts (authorization is freshness, not a full-view requirement). Backend errors (`FsError`) flow through `ToolRegistry.execute()` and become `isError` tool results with their `{ name, code }` attached.

## The no-bypass contract

A model-facing read MUST go through `ctx.fileContext.read`, never `ctx.fs.readText`/`streamText`, so every successful read records observed-state before rendering — which is why the tools inject `fileContext`, not `fs`. Direct `ctx.fs` calls remain an explicit escape hatch for non-tool consumers: a direct `ctx.fs.readText` records nothing, so a later `edit` rejects with `FS_NOT_OBSERVED` until the file is read through `ctx.fileContext`.

Tool schemas reach the system prompt automatically via the tool registry; this package additionally registers short prose guidance through `ctx.systemPrompt.section(...)`.
