# RFC: Filesystem tool schemas — model-facing read/write/edit shapes

Status: implemented

## Problem

[The filesystem capability-seam RFC](../architecture/2026-06-17-filesystem-capability-seam.md) defines the filesystem capability seam (`ctx.fs`), the three-package split (`dsh-fs`, `dsh-fs-local`, `dsh-tool-fs`), and the observed-file/stale-version policy for read-before-write/edit checks. The remaining decision for the first filesystem tool delivery is the model-facing schema surface: what arguments the model sees for `read`, `write`, and `edit`.

The schema should be small enough to implement in the first `dsh-tool-fs` pass, but stable enough that future local/remote/sandboxed filesystem backends do not require model-facing churn. It should also avoid importing every option from reference systems. Claude Code and OpenCode expose similar core file tools but differ in naming style and extra flags; this RFC chooses the minimal shared surface for the prototype.

## Proposal

`@deepseek-ai/dsh-tool-fs` exposes these three model-facing tools in the first filesystem suite:

| Tool | Our schema | Claude Code | OpenCode | Notes | Part of prototype |
|---|---|---|---|---|---|
| `read` | `read(file_path, offset?, limit?)` | `Read(file_path, offset?, limit?, pages?)` | `read(filePath, offset?, limit?)` | Files only; 1-indexed `offset`; no image/PDF/multimodal support in the first pass. | YES |
| `write` | `write(file_path, content)` | `Write(file_path, content)` | `write(content, filePath)` | Creates or overwrites UTF-8 text. Updates to existing files require prior observation through `ctx.fs`; new-file creates do not. | YES |
| `edit` | `edit(file_path, old_string, new_string, replace_all?)` | `Edit(file_path, old_string, new_string, replace_all?)` | `edit(filePath, oldString, newString, replaceAll?)` | Literal string replacement; unique match required by default; requires prior full observation through `ctx.fs`. | YES |

The schema uses snake_case field names (`file_path`, `old_string`, `new_string`, `replace_all`) to align with Claude Code and with existing DeepSeek Harness tool-schema examples. The consumer package translates these model-facing names into internal `ctx.fs` requests.

## Tool schemas

### `read`

`read` inspects a UTF-8 text file and returns line-numbered content.

Arguments:

- `file_path: string` — required. Path to read, resolved by `ctx.fs`.
- `offset?: number` — optional. 1-based first line to return. Defaults to the first line.
- `limit?: number` — optional. Maximum number of lines to return. Defaults and caps are implementation details of `dsh-tool-fs` / `ctx.fs`.

Non-goals for the first pass:

- No PDF `pages` argument.
- No image or multimodal file reads.
- No directory listing through `read`; if needed, listing becomes a separate future tool.

### `write`

`write` creates or fully replaces a UTF-8 text file.

Arguments:

- `file_path: string` — required. Path to write, resolved by `ctx.fs`.
- `content: string` — required. Full UTF-8 text content to write.

For existing files, `write` requires prior full file state derived from a previous read in the same execution context. `ctx.fs` derives the file-state owner and uses the recorded version as the stale guard. Creating a new file does not require prior state or an owner.

The schema does not expose `expected_hash`, `expected_version`, or `create_only` as model-facing parameters. Stale-version checks are driven by `ctx.fs` file state and backend-produced versions, not by asking the model to copy version tokens through the schema.

### `edit`

`edit` updates an existing UTF-8 text file by replacing literal text.

Arguments:

- `file_path: string` — required. Path to edit, resolved by `ctx.fs`.
- `old_string: string` — required. Literal text to replace. Empty strings are invalid in the first pass.
- `new_string: string` — required. Literal replacement text; an empty string deletes the match.
- `replace_all?: boolean` — optional. Defaults to false. When false, `old_string` must identify exactly one match.

`edit` requires a prior observation of the file in the same execution context (any windowed read counts — authorization is version freshness, not a full-view requirement), or a prior write/edit by that context. The `dsh-file-context` policy plugin derives the owner and supplies the recorded version as the stale guard; the provider's mutation lock enforces it.

The first pass rejects Codex-style patch grammars and multi-mode edit APIs. It uses one strict literal replacement mode so the model-facing contract stays simple and the backend can own exact-match, duplicate-match, line-ending, and stale-version semantics.

## Result shape

The first implementation returns `ContentBlock[]` through the existing `ToolDefinition.execute()` contract. `ctx.fs` returns structured filesystem results and owns file-state recording/refreshing; `tool-fs` formats those results into the model projection.

Default native projections:

| Tool | Structured `ctx.fs` outcome consumed by `tool-fs` | Default model projection |
|---|---|---|
| `read` | returned lines, returned line count, total line count, target display path, file version, partial-view flag | line-numbered text plus pagination footer |
| `write` | create/update operation, target display path, new file version | concise create/update success text |
| `edit` | replacement count, replace-all flag, target display path, new file version | concise edit success text |

The structured outcome should not restate model arguments such as `file_path`, `old_string`, or `content` unless the backend has resolved them into new information such as `displayPath`, `targetKey`, or a new version. Token-conscious truncation is part of the model projection, not the backend's canonical result.

## Deferred

The following are deliberately out of scope for the first filesystem schema pass:

- Model-facing `expected_hash`, `expected_version`, or `create_only` parameters.
- Directory listing, glob, grep, and search tools.
- Binary-safe read/write operations.
- PDF/image/multimodal `read`.
- Code Mode projection values for filesystem tools.
- A canonical edit diff format.

## Tests

`dsh-tool-fs` schema tests should assert:

- `read` requires `file_path` and accepts optional positive integer `offset` / `limit`.
- `write` requires `file_path` and `content`.
- `edit` requires `file_path`, `old_string`, and `new_string`, accepts optional boolean `replace_all`, rejects empty `old_string`, and defaults `replace_all` to false.
- The registered JSON schemas use the snake_case field names in this RFC.
- The tool descriptions accurately describe that existing-file `write` and `edit` require a prior full read in the same execution context, while new-file `write` does not.
- The root plugin and subpath plugins register the same schemas.

Integration tests should execute `read`, `write`, and `edit` through `ctx.tools.execute()` with a fake or local `ctx.fs` provider and verify that model arguments are translated into the expected `ctx.fs` calls.

## Risks

**The first schema is intentionally smaller than Claude Code's.** Dropping PDF pages, multimodal read, rich grep/list flags, and expected hash fields keeps the first implementation focused, but users may ask for those quickly. They should be added as separate RFCs or focused follow-ups rather than overloaded into the initial schema.

**No explicit model-facing stale guard in v1.** The schema does not ask the model to provide an expected hash/version. That is intentional: stale checks come from backend-produced versions and `ctx.fs` observed-file state, not from fragile model-copied tokens. Filesystem safety failures surface through structured `FsError` codes owned by `dsh-fs`, not through model-supplied version fields.

**Naming becomes public surface.** Once shipped, changing `file_path` to `filePath` or `old_string` to `oldString` would churn prompts, examples, and downstream clients. This RFC chooses snake_case up front and treats it as the stable model-facing contract.
