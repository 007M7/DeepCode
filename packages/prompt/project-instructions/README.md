# @deepseek-ai/dsh-project-instructions

Project instruction file loader for the harness. It discovers `AGENTS.md` with `CLAUDE.md` fallback for each agent session and injects the loaded content as fenced workspace context before model requests.

## Behavior

The plugin listens on the `agent/request` waterfall and depends on the `ctx.fs` provider seam to read instruction file content. For each request it derives the workspace from `agent.session.header.cwd`; if the session has no cwd, it falls back to `process.cwd()` for single-session local/stdio runs. It then finds the project root by walking upward until it sees `.git` as either a directory or a file, considers the ancestor chain from project root to cwd, and loads at most one instruction file per directory: `AGENTS.md` wins, `CLAUDE.md` is a compatibility fallback.

User-global instructions live at `$DSH_HOME/AGENTS.md`; `$DSH_HOME` defaults to `~/.dsh`. A configured `~`, `~/...`, or Windows-style `~\...` prefix is expanded against the operating-system home directory before resolution. The user-global file renders before project files, so deeper project files appear later in the context and can override broader guidance.

The loaded files are inserted as a synthetic user-role workspace-context message, not as provider system text and not as persisted session events. The rendered envelope states that these files are workspace-provided guidance, lower authority than system/developer/direct user instructions, and must not override safety, permission, or secret-handling rules.

## Config

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  baselineMaxBytes?: number
  enableClaudeFallback?: boolean
}
```

`projectRootMarkers` defaults to `['.git']`, `baselineMaxBytes` defaults to `65536`, and `enableClaudeFallback` defaults to `true`. Setting `baselineMaxBytes` to `0` or another non-positive value disables instruction injection.

## Budgeting and cache

The renderer keeps full text until the configured byte budget is exceeded. When it must trim, it preserves more-specific files first, drops whole less-specific files before truncating a more-specific file, and emits an HTML comment naming omitted and truncated files with byte counts.

Discovery re-walks the applicable ancestor chain on every request so newly created baseline files are noticed. File content is cached by normalized absolute path plus the provider's opaque file version and size; a changed signature causes a re-read. The discovery pass carries the file signature forward to the read pass, so a cache hit does not stat the same instruction file twice in one request.

## Non-goals

This phase does not implement lazy on-touch nested loading, `contextPaths()`, shell parsing, lowercase filenames, `.claude/` rule directories, local/private variants, `@path` imports, file watching, or model-generated summaries. Those need separate semantics and, for on-touch loading, real structured file tools that can report touched paths.
