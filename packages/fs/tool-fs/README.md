# @deepseek-ai/dsh-tool-fs

The **model-facing filesystem tools** — `read`, `write`, `edit` — and their **executor**. This is the consumer layer of the filesystem stack: it owns tool names, JSON schemas, argument validation, prompt sections, **read windowing**, and result formatting. It reads/writes/edits through the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)) **directly** — it injects `fs` (plus `tools`/`systemPrompt`), **not** a policy service. The freshness/observation policy is contributed by a separate plugin ([`@deepseek-ai/dsh-fs-policy`](../fs-policy)) through the `fs/*` event gate; the tool is not method-coupled to it.

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FsPolicy)                             // @deepseek-ai/dsh-fs-policy (policy gate)
await ctx.plugin(ToolFs)                                  // this package — registers read/write/edit
```

`@deepseek-ai/dsh-fs-policy` is **optional**: omit it and the tools run against the bare provider (unconditional write/overwrite/edit, no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit.

## Tools (schemas per [the filesystem tool schemas RFC](../../../docs/rfc/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at 2000 lines. |
| `write` | `file_path`, `content` | Create or fully replace a file. With the policy plugin: overwriting an existing file requires a prior `read` at the unchanged version; creating a new file does not. Without it: unconditional. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. With the policy plugin: requires a prior `read` (any window) and the file unchanged since. Without it: unconditional. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

## The tool is the executor; policy is an event gate

The tools do **not** inject a policy service or inspect any cache. Each tool resolves the path via `ctx.fs.resolve(path, { cwd })` — passing the calling agent's session cwd (`exec.agent.session.header.cwd`) so a relative path resolves against the session's workspace, matching `dsh-tool-bash` (see [the per-session cwd RFC](../../../docs/rfc/implemented/architecture/2026-07-02-fs-per-session-cwd.md)) — then:

- **read** — one `ctx.fs.stat` (type + size routing + version), then `readText`/`streamText`, then builds the line window, then emits `fs/observed` with a plain `ctx.emit`. (1 stat.)
- **write** — `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.writeText(target, content, intent)`, then `fs/observed`. (0 stat.)
- **edit** — `ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.editText(target, edit, intent)`, then `fs/observed`. (0 stat.)

The tool passes `exec` (the tool-execution context) as the opaque `actor` on every dispatch. The default thunks return `undefined` (the unconstrained bare provider). When `@deepseek-ai/dsh-fs-policy` is loaded it occupies the single decision slot — returning `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED` — and records on `fs/observed`. Backend errors (`FsError`) and a thrown `FS_NOT_OBSERVED` flow through `ToolRegistry.execute()` and become `isError` tool results with their `{ name, code }` attached.

## `fs/observed` is fire-and-forget

`fs/observed` fires AFTER the read/write/edit already succeeded, via a plain `ctx.emit`. A listener is contractually a synchronous, side-effect-only recorder (`@deepseek-ai/dsh-fs-policy`'s is a `WeakMap.set`); the tool does not guard the emit, so a listener that throws would surface as the tool's `isError` result — async or fallible observation does not belong on this event.

The read rendering (line windowing + output formatting) lives in `src/read-render.ts` (Cordis-free, independently unit-tested); `src/read.ts`/`write.ts`/`edit.ts` are the tool executors and `src/index.ts` composes them.
