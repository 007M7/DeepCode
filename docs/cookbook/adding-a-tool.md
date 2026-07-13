# Cookbook: adding a tool

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
      // exec carries { callId, name, arguments, agent?, signal? }
      return [{ type: 'text', text: await readFile(args.path, 'utf8') }]
    },
  }))
}
```

Registration is effect-based: disposing the plugin fiber unregisters the tool (write the HMR test). Schemas flow into the system-prompt assembly automatically.

## Rules of the execute() contract

- **Args are validated for you.** `defineTool` validates the model-generated `arguments` against the `SchemaSpec` before `execute` runs (type, required keys, enum membership, nested objects/arrays — [runtime arg validation](../rfc/implemented/architecture/2026-06-11-runtime-arg-validation.md)), so inside `execute` the args already match `InferArgs`. You still hand-check value constraints the DSL can't express (non-empty strings, positive numbers, cross-field rules); throw a descriptive Error for those. Raw JSON-Schema tools registered directly (MCP) are NOT validated by the harness — they validate their own input.
- **Throwing means isError.** The registry catches anything `execute()` throws and returns `{isError: true}` to the model. Use that for infrastructure failures (bad input, spawn errors, aborts) — but REPORT domain failures in the result text instead (e.g. tool-bash returns `[exit code: 9]` with `isError: false`: the model decides what a failing command means).
- **Honor `exec.signal`.** Cancel in-flight work when it fires.
- **Attach durable card data with `meta` (optional).** `execute` may return `{ content, meta }` instead of a bare `ContentBlock[]` — `meta` is a JSON-serializable payload the core treats as opaque, persisted on the `tool/result` event and handed back to your `presentResult` (so a card that needs more than `args`, like `write`/`edit`'s applied-hunk diff, survives a session replay). Keep UI-only data here, never in the model-facing `content`.
- **Use `exec.agent` for async notifications.** `agent.inject(content, {source: {kind: 'plugin', plugin: '<name>'}})` appends durable context the NEXT model request sees — it is not a wake-up (an idle agent stays idle). Guard against disposed agents (try/catch).

## Long-running work

Follow tool-bash's background pattern: a `run_in_background` flag returns a task id immediately; companion tools poll incrementally and kill; completion notices arrive via `agent.inject()`. Bound buffers and spill full output to disk so nothing is silently lost.

> TODO: each tool reimplements this background pattern by hand today. At some point we need a generic long-running-tool layer that handles task ids, incremental polling, kill, and completion notices uniformly.

## Permissions / sandboxing

Prefer not to build policy into the tool. The seam is the `tools/pre-execute` gate (deny/ask — see the permission-gate example in [extension-cookbook.md](./extension-cookbook.md)) and the `tools/post-execute` inspect/transform seam, or a sandboxing implementation behind the tool's executor seam.

## Code Mode reaches your tool for free

Under the registry's non-native `mode` ([Code Mode](../../packages/core/tools/README.md)), a registered tool is ALSO callable from a `run_code` program as `await tools.<name>(args)` — nothing to add. The generated SDK declares your parameters from the same JSON Schema `defineTool` emits (constructs outside that subset degrade to `unknown`), each program call re-enters `execute()` through both waterfalls, and a failed call rejects the program-side promise with your error text. Two consequences worth designing for: your `description` and parameter `description`s become JSDoc a model reads while WRITING CODE, and non-text result blocks reach programs as placeholders (text is the lingua franca of the bridge).

## How your tool renders in an editor (ACP presentation)

Your tool's `execute` returns model-facing content; its **editor card** is a separate, optional concern you declare with two pure display methods on the `defineTool` options. Design this alongside `execute`, not after — an editor (Zed, over the ACP bridge) shows the card, and a tool with no presentation falls back to a bland generic card (title = tool name, raw args as input).

Both methods return a **`card`-tagged render intent** — pick the card kind that matches what your tool does:

- `presentCall(args)` → a `ToolCallView` (the PENDING card):
  - `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — the default. Set `kind` for an icon (`read`/`search`/…); set `locations: [{ path, line? }]` for any file your tool touches so a capable editor follows along / jumps to it.
  - `{ card: 'terminal', title, description?, cwd? }` — your call IS a shell command. `title` is the command, `description` renders above the terminal card. (tool-bash.)
  - `{ card: 'diff', title, diffs, locations? }` — your call creates or modifies a file. `diffs: [{ path, oldText, newText }]` (`oldText: null` for a new file) renders as an inline diff card. (tool-fs `write`/`edit`.)
- `presentResult(args, { content, isError, meta? })` → a `ToolResultView` (the COMPLETED card): `{ card: 'generic', title?, content? }`, `{ card: 'terminal', title?, output?, exitCode?, signal? }` (the run's captured output + exit — the bridge shows an exit pill and derives a fenced ` ```console ` fallback for editors without the terminal capability), or `{ card: 'diff', title?, diffs }` (a completed file mutation — the applied hunks computed from the before/after content when there is a before-image, else a whole-file diff for a create; `write`/`edit` attach the hunks via the `meta` channel and read them back here). A mutation tool returns the `diff` result even when it duplicates the call-time card, because an ACP `tool_call_update.content` REPLACES the call's content — a non-diff result would clobber the pending diff. `result.meta` is your tool's own optional presentation payload, attached from `execute` (see below) and persisted so a replay reproduces the card.

Hard rules (they bite if broken):

- **Purity.** These run on live streaming AND on session-log REPLAY, so they must be pure functions of `args` (+ the result) — NO I/O, NO reading session state, NO clock/random. A diff is derived from the args (`write` uses `oldText: null` because a call-time presenter has no prior file content); the BRIDGE, not the tool, fills the session cwd and relativizes a display-path title. If you find yourself wanting the file's old content or the working directory inside `presentCall`, stop — that belongs on the bridge or a future result-event shape, not the presenter.
- **UI-only formatting stays out of the model result.** A fenced ` ```console ` block, a diff, a relativized path — none of these may appear in what `execute` returns to the model; they live only in the presentation. (A `terminal` result view carries RAW `output`; the bridge adds the fences.)
- **`defineTool` soft-validates the display path.** A malformed/older logged arg shape makes the wrapper return `undefined` (a generic fallback) rather than throw — display must never crash a replay.

The neutral vocabulary lives in `dsh-tools` (never import an ACP type into a tool); the ACP bridge maps each `card` to the wire. The design and the why are in [the render-intent-union RFC](../rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md); `dsh-tool-fs` (generic/diff) and `dsh-tool-bash` (terminal) are the reference implementations.

## Tests every tool needs

Arg-validation rejections, result shaping for every outcome, the HMR disposal test, and — for tools with side effects — an integration spec that drives the tool through the agent loop with a scripted `MockAdapter` (`packages/core/agent-loop/tests/mock-adapter.ts`), asserting the `tool/call` / `tool/result` session events. **If your tool has an editor card, also add:** a unit test on `presentCall`/`presentResult` asserting the exact view shape, AND — because a unit test proves the shape but not that an editor renders it — a **snapshot scenario** under `examples/acp-agent/tests/snapshots/` that drives the real tool through the ACP bridge and pins the rendered `tool_call` transcript (the card kind is only verified end-to-end there; see the [ACP snapshot-tests RFC](../rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md)). A tool whose card is a `terminal` needs a scenario whose `input.json` sets `terminalOutput: true` to exercise the capable-client `_meta` path.
