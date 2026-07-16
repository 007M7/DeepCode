# @deepseek-ai/dsh-tool-lsp

The model-facing **`lsp` tool** over `ctx.lsp`: one read-only tool with four operations for precise code navigation. It owns the model schema, prompt guidance, coordinate conversion, result limits and formatting, and ACP presentation; it imports no provider.

Namespace plugin (`name` / `inject` / `Config` / `apply`, no default export). Injects `tools`, `lsp`, and `systemPrompt`.

## The tool

`lsp` accepts `operation` (`definition` | `references` | `implementation` | `hover`), `file_path`, `line`, and `character`. `line` and `character` are positive, one-based UTF-16 cursor coordinates; the tool converts them to the seam's zero-based positions and converts rendered locations back. `references` includes declarations so impact analysis does not omit the defining site. Provider, language id, workspace root, limits, timeout, initialization, and executable stay outside model input.

The tool requires the workspace root from the session `header.cwd`, with no fallback: absence fails as `LSP_WORKSPACE_REQUIRED` before querying. Locations render as stable, file-grouped `path:line:character` entries relativized against the result's `resolvedWorkspaceRoot` (the provider's canonical root), not the session cwd — so a symlinked cwd still renders in-workspace results as workspace-relative paths; a `file:` URI becomes a workspace-relative path (inside) or absolute path (outside), and any other URI stays verbatim. Empty locations and `null` hover are successful no-result responses; malformed provider payloads remain structured errors.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxLocations` | `100` | Largest number of rendered locations before an omission marker. |
| `maxHoverChars` | `16000` | Largest hover length in characters, applied after normalization. |
| `timeoutMs` | `60000` | Tool-call timeout budget, enforced by `dsh-timeout-policy`; covers the complete queued open/query/close lifecycle and is not model-configurable. |

## Model Experience

### Prompt guidance

**What the model sees**: One system-prompt section (order 112) positioning LSP as a precision aid, plus the tool schema below.

**Token effect**: Fixed — the verbatim prose below is contributed once per request while the tool is enabled.

#### Verbatim text for this context surface

```markdown
Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. references always includes the declaration.
```

### Tool schema

**What the model sees**: The model sees the generated [`lsp` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp).

**Token effect**: Fixed per request while enabled; the `timeoutMs` budget is never sent to the model.

### Results

**What the model sees**: File-grouped `path:line:character` location lines, or normalized hover text; capped by `maxLocations` / `maxHoverChars` with an omission marker when truncated, and distinct `No results.` / `No hover information.` lines for empty results.

**Token effect**: Capped by the two limits above.

### ACP presentation

**What the model sees**: A generic search card — `{ card: 'generic', kind: 'search', title, locations: [{ path, line }] }` — whose args-derived title carries the operation and one-based cursor; follow-along focuses the queried line while the title preserves the column. Rendered by the client, not sent to the model.

**Token effect**: Zero direct token effect (client-side rendering only).

## Known Limitations and Deferred Work

- **UTF-16 cursor coordinates** — columns are exact for the protocol but hard for a model to count around non-BMP characters; an off-symbol position may return empty results, so the prompt explains the convention without encouraging broad LSP use ([seam RFC](../../../docs/rfc/implemented/architecture/2026-07-15-lsp-capability-seam.md)).
- **No cross-server completeness promise** — supported servers may return empty or partial results depending on indexing readiness; the tool promises no completeness across languages or servers.
