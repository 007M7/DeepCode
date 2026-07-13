# @deepseek-ai/dsh-workspace-context

Per-session workspace instruction loading for `AGENTS.md`-compatible files. The plugin freezes the initial user-global and project instruction chain into the request prefix, then discovers nested files and reports later changes or removals through durable context messages after successful filesystem tool calls.

## Lifecycle

The baseline is composed once per agent-loop instance on `agent/session-prefix`. It reads `$DSH_HOME/AGENTS.md` followed by one configured instruction candidate in each directory from the project root to `agent.session.header.cwd`. The prefix is placed before all derived history, recorded in `EpochHeader.messagePrefix`, and reused verbatim for that loop instance. Because the plugin prepends its contribution before delegating, a later-registered skills catalog appears after workspace instructions.

The plugin also listens on `tools/post-execute` for successful first-party `read`, `write`, and `edit` calls. Each touch checks newly reached descendant scopes and every previously loaded scope. A new file is attached through the result's `additionalContexts`; a changed file or candidate switch appends a replacement; a missing final candidate appends a removal notice. Native calls and Code Mode sub-dispatches share this path: `run_code` defers each nested context until its outer result, so the loop still appends updates after tool-call/result adjacency is complete. This follows structured filesystem activity rather than shell `cd`, because each local bash call starts a fresh shell and parsing arbitrary shell syntax would be unreliable.

Instruction reads use the optional `ctx.fs` provider. The plugin does not statically inject `fs`, so providerless product trees still boot and instruction loading becomes a no-op until a provider is present. It calls `ctx.fs.lstat` before resolving a candidate, rejecting a final-component symlink instead of following repository-owned links across the trust boundary. Prefix cancellation and dynamic tool cancellation propagate through resolution, metadata probes, and streaming reads. A provider failure after a file was loaded is treated as temporarily unavailable, not as proof that the file was deleted.

## Prompt Shape

Baseline instructions are request-only user-role prefix messages framed with the familiar system-reminder pattern:

```md
<system-reminder>
The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

Instructions from: ~/.dsh/AGENTS.md

...

Instructions from: AGENTS.md

...
</system-reminder>
```

Newly reached scopes use a durable raw `context/message`:

```md
<system-reminder>
Additional instructions from: packages/app/AGENTS.md

These instructions apply to work under `packages/app`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.

...
</system-reminder>
```

A same-file edit starts with `Updated instructions from: <path>` and says to use the new content instead of the previously loaded content. A candidate switch additionally names the old path. When no candidate remains, the message is `Instructions removed: <path>` followed by `The previously loaded instructions from this file no longer apply.` Literal `</system-reminder>` text inside an instruction file is escaped so file content cannot close the plugin-owned frame.

The core `context/message` envelope is disabled for these messages because the plugin already owns the complete `<system-reminder>` framing. This is caller-selected with `envelope: 'raw'`; ordinary injected context still receives the canonical `<context source="...">` envelope.

## State And Refresh

Model-visible text contains no hidden state markers. Each dynamic context event instead carries JSON metadata with a versioned list of `{ action, scope, path, previousPath?, digest? }` changes. On every relevant tool touch, the plugin reconstructs loaded state from its visible session events and overlays a short in-memory pending window for context present on the immutable top-level `tools/result` but not yet appended by the loop. Nested Code Mode results stage pending changes under the outer execution token for same-run duplicate suppression; the outer result rolls that state back and recommits only contexts that survived outer policy.

An unchanged path and SHA-1 content digest is not injected again. Resume works because visible metadata is persisted in the session log. Compaction re-arms a scope after its context event leaves the visible surface. A removal is a tombstone, so a later candidate reappearance is loaded again. Only changes actually rendered within the byte budget enter metadata and pending state; an omitted change remains eligible for a later touch.

The frozen baseline itself is not rewritten mid-instance. Its initial path/digest map is retained as comparison state; the next successful filesystem touch appends any baseline replacement or removal. A resumed loop recomposes the current baseline and also reconciles still-visible dynamic scopes during prefix composition. There is no file watcher, so an on-disk change becomes visible at the next successful `read`, `write`, or `edit` touch, or when a resumed loop composes its prefix.

## Configuration

```ts
export interface Config {
  dshHome?: string
  projectRootMarkers?: string[]
  maxBytes: number
  maxSourceBytes?: number
  instructionFileCandidates?: string[]
}
```

`maxBytes` is required so each deployment makes its prompt-budget choice explicitly. `maxSourceBytes` limits each source instruction file before rendering and defaults to 1 MiB. `projectRootMarkers` defaults to `['.git']`, and `instructionFileCandidates` defaults to `['AGENTS.md', 'CLAUDE.md']`. In each project directory, the first existing candidate wins; with defaults, `AGENTS.md` is native and `CLAUDE.md` is the compatibility fallback. Candidate entries must be same-directory file names, so empty entries, `.`/`..`, and entries containing `/` or `\` are ignored.

The user-global file is always `$DSH_HOME/AGENTS.md`; the candidate list only controls project scopes. `$DSH_HOME` defaults to `~/.dsh`, and configured `~`, `~/...`, and Windows-style `~\...` prefixes are expanded against the operating-system home directory. A non-positive or non-finite render budget disables both baseline and dynamic loading; configured `maxSourceBytes` must be a positive integer.

## Budgeting And Bounded Reads

Rendering preserves the most specific instruction files first. It drops whole broader files before truncating the most-specific file and emits a visible `Workspace instruction budget ...` notice naming omitted and truncated paths. The rendered bytes never exceed `maxBytes`.

Instruction content is read through `streamText()` under `maxSourceBytes`, even when provider metadata omits size or a file grows after its metadata probe. An oversized file is ignored without falling through to a lower-priority same-directory candidate; during dynamic reconciliation it is temporarily unavailable rather than removed. The plugin keeps no process-wide prose cache: every reconciliation observes current content, computes its SHA-1 only after the bounded read, and relies on persisted structured metadata for duplicate suppression.

## Non-goals

This implementation does not parse shell commands, recursively scan the repository, load lowercase names by default, interpret `.claude/rules/` or `@path` imports, watch files continuously, or summarize instruction content with a model. Same-directory names such as `CLAUDE.local.md` can be opted into through `instructionFileCandidates`; rule directories and import semantics need separate designs.
