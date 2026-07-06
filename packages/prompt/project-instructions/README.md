# @deepseek-ai/dsh-project-instructions

Project instruction file loader for the harness. It discovers the configured per-directory instruction file candidates for each agent session, injects the baseline content as fenced workspace context before model requests, and lazily adds nested instruction files when structured file tools touch deeper paths. The default candidate order is `AGENTS.md`, then `CLAUDE.md`.

## Behavior

The plugin listens on the `agent/request` waterfall and reads instruction file content through the `ctx.fs` provider seam. It deliberately does not declare `fs` as a static dependency: `agent-core` can load the plugin in providerless app trees, and the plugin simply does nothing until a filesystem provider is present at request/tool time. For each request it derives the workspace from `agent.session.header.cwd`; if the session has no cwd, it falls back to `process.cwd()` for single-session local/stdio runs. It then finds the project root by walking upward until it sees `.git` as either a directory or a file, considers the ancestor chain from project root to cwd, and loads at most one instruction file per directory by checking `instructionFileCandidates` in order. With the default candidates, `AGENTS.md` wins and `CLAUDE.md` is a compatibility fallback.

The plugin also listens on `tools/post-execute` for successful structured filesystem touches from the first-party `read`, `write`, and `edit` tools. When one of those tools touches a descendant of the session cwd, the plugin checks the directories between the session cwd and the touched file for instruction files that are not already visible in session context, then attaches them as `additionalContext` so the loop records a durable `context/message` for the next model request. This intentionally follows file-tool touches, not shell `cd`: `dsh-bash-local` uses fresh shells per call, and parsing arbitrary shell commands for reached paths would be brittle.

User-global instructions live at `$DSH_HOME/AGENTS.md`; `$DSH_HOME` defaults to `~/.dsh`. A configured `~`, `~/...`, or Windows-style `~\...` prefix is expanded against the operating-system home directory before resolution. The user-global file name is harness-level and is not affected by `instructionFileCandidates`, which only controls per-directory project and nested discovery. The user-global file renders before project files, so deeper project files appear later in the context and can override broader guidance.

Baseline files are inserted as a synthetic user-role workspace-context message, not as provider system text and not as persisted session events. Nested files discovered after structured file tools run are inserted through the existing `context/message` path, so they persist with the session and resume like other plugin-provided context. Nested duplicate suppression is derived from the visible session surface plus a short pending window before the loop records `additionalContext`; if compaction removes a nested context message from the surface, a later structured file touch may re-load it so the next model request still sees the applicable guidance. The rendered envelope states that these files are workspace-provided guidance, lower authority than system/developer/direct user instructions, and must not override safety, permission, or secret-handling rules.

The baseline hook currently runs for every `agent/request`, including maintenance model calls such as compaction summarization. `GenerateOptions` does not yet carry a request-kind marker, so the plugin cannot distinguish user-facing turns from summarization without brittle prompt sniffing. A future request marker should let prompt-context plugins opt out of maintenance calls deliberately.

## Config

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  baselineMaxBytes?: number
  instructionFileCandidates?: string[]
}
```

`projectRootMarkers` defaults to `['.git']`, `baselineMaxBytes` defaults to `65536`, and `instructionFileCandidates` defaults to `['AGENTS.md', 'CLAUDE.md']`. In each project or nested directory, the first existing candidate is loaded and the rest are ignored. Candidate entries must be same-directory file names; empty entries, `.`/`..`, and entries containing `/` or `\` are ignored. Setting `baselineMaxBytes` to `0` or another non-positive value disables both baseline and nested instruction injection.

## Budgeting and cache

The renderer keeps full text until the configured byte budget is exceeded. When it must trim, it preserves more-specific files first, drops whole less-specific files before truncating a more-specific file, and emits an HTML comment naming omitted and truncated files with byte counts.

Discovery re-walks the applicable ancestor chain on every request so newly created baseline files are noticed. File content is cached by normalized absolute path plus the provider's opaque file version and size; a changed signature causes a re-read. The discovery pass carries the file signature forward to the read pass, so a cache hit does not stat the same instruction file twice in one request. Nested instruction paths are de-duplicated from recorded session context rather than from the content cache, so cache eviction or repeated reads do not duplicate still-visible durable context.

## Non-goals

This phase does not implement `contextPaths()`, shell parsing, bash-`cd`-based instruction loading, lowercase filenames by default, `.claude/` rule directories, `@path` imports, file watching, or model-generated summaries. Simple same-directory local/private filenames such as `CLAUDE.local.md` can be opted into through `instructionFileCandidates`; broader rule directories and import semantics need separate design beyond structured file-tool touches.
