# dsh-tools

Tool registry and execution waterfall. Tool plugins register their schemas and executors; the agent loop executes calls through the `tools/execute` waterfall.

## Service: `ToolRegistry` (ctx key: `tools`)

### Public API

- `ctx.tools.register(definition: ToolDefinition): () => void` Register a tool. Disposed with the calling fiber.
- `ctx.tools.get(name: string): ToolDefinition | undefined`
- `ctx.tools.schemas(): ToolSchema[]` Schemas of all registered tools (without the `execute` functions).
- `ctx.tools.execute(exec: ToolExecution): Promise<ToolExecutionResult>` Execute one tool call through the `tools/execute` waterfall.

### Injected services

`SystemPrompt` — the registry automatically feeds its tool schemas into the system-prompt assembly via `ctx.systemPrompt.tools()`.

### Events

| Event | Mode | Purpose |
|---|---|---|
| `tools/execute` | waterfall | Wrap/veto tool execution (sandbox, permission, hooks, plan mode) |
| `tools/change` | emit | A tool was registered or unregistered |

### Key types

- `ToolDefinition` — `ToolSchema` + `execute(args, exec): Promise<ContentBlock[]>`.
- `ToolExecution` — one pending tool call: `{ callId, name, arguments, agent?, signal? }`.
- `ToolExecutionResult` — outcome: `{ callId, content, isError, error? }`. On failure with a `HarnessError`, `error: { name, code }` carries the structured failure class alongside the model-facing text (the loop forwards it onto the `tool/result` session event for retry/sandbox plugins and replay).

### Extension points

- Tool plugins call `ctx.tools.register()` — schemas flow into the assembly automatically.
- The `tools/execute` waterfall is the single seam for sandbox, permission, hooks, and plan-mode plugins to wrap or veto a call. Listeners receive `(exec, next)`: call `next()` to proceed, or return a result without calling `next()` to short-circuit (veto).
- MCP servers: one plugin per server, discover tools, call `ctx.tools.register()` with the server's schemas.

### Typed tool parameter schemas

First-party plugin authors can use the `defineTool()` helper (exported from this package) for typed tool parameter schemas:

```ts
import { readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare const ctx: Context

ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: {
    path: { type: 'string', required: true, description: 'Absolute file path' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
  async execute(args, exec) {
    // args is typed: { path: string; offset?: number; limit?: number }
    const text = await readFile(args.path, 'utf8')
    return [{ type: 'text', text }]
  },
}))
```

The helper converts the author-facing `SchemaSpec` (with `required: true` as a per-property boolean) to standard JSON Schema for the wire format. Raw JSON-Schema tool definitions (from MCP servers) are still accepted by the registry directly.

A `defineTool` tool also **validates the model-generated arguments against its `SchemaSpec` before `execute` runs** (`validateArgs`). The model's JSON is untrusted — `InferArgs<S>` is a compile-time claim, not a runtime guarantee — so on a mismatch (missing required key, wrong primitive, bad enum member, nested violation) the tool throws a `ToolArgsError` (`code: 'INVALID_ARGS'`); the registry turns it into an `isError` result whose text lists the violations, which the model sees and self-corrects from. Validation mirrors the JSON Schema conversion exactly: extra keys are allowed, `default` is not applied, and an `object`/`array` prop without `properties`/`items` only type-checks. Raw-registered tools (MCP) are **not** validated by the harness — they validate their own input.

See `defineTool`, `validateArgs`, `ToolArgsError`, `SchemaSpec`, `InferArgs`, and `schemaSpecToJsonSchema` in the public API for details.

### What is NOT here (TODO)

- **Tool shapes review** — when real tools land (e.g. a concurrency-safety hint for parallel execution); phase 1 executes tool calls sequentially.
- **Parallel execution** — the loop currently iterates tool calls sequentially.
