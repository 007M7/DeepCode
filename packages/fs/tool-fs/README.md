# @deepseek-ai/dsh-tool-fs

English | [中文](README.zh.md)

The **model-facing filesystem tools** — `list`, `read`, `write`, `edit` — and their **executor**. This is the consumer layer of the filesystem stack: it owns tool names, JSON schemas, argument validation, prompt sections, **read windowing**, **listing order**, and result formatting. It reads/writes/edits through the `ctx.fs` provider seam ([`@deepseek-ai/dsh-fs`](../fs)) **directly** — it injects `fs` (plus `tools`/`systemPrompt`), **not** a policy service. The freshness/observation policy is contributed by a separate plugin ([`@deepseek-ai/dsh-fs-policy`](../fs-policy)) through the `fs/*` event gate; the tool is not method-coupled to it.

```ts ignore-check
// Default deployment: a ctx.fs provider, the policy plugin, then the tools.
await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) // @deepseek-ai/dsh-fs-local
await ctx.plugin(FsPolicy)                             // @deepseek-ai/dsh-fs-policy (policy gate)
await ctx.plugin(ToolFs)                                  // this package — registers list/read/write/edit
```

`@deepseek-ai/dsh-fs-policy` is **optional**: omit it and the tools run against the bare provider (unconditional write/overwrite/edit, no observed-state). A deployment that loads these tools is expected to also load it, so the behavior is read-before-write/edit.

## Config

All keys are optional; the defaults are the shipped listing and read caps.

| Key | Default | Meaning |
|---|---|---|
| `listMaxEntries` | `200` | Maximum entries one `list` page returns; the footer reports complete size and composition plus a next offset when more remain. |
| `readLimit` | `2000` | Default and maximum lines returned by one `read` call (the tool schema advertises it as the `limit` default). |
| `readMaxLineLength` | `2000` | Characters kept per line before truncation (the suffix names the cap). |
| `readMaxBytes` | `51200` | Byte cap on one `read` call's selected lines; overflow ends the window with a "capped" footer. |
| `readStreamMinSize` | `10485760` | Files at or above this size (or with unknown size) stream instead of loading whole into memory. |

## Tools (schemas per [the filesystem tool schemas Agent Note](../../../.agents/notes/implemented/feature/2026-06-17-filesystem-tool-schemas.md))

| Tool | Arguments | Behavior |
|---|---|---|
| `list` | `path?`, `offset?` | One page of direct children with their type, defaulting to the session workspace and entry 1. Ordered directories first, then files, then non-regular children, each alphabetical; when more remain, continue from the footer's next offset. |
| `read` | `file_path`, `offset?`, `limit?` | Line-numbered UTF-8 content with a pagination footer. `offset` is 1-based; `limit` defaults to and caps at the configured `readLimit` (2000). |
| `write` | `file_path`, `content` | Create or fully replace a file. With the policy plugin: overwriting an existing file requires a prior `read` at the unchanged version; creating a new file does not. Without it: unconditional. |
| `edit` | `file_path`, non-empty `old_string`, `new_string`, `replace_all?` | Literal replacement; unique match required unless `replace_all` is true. With the policy plugin: requires a prior `read` (any window) and the file unchanged since. Without it: unconditional. |

Field names are snake_case to match Claude Code and existing harness tool schemas.

Canonical successes are `list` → `{ path, offset, entries: [{ name, type }], totalEntries, counts: { directories, files, other } }`, `read` → `{ path, offset, lines: [{ number, text }], totalLines }`, `write` → `{ path, operation: 'create' | 'update', before: string | null, after }`, and `edit` → `{ path, before, after }`. `list.entries` is one bounded page; `type` is `file`, `directory`, or `other`, while its totals describe the complete directory. Native renderers preserve the listing/read envelopes and mutation acknowledgements below. Write/edit derive replayable diff-card metadata from these values; the values themselves are execution-local and are not added to `tool/result`.

## The tool is the executor; policy is an event gate

The tools do **not** inject a policy service or inspect any cache. Each tool resolves the path via `ctx.fs.resolve(path, { cwd, signal })` — passing the calling agent's session cwd (`exec.agent.session.header.cwd`) so a relative path resolves against the session's workspace, matching `dsh-tool-bash`, and forwarding tool cancellation through resolution (see [the per-session cwd Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-fs-per-session-cwd.md)) — then:

- **list** — one `ctx.fs.listDir`; the seam already answers absence with `FS_NOT_FOUND` and a non-directory target with `FS_NOT_DIRECTORY`, so no probe precedes it. No `fs/observed`: a listing reads no file content and must not satisfy the read-before-write gate. (0 stat.)
- **read** — one `ctx.fs.stat` (type + size routing + version), then `readText`/`streamText`, then builds the line window, then emits `fs/observed` with a plain `ctx.emit`. (1 stat.)
- **write** — `ctx.waterfall('fs/write-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.writeText(target, content, intent)`, then `fs/observed`. (0 stat.)
- **edit** — `ctx.waterfall('fs/edit-intent', target, exec, () => undefined)` for the optional guard, then `ctx.fs.editText(target, edit, intent)`, then `fs/observed`. (0 stat.)

The tool passes `exec` (the tool-execution context) as the opaque `actor` on every dispatch. The default thunks return `undefined` (the unconstrained bare provider). When `@deepseek-ai/dsh-fs-policy` is loaded it occupies the single decision slot — returning `createIfAbsent`/`replaceIfVersion`/`{ version }` or throwing `FS_NOT_OBSERVED` — and records on `fs/observed`. Backend errors (`FsError`) and a thrown `FS_NOT_OBSERVED` flow through `ToolRegistry.execute()` and become `isError` tool results with their `{ name, code }` attached.

## `fs/observed` is fire-and-forget

`fs/observed` fires AFTER the read/write/edit already succeeded, via a plain `ctx.emit`. A listener is contractually a synchronous, side-effect-only recorder (`@deepseek-ai/dsh-fs-policy`'s is a `WeakMap.set`); the tool does not guard the emit, so a listener that throws would surface as the tool's `isError` result — async or fallible observation does not belong on this event.

`list` and `read` opt into concurrent scheduling — `list` mutates nothing at all, and `read`'s only mutation is the synchronous version recorder. Recorder races fail closed when a later `write` or `edit` re-checks the version under its target lock; both mutation tools remain exclusive. See the [parallel tool-call Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md).

The package root exports only the Cordis plugin contract (`name`, `inject`, `Config`, and `apply`). Pure presentation lives beside the executors and is independently unit-tested: read windowing and output formatting in `src/read-render.ts`, listing order and envelope in `src/list-render.ts` (both Cordis-free); `src/list.ts`/`read.ts`/`write.ts`/`edit.ts` are the tool executors and `src/index.ts` composes them.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope receives the independently registered list, read, write, and edit guidance below. Scoped tool restrictions can hide schemas without removing these sections.

##### List guidance

```markdown
Use the list tool — not shell ls — to see what a directory contains. It returns the direct children of one directory, files and subdirectories alike, and defaults to the session workspace, so it is the first step for orienting in an unfamiliar project. When a result is capped, continue with the offset named in its footer.
```

##### Read guidance

```markdown
Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.
```

##### Write guidance

```markdown
Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-policy requires it) and prefer edit for targeted changes.
```

##### Edit guidance

```markdown
Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-policy requires it), unless you just created or edited it in this session.
```

#### Token effect

Fixed guidance cost per request while the plugin is active, even when a restriction hides one or more tools.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Tool restrictions do not remove this section, but plugin activation or disposal may invalidate reuse from it.

### Tool schemas

#### What the model sees

The model sees the generated [`list`, `read`, `write`, and `edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs), with snake_case arguments. Scoped tool restrictions can remove any definition for one agent.

#### Token effect

Fixed schema cost on every request in that tool view.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### List result

#### What the model sees

A successful listing is `<path><display path></path>`, newline, `<type>directory</type>`, newline, `<content>`, one line per page entry, a blank line, one footer, and `</content>`. A directory carries a trailing `/`, a non-regular child a trailing `@`, and a regular file neither. A name is emitted verbatim unless it could make the listing say something untrue — a control character, a leading `"`, a backslash, `</`, or a trailing `@` that would collide with the non-regular marker — in which case it becomes a JSON string with `</` neutralized. Ordinary names, which is nearly all of them, stay unquoted. The footer is `(Empty directory)`, `(<n> entries: <d> directories, <f> files)` with optional `, <o> other`, or `(Showing entries <start>-<end> of <n>: <composition>. Use offset=<next> to continue.)`; the final page omits the continuation sentence. Every page states the complete count and composition.

#### Token effect

Listing output and its canonical `entries` page are capped by `listMaxEntries`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Read result

#### What the model sees

A successful read is exactly `<path><displayPath></path>`, newline, `<type>file</type>`, newline, `<content>`, numbered lines as `<lineNumber>: <text>`, a blank line, one footer, and `</content>`. The footer is exactly `(Output capped. Showing lines <start>-<end>. Use offset=<next> to continue.)`, `(Showing lines <start>-<end> of <total>. Use offset=<next> to continue.)`, or `(End of file - total <total> lines)`. A long line ends exactly `... (line truncated to <max> chars)`.

#### Token effect

Read output is capped by `readLimit`, `readMaxLineLength`, and `readMaxBytes`; the retained call and result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Write and edit results

#### What the model sees

Write returns the exact five-line envelope `<path><displayPath></path>`, `<type>file</type>`, `<content>`, `Created file` or `Updated file`, then `</content>`. Edit returns exactly `The file <displayPath> has been updated successfully.` or, for `replace_all`, `The file <displayPath> has been updated. All occurrences were successfully replaced.` The full write or replacement text remains in the assistant tool-call arguments.

#### Token effect

Success text is small, but large mutation arguments and any result are resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>`. This package's stable validation and read messages are `file_path must be a non-empty string`, `path must be a non-empty string when given`, `offset must be a positive integer`, `limit must be less than or equal to <max>`, `old_string must be a non-empty string`, `old_string and new_string must differ`, `cannot read "<path>": not found`, `cannot read "<path>": not a regular file`, `offset <offset> is out of range for "<path>" (<total> entries)`, and the corresponding `<total> lines` read error; provider and policy templates are quoted in their package READMEs.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **`list` reads one directory level** — recursion and per-directory child counts are absent; offset pagination traverses only the current directory's ordered direct children.
- **`read` handles UTF-8 text files only** — binary-safe reads and PDF/image/multimodal content are deferred; a directory target is `FS_NOT_REGULAR_FILE`.
- **No timeout surface** — `list`/`read`/`write`/`edit` take no timeout argument and declare no `timeout-policy` budget; cancellation rides `exec.signal` only (the deliberate [fs-family stance](../README.md)).
