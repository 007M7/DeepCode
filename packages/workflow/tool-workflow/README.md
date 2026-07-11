# @deepseek-ai/dsh-tool-workflow

The model-facing **`workflow` tool**: run a JavaScript orchestration script that fans out subagents, and return the script's final value. Pure schema + lifecycle shaping over [`ctx.workflows`](../workflow/README.md) — script parsing, execution, caps, and cancellation live behind the seam, so a hardened engine swaps in without touching what the model sees.

## What the model sees

Two parameters: `script` (required — the full `export const meta = {...}` + body text; the tool DESCRIPTION carries the complete authoring contract: hooks, semantics, the supported schema subset) and `args` (optional JSON object exposed to the script as the `args` global; a bare list is wrapped as a field, a deliberate deviation from Claude Code's any-JSON `args` so the wire schema stays honest). The plugin also contributes a `tool:<toolName>` system-prompt section carrying the usage policy — use the tool only on an explicit user ask for a workflow / large orchestration; prefer plain subagent calls for one or two delegations — per the convention that tool guidance ships with the tool plugin, never in the deployment persona.

## Lifecycle

Collection is SYNCHRONOUS this cut (like [`dsh-tool-subagent`](../../subagent/tool-subagent/README.md)): `execute` starts a run and awaits `run.result` inside a `try/finally` that always disposes the run, so the script and its children reach quiescence on every path. `exec.signal` is bridged to `run.cancel()` (including the already-aborted-before-start case). A non-`completed` stop reason maps to an `isError` result reporting the reason — never partial output as success; a parse/meta failure thrown synchronously by `start()` becomes an `isError` the model can correct from. The completed result renders the meta name, the agent count, and the return value as JSON, truncated at `maxResultChars` with an explicit notice.

## Render intent

Decided up front (per the [render-intent RFC](../../../docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md)): a `generic` card titled `workflow: <meta.name>`, the name sniffed TEXTUALLY from `args.script` (presentation must be a pure function of args, so it cannot ask the engine to parse); the script text rides as `rawInput`. The result keeps the generic card.

## Config

| Key | Default | Meaning |
|---|---|---|
| `toolName` | `workflow` | The model-facing tool name to register. |
| `maxResultChars` | `50000` | Rendered-result ceiling; longer JSON is truncated with a notice. |
