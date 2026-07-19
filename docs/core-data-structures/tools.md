# Tools

The tool pipeline of [dsh-tools](../../packages/core/tools). [core.md](core.md) introduces `ToolDefinition` as the one pipeline-authoring type promoted to the spine and `ToolSchema` as the model-facing wire shape. This page owns the full `ToolDefinition`, the typed schema DSL that builds it, the guarded execution shapes, and the UI-presentation vocabulary.

Source: [`packages/core/tools/src/index.ts`](../../packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](../../packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts)

## `ToolDefinition` — a registered tool

A `ToolSchema` (the model-facing fields) plus the `execute` function, host-only scheduler metadata, and optional UI presenters. The registry holds these; the loop dispatches calls through them. The registry's `schemas()` builds the model-facing `ToolSchema[]` by an explicit allowlist — `execute`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` must never leak into a model request.

```ts type-equiv
/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  execute(args: unknown, exec: ToolRunContext): Promise<ToolExecuteReturn>
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; omission, exceptions, non-`true` returns, and invalid
   * `defineTool` arguments are exclusive. This metadata is never model-visible.
   *
   * Opted-in executions must not mutate parent-owned state. Shared state must
   * tolerate concurrent dispatch; recorder races are permitted only when they
   * commute or fail closed. See the
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
   * for the full contract.
   * @param args - parsed arguments; `defineTool` validates before calling.
   * @returns Whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
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
/** One schema-spec property entry. */
interface SchemaProp {
  type: SchemaType
  /** Per-property required flag (NOT the JSON Schema top-level required array). */
  required?: true
  /** Human-readable description, surfaced in the JSON Schema as well. */
  description?: string
  /** Enum of allowed values (strings only). */
  enum?: string[]
  /**
   * Model-visible JSON Schema default annotation. Validation does not apply it;
   * dynamic tool mounts may supply it even though first-party definitions do not.
   */
  default?: unknown
  /** Nested properties for type: 'object'. */
  properties?: SchemaSpec
  /** Items schema for type: 'array'. */
  items?: SchemaProp
}
```

```ts type-equiv
/**
 * The author-facing parameter schema: a shallow map of property name to
 * {@link SchemaProp}. Required-ness is a per-property boolean (`required:
 * true`), not a separate array.
 */
type SchemaSpec = Record<string, SchemaProp>
```

`SchemaType` is the primitive union `'string' | 'number' | 'boolean' | 'object' | 'array'`. `InferArgs<S>` maps a `SchemaSpec` to the TS argument type — `required: true` props become required keys, everything else genuinely optional:

```ts type-equiv
/**
 * Infer the TS argument type for a complete {@link SchemaSpec}.
 *
 * Properties marked `required: true` are required keys; all others are
 * genuinely optional keys (`?`), so callers may omit them entirely.
 *
 * Example:
 * ```ts
 * type Args = InferArgs<{ path: { type: 'string'; required: true }; limit: { type: 'number' } }>
 * // → { path: string; limit?: number }
 * ```
 */
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
/**
 * Per-scope filter over global tools. Restrictions intersect and do not affect
 * scoped registrations or the reserved Code Mode transport.
 */
interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}
```

## Execution: extensible waterfalls plus monotonic policy

`ctx.tools.execute()` accepts a caller-owned `ToolExecutionInput`, materializes its parsed JSON arguments once into a pipeline-owned `ToolExecution`, and runs that call through `tools/pre-execute` (the reorderable allow/deny/ask waterfall) → registered monotonic guards → `tools/execute` (around-dispatch wrappers) → `tools/post-execute` (inspect/replace the result) → `tools/result` (the immutable authoritative outcome). The outcome is a `ToolExecutionResult`.

```ts type-equiv
/** Opaque call identity that permits correlation without exposing mutable execution state. */
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

```ts type-equiv
/**
 * Caller-supplied description of one tool call. {@link ToolRegistry.execute}
 * adds the registry-owned token to form a pipeline {@link ToolExecution};
 * callers do not choose that token.
 */
interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
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

A tool body receives the runtime extension. `deferContext()` is the composite-tool channel: it records nested-dispatch context without injecting inside the still-open outer call.

```ts type-equiv
/**
 * Runtime context handed to a tool implementation after the registry has
 * accepted a {@link ToolExecution}. A composite tool uses
 * {@link deferContext} to ferry context produced by nested dispatches back to
 * the outer result; the loop appends it only after the outer `tool/result`.
 */
interface ToolRunContext extends ToolExecution {
  /**
   * Defer one nested-dispatch context until this tool's final result reaches
   * the agent loop. Contexts retain their individual source, envelope, and
   * metadata and are emitted in call order.
   */
  deferContext(context: HookContext): void
}
```

The agent loop asks the registry for each pending call's execution mode and uses it to form exclusive barriers and rolling-pool parallel runs:

```ts type-equiv
/**
 * Scheduling mode for one pending call. `parallel` may overlap with siblings;
 * `exclusive` runs alone and forms an ordering barrier.
 */
type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }
```

```ts type-equiv
/**
 * One pending tool call inside the registry pipeline. Parsed arguments cross
 * one lossless-JSON materialization boundary before policy and are deep-frozen;
 * call identity and the registry-assigned {@link token} are readonly. An
 * around-dispatch wrapper may set, replace, or remove `signal`. The registry
 * freezes the complete object before `tools/result` observers run.
 */
interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}
```

`ToolExecutionToken` is an opaque runtime `Symbol` used only for identity comparison. Before policy, `execute()` materializes and freezes arguments, rejects non-JSON input, and assigns the token. Identity fields and the optional parent token remain readonly; only `signal` may change around dispatch. Final observers receive the frozen execution identity.

A `ToolGuard` is scope-aware final pre-dispatch policy. Its shape deliberately has no allow result: `undefined` preserves the waterfall decision, while a returned reason can only reduce permission, so a later listener cannot undo it.

```ts type-equiv
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

```ts type-equiv
/** The outcome of one tool call. */
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
   * Model-facing context for the next request, separate from this tool result. The loop
   * accepts it into the active-batch FIFO, then appends after recorded results even if interrupted.
   */
  additionalContexts?: HookContext[]
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
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

```ts type-equiv
/**
 * Post-dispatch decision: accept or replace content, attach context for the next
 * request, or block by turning corrective feedback into an error result.
 */
type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: HookContext[] }
```

Call `next()` for the default or return a decision to short-circuit. Pre-policy may deny or ask; only `allowed-once` proceeds, while a non-grant, missing approval channel or service, or agent-less request becomes a denial. Guards may still impose a final denial. Arguments cannot be rewritten because history, audit, UI, and execution must agree.

Post-policy may replace content; a block becomes an `isError` result containing its corrective feedback. `tools/result` receives the frozen execution and result after normalization; observers cannot transform them, and observer failures are contained. Unknown and throwing tools both become structured errors (`ToolNotFoundError` maps to `UNKNOWN_TOOL`), so the call fails without ending the turn.

## The structured-output schema subset

The vocabulary a caller uses to demand a machine-readable result from a subagent (`SubagentStartRequest.outputSchema`, [subagent.md](subagent.md#the-start-request)) or a workflow `agent()` call. It is deliberately NOT full JSON Schema: the schema travels verbatim to the model as a forced tool's `parameters`, and the produced value is validated client-side by `validateStructuredValue` — so every accepted keyword must be one the validator actually enforces, and `assertSupportedOutputSchema` rejects anything else loud (`OutputSchemaError`, listing every violation). Both walkers reason over own enumerable properties only (JSON carries nothing else) and reject non-plain objects (`Date`, `Map`) that would serialize lossily.

```ts type-equiv
/** The scalar values `enum`/`const` may carry (finite numbers only). */
type StructuredScalar = string | number | boolean | null
```

```ts type-equiv
/** The `type` keywords the subset accepts. */
type StructuredSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
```

```ts type-equiv
/**
 * One node of the structured-output schema subset. Recursive via `properties`
 * and `items`; see the module doc for the exact keyword semantics.
 */
interface StructuredSchemaNode {
  type: StructuredSchemaType
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, StructuredSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` allows them (JSON Schema default). */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent ⇒ any JSON items. */
  items?: StructuredSchemaNode
  /** Allowed values (scalar types only). */
  enum?: StructuredScalar[]
  /** The single allowed value (scalar types only). */
  const?: StructuredScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation (must still be JSON data). */
  default?: unknown
  /** Annotation, ignored for validation (must still be JSON data). */
  examples?: unknown
}
```

A schema is an object-rooted node (`enum`/`const` are scalar-only; `description`/`title`/`default`/`examples` are annotations, allowed and ignored but still required to be JSON data — they ride the wire):

```ts type-equiv
/** A structured-output schema: an OBJECT-rooted {@link StructuredSchemaNode}. */
type StructuredOutputSchema = StructuredSchemaNode & { type: 'object' }
```

## Tool-presentation UI vocabulary

How a tool wants its call shown in a UI (an editor tool-call card, a CLI log line), provider-neutral so a tool describes itself without depending on any client protocol. `presentCall`/`presentResult` return a **`card`-tagged render intent** — a discriminated union a UI bridge switches on:

- `ToolCallView` (pending): `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` (the default card; `locations` is `{ path, line? }[]` files the call reads/modifies, for editor follow-along), `{ card: 'terminal', title, description?, cwd? }` (a shell command → a terminal card), or `{ card: 'diff', title, diffs, locations? }` (a file create/modify → an inline diff card; `diffs` is `{ path, oldText, newText }[]`, `oldText: null` for a new file).
- `ToolResultView` (completed): `{ card: 'generic', title?, content? }`, `{ card: 'terminal', title?, output?, exitCode?, signal? }` (the captured run output + exit; a capable UI shows an exit-status pill, an incapable one gets a fenced ` ```console ` fallback the bridge derives from `output`), or `{ card: 'diff', title?, diffs }` (a completed file mutation → the change to show, typically the applied hunks with context lines computed from the before/after content, or a whole-file diff when there is no before-image — e.g. a file create. A `tool_call_update`'s content REPLACES the call's content, so a mutation tool returns this even when it duplicates the call-time snippet, to keep the result from clobbering the diff with result text).

`ToolCallKind` (`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`) picks an icon on a generic card. `FileLocation` (`{ path, line? }`) and `FileDiff` (`{ path, oldText, newText }`) are the shared file-card vocabulary. The design is pinned in [the render-intent-union Agent Note](../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md); the ACP bridge maps a `diff` card to a `{ type: 'diff' }` content block, a `terminal` card to the `_meta` terminal convention, and relativizes a file card's title against the session cwd.

The full presentation field docs live in [`packages/core/tools/src/presentation.ts`](../../packages/core/tools/src/presentation.ts). The `bash` schema and executor are on [bash.md](bash.md); generic background controls are on [tasks.md](tasks.md).
