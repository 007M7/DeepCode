# @deepseek-ai/dsh-tool-fs-search

The **model-facing filesystem discovery tools**—`glob`, `grep`—are backed by the **bash executor seam**, not by `ctx.fs` provider methods. At load, the package probes `command -v rg` through `ctx.bash`; if the executor cannot find ripgrep on its `PATH`, it logs a warning and registers no tools or prompt sections. Each call assembles a fixed ripgrep command (every model-controlled value through one package-private shell-quoting helper), runs it via `ctx.bash.resolve(request)` → `ctx.bash.run(spec)` as an ordinary foreground tool call, parses the raw `rg` output, and returns a workdir-relative canonical value. The package injects `tools`, `systemPrompt`, and `bash`—deliberately **not** `fs`; `ctx.spillStore` is read opportunistically with `ctx.get()` because formatted-result spill is optional.

```ts ignore-check
// Default deployment: a bash executor whose PATH includes rg, then the discovery tools.
await ctx.plugin(LocalBashExecutor, { cwd: process.cwd() }) // @deepseek-ai/dsh-bash-local
await ctx.plugin(ToolFsSearch)                              // this package — conditionally registers glob/grep
// Optional: a spill backend makes capped results fully recoverable.
await ctx.plugin(LocalSpillStore)                           // @deepseek-ai/dsh-spill-local
```

Why bash-backed: local workspace discovery is naturally a process-backed `rg` workflow, and putting search on `ctx.fs` would force every filesystem backend to grow a search API. The bash executor owns request defaulting/capping, subprocess execution, process-group termination, environment scrubbing, raw output capture, and backend substitution (local, sandboxed, remote); this package owns schemas, argument validation, shell quoting, parsing, retention, formatted-result spill, and timeout declaration. The tools never call `ctx.bash.start()` and never expose a bash task id — the call returns only after `rg` exits, times out, is aborted, or fails.

## Deployment requirement: rg + co-located bash/filesystem

The mounted bash executor must be able to resolve `rg` from its `PATH` at plugin load; otherwise `glob` and `grep` are absent from the model-visible tool schema. Returned paths are displayed relative to the resolved bash workdir (the calling agent's session cwd when present, else the executor's configured default) and are follow-up-readable with `read` only when the bash workdir and the filesystem root are the same workspace. v1 documents that co-location requirement and performs no runtime cross-service validation; remote or virtual filesystem search waits for a shared workspace contract or a provider-specific search backend.

## Config

All keys are optional; the defaults are the shipped search caps.

| Key | Default | Meaning |
|---|---|---|
| `globMaxResults` | `100` | Max paths one `glob` call retains inline (matches Claude Code's `GlobTool` limit); later paths go to the formatted spill artifact. |
| `grepMaxMatches` | `250` | Max flat matches one `grep` call retains inline (matches Claude Code's `GrepTool` `head_limit`); later matches go to the formatted spill artifact. |
| `grepMaxLineBytes` | `2000` | Byte cap per matched-line preview; the cut preserves UTF-8 boundaries and is marked `(line truncated)`. |
| `rawOutputMaxBytes` | `20000000` | Max complete raw `rg` stdout a search will parse (matches Claude Code's ripgrep raw buffer); larger raw output fails with `SEARCH_RAW_OUTPUT_OVERFLOW`. |
| `timeoutMs` | `30000` | Cooperative tool-call budget attached to both tool definitions, enforced by `@deepseek-ai/dsh-timeout-policy` through `exec.signal`; the bash backend's own timeout stays a second safety cap. |

## Tools

| Tool | Arguments | Behavior |
|---|---|---|
| `glob` | `pattern`, `path?` | `rg --files --glob <pattern> --sort=modified --no-ignore --hidden` plus VCS metadata excludes (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`). `path` is an optional **directory** search root; omitted means the resolved bash workdir. Returns one path per line, modification-time ordered. |
| `grep` | `pattern`, `path?`, `include?` | Line-oriented `rg --json` parse (no colon-splitting ambiguity). `pattern` is a ripgrep regex; `path` is an optional **file or directory** target; `include` is ONE positive glob filter — a comma-separated list or a negated (`!…`) value is rejected up front (brace alternation like `*.{ts,tsx}` is fine). Returns matches grouped by file as `Line N: <preview>`. |

Routine budgets stay out of the model-facing schema (no `head_limit`/`offset`/`case_insensitive`/output modes): a model that needs surrounding context reads the matched file with `read`; one that needs later results follows the returned spill locator's retrieval hint.

## Two budgets, two artifacts

Raw `rg` stdout is an internal transport detail. Each search requests `stdoutMaxBytes: rawOutputMaxBytes` from the bash seam and parses only complete retained stdout; if the executor still returns `stdout.truncated`, the search fails with `SEARCH_RAW_OUTPUT_OVERFLOW` and tells the model to narrow the query. A successful `glob` keeps every acquired path in `{ paths }`; `grep` keeps every acquired `{ path, lineNumber, line }` in `{ matches }`. Inline item and per-line preview caps apply only in the Native renderer. For a direct surface call with more logical results than the inline cap, post-policy best-effort saves the complete formatted preview through `ctx.spillStore.saveText()` and replaces only presentation with a head page plus locator. Nested Code dispatches skip that spill because their full canonical value does not enter model context. Missing/failed spill keeps the inline page and reports that the complete result could not be saved—never an `isError`.

## Errors

Search failures carry the package-owned `SearchError` (a `HarnessError` subclass), surfaced as `{ name, code }` on `isError` results: `SEARCH_INVALID_PATTERN` (ripgrep rejected the regex/glob), `SEARCH_FAILED` (runtime `rg` disappearance after registration, inaccessible target, signal kill, malformed `--json` output), `SEARCH_RAW_OUTPUT_OVERFLOW` (raw output over `rawOutputMaxBytes`, or still truncated after the requested stdout capture budget), and `SEARCH_ABORTED` (tool timeout, caller cancellation, or the bash executor's own timeout). ripgrep exit semantics are tool-owned: exit 0 is success with results, exit 1 is a successful empty search (`No files found` / `No matches found`), and only other exits are failures. Model argument mistakes (blank pattern, a list-valued `include`) stay ordinary tool argument errors.

## Model Experience

### System prompt

#### What the model sees

After the load-time `rg` probe succeeds, every request in this plugin's registration scope contains the independently registered glob and grep guidance below. Agent-scoped tool restrictions can hide either schema without removing its prompt section.

##### Glob guidance

```markdown
Use the glob tool — not shell find or ls — to discover files by path pattern. Results are sorted by modification time and include hidden and ignored files.
```

##### Grep guidance

```markdown
Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
```

#### Token effect

Fixed guidance cost per request while the tools are registered.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The generated [`glob` and `grep` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-fs-search) after the load-time `rg` probe succeeds and while this surface is visible.

#### Token effect

Fixed schema cost on every request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results and spill notices

#### What the model sees

`glob` returns one path per line; `grep` groups `Line <line>: <preview>` matches beneath each path. Empty searches return `No files found` or `No matches found`. A capped result ends with its omission count plus the spill locator and backend retrieval hint, or says the complete result could not be saved.

#### Token effect

Inline paths and matches are bounded by `globMaxResults`, `grepMaxMatches`, and `grepMaxLineBytes`; the call and retained result remain in history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Tool errors

#### What the model sees

Failures are normalized as `Error: <message>` with structured `SEARCH_INVALID_PATTERN`, `SEARCH_FAILED`, `SEARCH_RAW_OUTPUT_OVERFLOW`, or `SEARCH_ABORTED` metadata for callers.

#### Token effect

Only a failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Search and file access have no shared-workspace proof** — returned paths are follow-up-readable only when the bash workdir and filesystem root denote the same workspace; the package performs no runtime cross-service validation.
- **Ripgrep is a deployment dependency** — a missing `rg` executable makes the package register no tools or guidance; an incompatible executable or one that disappears after registration fails calls with `SEARCH_FAILED`. Remote or virtual filesystems need a co-located executor or another search consumer.
- **The schemas expose one bounded page** — offset pagination, case-mode switches, alternate output modes, and provider-backed discovery remain outside this package; capped complete output requires a spill backend.
