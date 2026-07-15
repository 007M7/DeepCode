# Tools

The tool pipeline of [dsh-tools](../../packages/core/tools). [core.md](core.md) introduces `ToolDefinition` as the one pipeline-authoring type promoted to the spine and `ToolSchema` as the model-facing wire shape. This page owns the full `ToolDefinition`, the typed schema DSL that builds it, the guarded execution shapes, and the UI-presentation vocabulary.

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition` — a registered tool

A `ToolSchema` (the model-facing fields) plus the `execute` function and optional UI presenters. The registry holds these; the loop dispatches calls through them. The registry's `schemas()` builds the model-facing `ToolSchema[]` by an explicit allowlist — `execute`/`presentCall`/`presentResult` must never leak into a model request.

```ts type-equiv
interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolExecution): Promise<ToolExecuteReturn>
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * `result` (`execute`'s content + whether it errored). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
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

Registration is a trusted same-process contract. The registry borrows the typed definition as readonly input and validates only semantic requirements such as a positive finite `timeoutMs`; `schemas()` materializes the explicit model-facing projection at the model boundary so execution and presentation share one resolved definition without leaking callbacks onto the wire.

## `ToolRestriction` — one scope's live global filter

`ToolRestriction` applies only to the live deployment-global tool layer. The registry compiles readonly names into private sets, intersects multiple restrictions, then overlays scope-local tools. A deny-only filter admits later unlisted globals, while an allow-list excludes them.

```ts type-equiv
interface ToolRestriction {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}
```

## Execution: extensible waterfalls plus monotonic policy

`ctx.tools.execute()` accepts a caller-owned `ToolExecutionInput`, materializes its parsed JSON arguments once into a pipeline-owned `ToolExecution`, and runs that call through `tools/pre-execute` (the reorderable allow/deny/ask waterfall) → registered monotonic guards → `tools/execute` (around-dispatch wrappers) → `tools/post-execute` (inspect/replace the result) → `tools/result` (the immutable authoritative outcome). The outcome is a `ToolExecutionResult`.

```ts type-equiv
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Parsed JSON arguments (unknown — tools validate their own input). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /**
   * Opaque token of the enclosing transport execution, when one exists. Code
   * Mode sets this on SDK sub-dispatches so commit-style observers can wait for
   * the outer `run_code` outcome without receiving its live mutable execution.
   */
  readonly parent?: ToolExecutionToken
  signal?: AbortSignal
}
```

```ts type-equiv
interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}
```

`ToolExecutionToken` is an opaque runtime `Symbol` used only for identity comparison. Before policy, `execute()` materializes and freezes arguments, rejects non-JSON input, and assigns the token. Identity fields and the optional parent token remain readonly; only `signal` may change around dispatch. Final observers receive the frozen execution identity.

A `ToolGuard` is scope-aware final pre-dispatch policy. Its shape deliberately has no allow result: `undefined` preserves the waterfall decision, while a returned reason can only reduce permission, so a later listener cannot undo it.

```ts type-equiv
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

```ts type-equiv
interface ToolExecutionResult {
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
  /**
   * The tool-private presentation payload from a successful `execute` (the object
   * return form). Threaded onto the `tool/result` session event and back into
   * {@link ToolResult} for `presentResult`. Opaque (`unknown`); absent when the
   * tool attached none or the call failed.
   */
  meta?: unknown
}
```

The result carries only the outcome. Call identity remains on the immutable `ToolExecution` that accompanies it through every hook and on the durable `tool/call` / `tool/result` session events, so wrappers cannot create a second, disagreeing identity.

The registry materializes and freezes the final accepted result immediately before `tools/result`. Its content, structured error, additional context, and presentation metadata must round-trip losslessly through JSON; an invalid outcome becomes a JSON-safe `isError` result, so the observed live outcome is safe for the later durable `tool/result` append.

Each interception waterfall returns a typed **Decision** (the idiom shared with the `agent/*` seams). `tools/pre-execute` listeners receive `(exec, next)` and return a `PreToolDecision`; `tools/execute` wrappers return a `ToolExecutionResult`; `tools/post-execute` listeners receive `(exec, result, next)` and return a `PostToolDecision`:

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

Call `next()` for the default or return a decision to short-circuit. Pre-policy may deny or ask; only `allowed-once` proceeds, while a non-grant, missing approval channel or service, or agent-less request becomes a denial. Guards may still impose a final denial. Arguments cannot be rewritten because history, audit, UI, and execution must agree.

Post-policy may replace content; a block becomes an `isError` result containing its corrective feedback. `tools/result` receives the frozen execution and result after normalization; observers cannot transform them, and observer failures are contained. Unknown and throwing tools both become structured errors (`ToolNotFoundError` maps to `UNKNOWN_TOOL`), so the call fails without ending the turn.

## The structured-output schema subset

The vocabulary a caller uses to demand a machine-readable result from a subagent (`SubagentStartRequest.outputSchema`, [subagent.md](subagent.md#the-start-request)) or a workflow `agent()` call. It is deliberately NOT full JSON Schema: the schema travels verbatim to the model as a forced tool's `parameters`, and the produced value is validated client-side by `validateStructuredValue` — so every accepted keyword must be one the validator actually enforces, and `assertSupportedOutputSchema` rejects anything else loud (`OutputSchemaError`, listing every violation). Both walkers reason over own enumerable properties only (JSON carries nothing else) and reject non-plain objects (`Date`, `Map`) that would serialize lossily.

```ts type-equiv
type StructuredScalar = string | number | boolean | null
```

```ts type-equiv
type StructuredSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
```

```ts type-equiv
interface StructuredSchemaNode {
  type: StructuredSchemaType
  properties?: Record<string, StructuredSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: StructuredSchemaNode
  enum?: StructuredScalar[]
  const?: StructuredScalar
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
}
```

A schema is an object-rooted node (`enum`/`const` are scalar-only; `description`/`title`/`default`/`examples` are annotations, allowed and ignored but still required to be JSON data — they ride the wire):

```ts type-equiv
type StructuredOutputSchema = StructuredSchemaNode & { type: 'object' }
```

## Tool-presentation UI vocabulary

How a tool wants its call shown in a UI (an editor tool-call card, a CLI log line), provider-neutral so a tool describes itself without depending on any client protocol. `presentCall`/`presentResult` return a **`card`-tagged render intent** — a discriminated union a UI bridge switches on:

- `ToolCallView` (pending): `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` (the default card; `locations` is `{ path, line? }[]` files the call reads/modifies, for editor follow-along), `{ card: 'terminal', title, description?, cwd? }` (a shell command → a terminal card), or `{ card: 'diff', title, diffs, locations? }` (a file create/modify → an inline diff card; `diffs` is `{ path, oldText, newText }[]`, `oldText: null` for a new file).
- `ToolResultView` (completed): `{ card: 'generic', title?, content? }`, `{ card: 'terminal', title?, output?, exitCode?, signal? }` (the captured run output + exit; a capable UI shows an exit-status pill, an incapable one gets a fenced ` ```console ` fallback the bridge derives from `output`), or `{ card: 'diff', title?, diffs }` (a completed file mutation → the change to show, typically the applied hunks with context lines computed from the before/after content, or a whole-file diff when there is no before-image — e.g. a file create. A `tool_call_update`'s content REPLACES the call's content, so a mutation tool returns this even when it duplicates the call-time snippet, to keep the result from clobbering the diff with result text).

`ToolCallKind` (`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`) picks an icon on a generic card. `FileLocation` (`{ path, line? }`) and `FileDiff` (`{ path, oldText, newText }`) are the shared file-card vocabulary. The design is pinned in [the render-intent-union RFC](../rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md); the ACP bridge maps a `diff` card to a `{ type: 'diff' }` content block, a `terminal` card to the `_meta` terminal convention, and relativizes a file card's title against the session cwd.

The full presentation field docs live in [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts). The bash tool's own schemas (`bash`/`bash_output`/`bash_kill`) and the executor they drive are on [bash.md](bash.md).
