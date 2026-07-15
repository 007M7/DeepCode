# Cookbook: adding a tool

English | [中文](adding-a-tool.zh.md)

How to give the model a new capability. Reference implementations: `examples/echo-agent/src/echo-tool.ts` (minimal) and `packages/bash/tool-bash` (production-grade, three-package seam).

## The minimal shape

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'read_file',
    description: 'Read a file from disk.',          // what the model sees
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path' },
      limit: { type: 'number' },                     // optional by default
    },
    async execute(args, exec) {
      // args is TYPED from the schema: { path: string; limit?: number }
      // exec carries immutable identity + token; signal is the operational field
      return [{ type: 'text', text: await readFile(args.path, 'utf8') }]
    },
  }))
}
```

Registration is effect-based: disposing the plugin fiber unregisters the tool (write the HMR test). Schemas flow into the system-prompt assembly automatically.

## Rules of the execute() contract

- **Args are validated for you.** `defineTool` validates the model-generated `arguments` against the `SchemaSpec` before `execute` runs (type, required keys, enum membership, nested objects/arrays — [runtime arg validation](../rfc/implemented/architecture/2026-06-11-runtime-arg-validation.md)), so inside `execute` the args already match `InferArgs`. You still hand-check value constraints the DSL can't express (non-empty strings, positive numbers, cross-field rules); throw a descriptive Error for those. Raw JSON-Schema tools registered directly (MCP) are NOT validated by the harness — they validate their own input.
- **Registration borrows your readonly definition.** A typed same-process contribution is not a serialization boundary; do not mutate its schema or replace callbacks after registration. `schemas()` materializes only the explicit model-facing projection. To hot-swap a tool, dispose its owning effect and register the replacement; mutable state inside the callback's closure remains ordinary plugin state.
- **Execution identity is protected.** The registry materializes `arguments` as detached lossless JSON in one recursive pass, freezes that value before policy starts, and assigns an opaque `exec.token`; `callId`, `name`, `arguments`, `agent`, `token`, and an optional enclosing-transport `parent` token stay immutable through dispatch. `parent` is identity-only and exposes no live outer execution. Treat `args` as readonly input. An around-dispatch wrapper may add, replace, or remove only `exec.signal` to impose cancellation or a deadline.
- **Throwing or returning non-JSON data means `isError`.** The registry catches throws and materializes the final result before observers run. A malformed or non-JSON result becomes `{ isError: true }`, preventing a live success that cannot be logged. Throw for infrastructure failures; report domain failures in result text when the model must interpret them.
- **Honor `exec.signal`.** Cancel in-flight work when it fires.
- **Attach durable card data with `meta` (optional).** `execute` may return `{ content, meta }` instead of a bare `ContentBlock[]` — `meta` is a JSON-serializable payload the core treats as opaque, persisted on the `tool/result` event and handed back to your `presentResult` (so a card that needs more than `args`, like `write`/`edit`'s applied-hunk diff, survives a session replay). Keep UI-only data here, never in the model-facing `content`.
- **Use `exec.agent` for async notifications.** `agent.inject(content, {source: {kind: 'plugin', plugin: '<name>'}})` appends durable context the NEXT model request sees — it is not a wake-up (an idle agent stays idle). Guard against disposed agents (try/catch).

## Long-running work

Gate `run_in_background` with producer config, reject a pre-aborted call, then register through `ctx.tasks.start({ kind, label, owner: exec.agent, run })`. The runtime validates ownership and control-surface availability before `run()` starts work, then supplies the id, session fence, generic control tools, notices, and owner cleanup.

The producer supplies synchronous `cancel`, non-rejecting `done` that settles after resource cleanup, and optional consuming `readOutput` with bounded-output formatting. Once the id is returned, use a task-owned cancellation signal rather than `exec.signal`. See the [background task runtime RFC](../rfc/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.md) and `dsh-tool-bash` for a stream producer.

## Execution policy and observation

Prefer not to build deployment policy into the tool. Use `tools/pre-execute` for extensible allow/deny/ask policy (the [permission-gate example](./extension-cookbook.md#a-hook-plugin-permission-gate-example)), `ctx.tools.guard()` for a final monotonic deny that later listeners cannot undo, `tools/execute` to wrap core dispatch with a deadline/retry/metrics scope, `tools/post-execute` to transform or attach model-facing context, and `tools/result` to observe the immutable normalized outcome without changing it. A sandboxing implementation can also sit behind the tool's executor capability seam; the exact contracts are in the [`dsh-tools` README](../../packages/core/tools/README.md#extension-points).

## Code Mode reaches your tool for free

In [Code Mode](../../packages/core/tools/README.md), every visible registered tool is available as `await tools.<name>(args)` without extra integration. The SDK derives parameters from the same JSON Schema, and calls re-enter the normal execution pipeline. Write descriptions as model-facing API docs; non-text result blocks become placeholders in programs.

## How your tool renders in an editor (ACP presentation)

Your tool's `execute` returns model-facing content; its **editor card** is a separate, optional concern you declare with two pure display methods on the `defineTool` options. Design this alongside `execute`, not after — an editor (Zed, over the ACP bridge) shows the card, and a tool with no presentation falls back to a bland generic card (title = tool name, raw args as input).

Both methods return a **`card`-tagged render intent** — pick the card kind that matches what your tool does:

- `presentCall(args)` → a `ToolCallView` (the PENDING card):
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — the default. Set `kind` for an icon (`read`/`search`/…); set `locations: [{ path, line? }]` for any file your tool touches so a capable editor follows along / jumps to it.
  - `{ card: 'terminal', title, description?, cwd? }` — your call IS a shell command. `title` is the command, `description` renders above the terminal card. (tool-bash.)
  - `{ card: 'diff', title, diffs, locations? }` — your call creates or modifies a file. `diffs: [{ path, oldText, newText }]` (`oldText: null` for a new file) renders as an inline diff card. (tool-fs `write`/`edit`.)
- `presentResult(args, { content, isError, meta? })` returns the completed card:
  - `generic` supplies an optional title and content.
  - `terminal` supplies raw output and optional exit metadata; the bridge renders the capability-specific or fenced fallback view.
  - `diff` supplies applied hunks, often carried in persisted `result.meta` so replay reproduces them. Mutation tools keep a diff result because an ACP update replaces the pending card's content.

Hard rules (they bite if broken):

- **Purity.** These run on live streaming AND on session-log REPLAY, so they must be pure functions of `args` (+ the result) — NO I/O, NO reading session state, NO clock/random. A diff is derived from the args (`write` uses `oldText: null` because a call-time presenter has no prior file content); the BRIDGE, not the tool, fills the session cwd and relativizes a display-path title. If you find yourself wanting the file's old content or the working directory inside `presentCall`, stop — that belongs on the bridge or a future result-event shape, not the presenter.
- **UI-only formatting stays out of the model result.** A fenced ` ```console ` block, a diff, a relativized path — none of these may appear in what `execute` returns to the model; they live only in the presentation. (A `terminal` result view carries RAW `output`; the bridge adds the fences.)
- **`defineTool` soft-validates the display path.** A malformed/older logged arg shape makes the wrapper return `undefined` (a generic fallback) rather than throw — display must never crash a replay.

The neutral vocabulary lives in `dsh-tools` (never import an ACP type into a tool); the ACP bridge maps each `card` to the wire. The design and the why are in [the render-intent-union RFC](../rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md); `dsh-tool-fs` (generic/diff) and `dsh-tool-bash` (terminal) are the reference implementations.

## Tests every tool needs

Cover argument rejection, every result shape, and HMR disposal. For a side-effecting tool, drive the real tool through the agent loop with a scripted `MockAdapter` and assert its `tool/call` and `tool/result` session events. For an editor card, assert the exact `presentCall` and `presentResult` views and add an [ACP snapshot](../rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md) through the real bridge; a terminal card's scenario sets `terminalOutput: true` to exercise the capable-client path.
