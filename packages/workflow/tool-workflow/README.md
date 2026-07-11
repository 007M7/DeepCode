# @deepseek-ai/dsh-tool-workflow

The model-facing **`workflow` tool**: run a JavaScript orchestration script that fans out subagents, and return the script's final value. Pure schema + lifecycle shaping over [`ctx.workflows`](../workflow/README.md) — script parsing, execution, caps, and cancellation live behind the seam, so a hardened engine swaps in without touching what the model sees.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| System prompt and tool schema | The parent model receives a short use-only-for-large-orchestration section plus the `workflow` schema. The schema description carries the complete JavaScript hook and metadata contract; the model submits script, metadata, and optional args. | Substantial but fixed per-request guidance and schema cost while visible. |
| Tool-call history and result | The full model-written script, metadata, and args remain in the assistant tool call. The result contains the workflow name, child count, and final JSON value or a shaped error; intermediate child messages are omitted. | Call tokens can be large and remain until compaction. Result rendering is capped by `maxResultChars`; child-model tokens are separate from the parent's retained context. |

## What the model sees

Three parameters: `script` (required JavaScript body with top-level await and return, but no `export const meta` statement; the tool description carries the complete hooks and semantics contract), `meta` (required plain-JSON identity with name, description, and optional usage and phase guidance), and `args` (optional JSON object exposed as the `args` global; wrap a bare list in a field). The plugin also contributes a `tool:<toolName>` system-prompt section carrying the usage policy — use the tool only on an explicit user ask for a workflow or large orchestration; prefer plain subagent calls for one or two delegations — per the convention that tool guidance ships with the tool plugin, never in the deployment persona.

## Lifecycle

Collection is SYNCHRONOUS this cut (like [`dsh-tool-subagent`](../../subagent/tool-subagent/README.md)): `execute` starts a run and awaits `run.result` inside a `try/finally` that always disposes the run, so the script and its children reach quiescence on every path. `exec.signal` is bridged to `run.cancel()` (including the already-aborted-before-start case). A non-`completed` stop reason maps to an `isError` result reporting the reason — never partial output as success; a parse/meta failure thrown synchronously by `start()` becomes an `isError` the model can correct from. The completed result renders the meta name, the agent count, and the return value as JSON, truncated at `maxResultChars` with an explicit notice.

## Render intent

Decided up front (per the [render-intent RFC](../../../docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md)): a `generic` card titled `workflow: <meta.name>`, the name sniffed TEXTUALLY from `args.script` (presentation must be a pure function of args, so it cannot ask the engine to parse); the script text rides as `rawInput`. The result keeps the generic card.

## Config

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `workflow` | The model-facing tool name to register. |
| `maxResultChars` | `50000` | Rendered-result ceiling; longer JSON is truncated with a notice. |
