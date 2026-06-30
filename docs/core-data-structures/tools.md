# Tools

The tool pipeline of [dsh-tools](../../packages/core/tools). [core.md](core.md) introduces `ToolDefinition` as the one pipeline-authoring type promoted to the spine and `ToolSchema` as the model-facing wire shape. This page owns the full `ToolDefinition`, the typed schema DSL that builds it, the waterfall execution shapes, and the UI-presentation vocabulary.

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts)

## `ToolDefinition` — a registered tool

A `ToolSchema` (the model-facing fields) plus the `execute` function and optional UI presenters. The registry holds these; the loop dispatches calls through them. The registry's `schemas()` builds the model-facing `ToolSchema[]` by an explicit allowlist — `execute`/`presentCall`/`presentResult` must never leak into a model request.

```ts type-equiv
interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ContentBlock[]>
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived
   * from the call's `args` (parsed arguments, `unknown` — the tool validates/
   * narrows its own input). Returning `undefined` (or omitting the method) tells
   * a UI to fall back to a generic presentation (title = tool name, raw args as
   * input). Pure and side-effect-free: a UI may call it during live streaming
   * AND a session-log replay, so it must depend only on `args`.
   */
  presentCall?(args: unknown): ToolCallPresentation | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * `result` (`execute`'s content + whether it errored). Returning `undefined`
   * (or omitting the method) tells a UI to keep the pending title and render the
   * raw result content. Pure and side-effect-free for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultPresentation | undefined
}
```

`execute` receives `args: unknown` — a raw `ToolDefinition` validates its own input. First-party tools don't write that by hand; they use `defineTool`, which validates and narrows for them.

## The typed schema DSL

Plugin authors write per-property specs with a boolean `required: true`, and a type-level helper maps the spec to the `execute` argument type — zero casts. The DSL is *machinery that types* `ToolDefinition`; it is intentionally a sub-page detail, not core.

Source: [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts)

```ts type-equiv
interface SchemaProp {
  type: SchemaType
  /** Per-property required flag (NOT the JSON Schema top-level required array). */
  required?: true
  /** Human-readable description, surfaced in the JSON Schema as well. */
  description?: string
  /** Enum of allowed values (strings only). */
  enum?: string[]
  /** Default value. */
  default?: unknown
  /** Nested properties for type: 'object'. */
  properties?: SchemaSpec
  /** Items schema for type: 'array'. */
  items?: SchemaProp
}
```

```ts type-equiv
type SchemaSpec = Record<string, SchemaProp>
```

`SchemaType` is the primitive union `'string' | 'number' | 'boolean' | 'object' | 'array'`. `InferArgs<S>` maps a `SchemaSpec` to the TS argument type — `required: true` props become required keys, everything else genuinely optional:

```ts type-equiv
type InferArgs<S extends SchemaSpec> = Simplify<
  & { [K in RequiredKeys<S>]: InferPropValue<S[K]> }
  & { [K in Exclude<keyof S, RequiredKeys<S>>]?: InferPropValue<S[K]> }
>
```

`defineTool({ name, description, parameters, execute, … })` ties it together: `parameters` is a `SchemaSpec`, `execute(args, exec)` gets `args: InferArgs<typeof parameters>`, and the helper converts the spec to JSON Schema (`schemaSpecToJsonSchema`) for the wire and validates model-generated args (`validateArgs`) before the typed body runs. A mismatch throws `ToolArgsError` (`code: 'INVALID_ARGS'`), which the registry turns into an `isError` result so the model can self-correct. Why a custom DSL and not schemastery: tool parameters need JSON Schema (the LLM wire format), not validation/transformation — the lightweight DSL gives the best authoring DX with the smallest surface.

## Execution: the `tools/execute` waterfall shapes

`ctx.tools.execute()` runs each call through a two-waterfall pipeline — `tools/pre-execute` (the allow/deny/ask gate) → core dispatch → `tools/post-execute` (inspect/replace the result, attach context) — the seams where sandbox, permission, hook, and plan-mode plugins gate or transform a call. The pending call is a `ToolExecution`; the outcome is a `ToolExecutionResult`.

```ts type-equiv
interface ToolExecution {
  callId: CallId
  name: string
  /** Parsed JSON arguments (unknown — tools validate their own input). */
  arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  agent?: Agent
  signal?: AbortSignal
}
```

```ts type-equiv
interface ToolExecutionResult {
  callId: CallId
  content: ContentBlock[]
  isError: boolean
  /**
   * Set when the call failed with a {@link HarnessError}: machine-routable
   * `{ name, code }` for retry/sandbox plugins and replay. The model-facing
   * text in `content` is always present; this is extra structure for code.
   */
  error?: ToolErrorInfo
  /**
   * Extra model-facing context a `tools/post-execute` listener attached for the
   * NEXT request (Claude Code's PostToolUse `additionalContext`). It is NOT part
   * of this call's `content` — `content`/`feedback` shape the tool RESULT, but
   * `additionalContext` is a SEPARATE `context/message`. A step can carry
   * multiple tool calls, so the loop BUFFERS every call's `additionalContext`
   * and appends them only AFTER all `tool/result`s for the step, keeping
   * tool-call/result adjacency intact. Carried on the result purely to ferry it
   * from `execute()` up to the loop's per-step buffer.
   */
  additionalContext?: HookContext
}
```

Each interception waterfall returns a typed **Decision** (the idiom shared with the `agent/*` seams). `tools/pre-execute` listeners receive `(exec, next)` and return a `PreToolDecision`; `tools/post-execute` listeners receive `(exec, result, next)` and return a `PostToolDecision`:

```ts type-equiv
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

```ts type-equiv
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContext?: HookContext }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContext?: HookContext }
```

Call `next()` to delegate to the default (allow / accept-unchanged), or return a decision to short-circuit. A `pre-execute` `deny` (or `ask`, which degrades to deny until the permission system lands) skips dispatch and yields an `isError` result; input rewrite is deliberately NOT offered on `PreToolDecision` (it would desync the pre-execution audit/history/UI from what ran — its own proposed RFC). A `post-execute` `accept` may replace the model-facing `content` (clean, because `tool/result` is logged after `execute()` returns); a `block` turns the call into an `isError` whose content is the corrective `feedback`. Core dispatch sits between the waterfalls as plain code; the tool body keeps its own try/catch so a thrown tool still reaches `post-execute` as an `isError`. An unregistered tool routes through the same catch as a tool-thrown error, so both failure classes get a structured `{ name, code }` (`ToolNotFoundError` → `UNKNOWN_TOOL`) — the loop records a failed tool call instead of failing the whole turn.

## Tool-presentation UI vocabulary

How a tool wants its call shown in a UI (an editor tool-call card, a CLI log line), provider-neutral so a tool describes itself without depending on any client protocol. `presentCall` returns a `ToolCallPresentation` (pending state: `title`, `kind`, `rawInput`, `content`, optional `terminal`); `presentResult` returns a `ToolResultPresentation` (completed state: replacement `title`, reformatted `content`, terminal `output`/exit). `ToolCallKind` (`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`) picks an icon. A `ToolTerminal` asks a capable UI to render the call as a terminal card (cwd header, output, exit-status pill).

> These shapes carry a `FIXME(tool-presentation)` in source: they grew incrementally and the call-vs-result terminal split is muddy. Before more tools/UIs depend on them, they will be redesigned (a tagged union over card kinds) and pinned in an RFC, migrating `dsh-tool-bash` and the ACP bridge together. Treat the field-level shapes here as provisional; the source is authoritative.

The full presentation field docs live in [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts). The bash tool's own schemas (`bash`/`bash_output`/`bash_kill`) and the executor they drive are on [bash.md](bash.md).
