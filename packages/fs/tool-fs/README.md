# @deepseek-ai/dsh-tool-fs

The **model-facing filesystem tools** — `read`, `write`, `edit` — and their **executor**. This is the consumer layer of the filesystem stack: it owns tool names, JSON schemas, argument validation, prompt sections, **read windowing**, and result formatting. It reads/writes/edits through the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)) **directly** — it injects `fs` (plus `tools`/`systemPrompt`), **not** a policy service. The freshness/observation policy is contributed by a separate plugin ([`@deepseek-ai/dsh-file-context`](../file-context)) through the `fs/*` event gate; the tool is not method-coupled to it.

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FileContext)                             // @deepseek-ai/dsh-file-context (policy gate)
await ctx.plugin(ToolFs)                                  // this package — registers read/write/edit
```

`@deepseek-ai/dsh-file-context` is **optional**: omit it and the tools run against the bare provider (unconditional write/overwrite/edit, no observed-state). The default product config loads it, so the default behavior stays read-before-write/edit.

Each tool also ships as a subpath plugin for focused deployments (each injects `fs`, not a policy service):

```ts ignore-check
import * as readPlugin from '@deepseek-ai/dsh-tool-fs/read'
import * as writePlugin from '@deepseek-ai/dsh-tool-fs/write'
import * as editPlugin from '@deepseek-ai/dsh-tool-fs/edit'
```

## Tools (schemas per [the filesystem tool schemas RFC](../../../docs/rfc/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at 2000 lines. |
| `write` | `file_path`, `content` | Create or fully replace a file. With the policy plugin: overwriting an existing file requires a prior `read` at the unchanged version; creating a new file does not. Without it: unconditional. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. With the policy plugin: requires a prior `read` (any window) and the file unchanged since. Without it: unconditional. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

## The tool is the executor; policy is an event gate

The tools do **not** inject a policy service or inspect any cache. Each tool resolves the path via `ctx.fs.resolve()`, then:

- **read** — one `ctx.fs.stat` (type + size routing + version), then `readText`/`streamText`, then builds the line window, then emits a contained `fs/observed`. (1 stat.)
- **write** — `ctx.waterfall('fs/write-expectation', target, exec, () => undefined)` for the optional guard, then `ctx.fs.writeText(target, content, expectation)`, then `fs/observed`. (0 stat.)
- **edit** — `ctx.waterfall('fs/edit-expectation', target, exec, () => undefined)` for the optional guard, then `ctx.fs.editText(target, edit, expectation)`, then `fs/observed`. (0 stat.)

The tool passes `exec` (the tool-execution context) as the opaque `actor` on every dispatch. The default thunks return `undefined` (the unconstrained bare provider). When `@deepseek-ai/dsh-file-context` is loaded it occupies the single decision slot — returning `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED` — and records on `fs/observed`. Backend errors (`FsError`) and a thrown `FS_NOT_OBSERVED` flow through `ToolRegistry.execute()` and become `isError` tool results with their `{ name, code }` attached.

## `fs/observed` never fails the tool

`fs/observed` fires AFTER the read/write/edit already succeeded, so the tool wraps the emit in a try/catch (`src/observe.ts`) that logs and swallows a synchronous listener bug — otherwise a recording failure would turn a completed mutation into an `isError`. The event contract requires synchronous, side-effect-only listeners; this is the synchronous backstop, not async-error handling.

The line-windowing mechanics live in `src/window.ts` (Cordis-free, independently unit-tested); `src/read.ts`/`write.ts`/`edit.ts` are the tool executors and `src/index.ts` composes them.
