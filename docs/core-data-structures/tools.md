# Tools

The tool pipeline of [dsh-tools](../../packages/tools). [core.md](core.md) introduces `ToolDefinition` as the one pipeline-authoring type promoted to the spine and `ToolSchema` as the model-facing wire shape. This page owns the full `ToolDefinition`, the typed schema DSL that builds it, the waterfall execution shapes, and the UI-presentation vocabulary.

Source: [`packages/tools/src/index.ts`](../../packages/tools/src/index.ts) · [`packages/tools/src/schema.ts`](../../packages/tools/src/schema.ts)

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

Source: [`packages/tools/src/schema.ts`](../../packages/tools/src/schema.ts)

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

`ctx.tools.execute()` runs each call through the `tools/execute` waterfall — the single seam where sandbox, permission, hook, and plan-mode plugins wrap or veto. The pending call is a `ToolExecution`; the outcome is a `ToolExecutionResult`.

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
}
```

A waterfall listener receives `(exec, next)`: call `next()` to proceed (possibly around your own logic), or return a `ToolExecutionResult` without calling `next()` to veto. An unregistered tool routes through the same catch as a tool-thrown error, so both failure classes get a structured `{ name, code }` (`ToolNotFoundError` → `UNKNOWN_TOOL`) — the loop records a failed tool call instead of failing the whole turn.

## Tool-presentation UI vocabulary

How a tool wants its call shown in a UI (an editor tool-call card, a CLI log line), provider-neutral so a tool describes itself without depending on any client protocol. `presentCall` returns a `ToolCallPresentation` (pending state: `title`, `kind`, `rawInput`, `content`, optional `terminal`); `presentResult` returns a `ToolResultPresentation` (completed state: replacement `title`, reformatted `content`, terminal `output`/exit). `ToolCallKind` (`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`) picks an icon. A `ToolTerminal` asks a capable UI to render the call as a terminal card (cwd header, output, exit-status pill).

> These shapes carry a `FIXME(tool-presentation)` in source: they grew incrementally and the call-vs-result terminal split is muddy. Before more tools/UIs depend on them, they will be redesigned (a tagged union over card kinds) and pinned in an RFC, migrating `dsh-tool-bash` and the ACP bridge together. Treat the field-level shapes here as provisional; the source is authoritative.

The full presentation field docs live in [`packages/tools/src/index.ts`](../../packages/tools/src/index.ts). The bash tool's own schemas (`bash`/`bash_output`/`bash_kill`) and the executor they drive are on [bash.md](bash.md).
