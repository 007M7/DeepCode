# Core Data Structures

This folder catalogs the **data structures** of the DeepSeek Harness — what each core type represents, its literal shape, and where the full detail lives. It complements [architecture.md](../architecture.md), which describes *behavior* (the service map, the session/turn/step lifecycle, the event taxonomy); this page describes the *vocabulary* that behavior moves around.

## What counts as "core"

The harness is a microkernel: a tiny core plus many plugins. Most types belong to one plugin or one capability. A handful, though, are the **spine** — the language the agent loop and its events traffic in on *every* turn, no matter which optional plugins are loaded. Those are "core".

Precisely, a data structure is **core** if either:

1. it flows through the agent-loop spine — the loop holds it, derives it, streams it, or logs it on every turn (a `Message`, a `StreamChunk`, a `SessionEvent`, the `Agent` handle itself), independent of which plugins are present; **or**
2. it is the single headline type a plugin author writes against a pipeline — `ToolDefinition` (what every tool *is*).

Everything else is documented on a **sub-page**, not here. The rule that draws the line: *the type you write, hold, or receive is core; the machinery that types it, renders it, or persists it is a sub-page detail.* So `ToolDefinition` is core, but the `SchemaSpec`/`InferArgs` DSL that types it, the `ToolCallView`/`ToolResultView` render-intent vocabulary that renders it, and the `SessionPersistence` seam that stores the event log are not — they live on the sub-pages below.

| Sub-page | Owns |
|---|---|
| [llm-streaming.md](llm-streaming.md) | the `StreamChunk` wire protocol + adapter contract, `BlockAssembler`, the `LlmAdapter` seam |
| [token-meter.md](token-meter.md) | immutable scalar and positional replay measurements with consumed-log revisions |
| [scope.md](scope.md) | scoped registration identity, dispatch carriers, and the owned `Scope` context |
| [goal.md](goal.md) | persisted goal identity, lifecycle snapshots, activation, change records, and round attribution |
| [commands.md](commands.md) | the human-command seam: definitions, adapter discovery, direct invocation, results, and parsing views |
| [session.md](session.md) | the full `SessionEventMap` variant catalog, `TurnTrigger`/`TurnEndReason`, `deriveMessages()`, the turn-enclosure invariant |
| [persistence.md](persistence.md) | the durability seam: `SessionPersistence`, JSONL + SQLite backends, `session/flush`, crash recovery, `SessionHeader` |
| [session-query.md](session-query.md) | logical records, bounded exact-event reads, and relationship traces |
| [session-title.md](session-title.md) | durable title snapshots, source provenance, and the asynchronous provider contract |
| [system-prompt.md](system-prompt.md) | per-assembly context, tool-provider results, prompt sections, and cooperative assembly |
| [tools.md](tools.md) | `ToolDefinition` full fields, the schema DSL, `ToolExecution`/`ToolResult`, tool-presentation UI types, and the guarded execution pipeline |
| [user-interaction.md](user-interaction.md) | the UI-backed human question/answer seam: `AskUserQuestionRequest`, answer/options vocabulary, provider API, error taxonomy |
| [approval.md](approval.md) | the one-shot user-approval seam: `ApprovalRequest`, `ApprovalOutcome`, per-session policy, audit and answerer contracts |
| [bash.md](bash.md) | the bash executor seam: `BashExecRequest`/`Spec`, `BashRunResult`, background `BashProcess` handles |
| [sandbox.md](sandbox.md) | the process-confinement seam: file-effect modes, `SandboxPolicy`, `ConfinedArgv`, enforcement and fail-closed errors |
| [code-runtime.md](code-runtime.md) | the code-execution seam: `CodeRunRequest`/`Result`, binding namespaces, captured logs, the `CodeRunFailure` taxonomy |
| [filesystem.md](filesystem.md) | the filesystem seam: `FsTarget`, read/write/edit outcomes, observed-file state, `FsErrorCode` |
| [lsp.md](lsp.md) | the LSP navigation seam: `LspQueryRequest`/`Result`, `LspProvider`/`Service`, four operations, `LspError` |
| [skills.md](skills.md) | the skill service: discovery priority, `SkillSummary`/`SkillDefinition`, session-prefix catalog, model-facing `skill` loading |
| [compaction.md](compaction.md) | the compaction seam: the `compact/*` session events, `CompactionResult`, the `CompactService` interface |
| [subagent.md](subagent.md) | the subagent seam: the named-provider registry, `SubagentStartRequest`/`Result`/`Run`, the start-time-vs-runtime capability split |
| [web.md](web.md) | the web access seam: `WebSearchRequest`/`Result`, `WebFetchRequest`/`Result`, `WebFetchBody`, provider availability, `WebError` |
| [spill.md](spill.md) | the spill storage seam: `SaveTextSpill`, `SpillOwner`/`SpillSource`, `SpillRef`, the branded `SpillLocator` |
| [workflow.md](workflow.md) | the workflow seam: `WorkflowStartRequest`, `WorkflowMeta`, `WorkflowRun`/`Result`, the `workflow/*` event payloads, `WorkflowError` fatality |

> Type declarations and their JSDoc on these pages are source-equivalent and drift-checked by `pnpm run verify-type-equiv` (see [development.md](../development.md#documenting-types-verbatim-ts-type-equiv)). Ordinary blocks preserve complete declarations; `public-api` blocks preserve body-stripped public class declarations. Cordis services use the generated [service catalog](../cordis-catalog/services.md).

## The `…Map → derived-union` pattern

Almost every extensible sum type in the harness follows one shape: an interface keyed by a discriminant tag (the `…Map`), from which the union is derived with `keyof`. Plugins add variants by **declaration merging** — no edit to the owning package.

```ts ignore-check
// The pattern, schematically:
interface ThingMap {
  'a': { kind: 'a'; /* … */ }
  'b': { kind: 'b'; /* … */ }
}
type ThingKind = keyof ThingMap          // 'a' | 'b'
type Thing = ThingMap[keyof ThingMap]    // the discriminated union

// A plugin extends it without touching the source package:
declare module '@deepseek-ai/dsh-llm' {
  interface ThingMap {
    'c': { kind: 'c'; /* … */ }
  }
}
```

Six canonical maps use this pattern; a plugin author extends these:

| Map | Package | Derives | Catalog |
|---|---|---|---|
| `ContentBlockMap` | dsh-llm | `ContentBlock` | [below](#content-blocks-and-messages) |
| `MessageSourceMap` | dsh-llm | `MessageSource` | [below](#content-blocks-and-messages) |
| `FinishReasonMap` | dsh-llm | `FinishReason` | [below](#the-model-request-and-result) |
| `TurnTriggerMap` | dsh-session | `TurnTrigger` | [session.md](session.md) |
| `TurnEndReasonMap` | dsh-session | `TurnEndReason` | [session.md](session.md) |
| `SessionEventMap` | dsh-session | `SessionEvent` | [session.md](session.md) |

Two large discriminated unions are the ones consumers `switch` over most: **`StreamChunk`** (the streaming protocol) and **`SessionEvent`** (the log entry). Per the repo convention, `switch` on the tag — don't chain `if`s — so each arm narrows and a typo'd tag fails to compile.

## Branded IDs

IDs that cross package boundaries are **branded** — structurally strings, but non-interchangeable at the type level (a `SessionId` cannot be passed where a `CallId` is expected). Construction goes through a per-type factory; comparison, logging, and JSON behave as ordinary strings.

The `Branded<B>` primitive lives in its own type-only package, [dsh-brand](../../packages/util/brand) (no runtime code, no harness-package dependency), so any package can brand the ids it owns without depending on an unrelated capability package.

Source: [`packages/util/brand/src/index.ts`](../../packages/util/brand/src/index.ts)

```ts type-equiv
/** A string carrying a compile-time-only brand `B`. */
type Branded<B extends string> = string & { readonly [BRAND]: B }
```

The two core IDs are `CallId` (correlates a tool call with its result; dsh-llm) and `SessionId` (the shared live agent and durable session identity; dsh-session). Capability packages brand their own ids too, such as `TaskId` in [tasks.md](tasks.md).

## Content blocks and messages

A conversation is `Message`s; a message is an array of typed **content blocks**. The block union derives from `ContentBlockMap`.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support.
 */
interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}
```

The block interfaces (full fields in source): `TextBlock` (`text`), `ReasoningBlock` (thinking, distinct from visible text), `ToolCallBlock` (`id: CallId`, `name`, raw-JSON `arguments`), `ToolResultBlock` (`toolCallId`, nested `content: ContentBlock[]`, `isError?`). `ContentBlock = ContentBlockMap[ContentBlockType]`. The core set is limited to blocks every shipping path honors — multimodal content (images, audio, …) has no core block type; a feature that needs one adds it via the merge-extensible map together with the adapter/UI/compaction support that honors it.

A `Message` is a role plus blocks. Loop-derived assistant messages carry their durable provider/model identity and optional adapter-private replay metadata:

```ts type-equiv
/** Provider ownership and adapter-private replay data for an assistant message. */
interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmService` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown
}
```

```ts type-equiv
/**
 * A single message in a conversation history. Loop-derived assistant messages
 * always carry provenance; callers may omit it on hand-built foreign history.
 */
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  /** Present only on assistant messages produced by a routed adapter. */
  provenance?: AssistantProvenance
}
```

Where a message came from is itself a merge-extensible sum type:

```ts type-equiv
/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string }
}
```

## Streaming

Adapters emit a raw **chunk** protocol; the loop logs the chunks (replay fidelity) while feeding the same chunks through a `BlockAssembler` to rebuild blocks and messages. `StreamChunk` is a closed discriminated union over `type` — `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`.

The full union, the adapter contract (usage-before-finish, raw-JSON tool arguments, the two sanctioned error paths), and `BlockAssembler` live on **[llm-streaming.md](llm-streaming.md)**.

## The model request

One model call is a fully-assembled `GenerateOptions`. The adapter answers with a raw `StreamChunk` stream; the consumer assembles it with `BlockAssembler` (see [llm-streaming.md](llm-streaming.md)).

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

Provider and model discovery uses small provider-neutral descriptors. A model catalog is advisory: routing still keys on a registered provider, and an adapter may accept unlisted model ids.

```ts type-equiv
/** Display metadata for one registered provider route. */
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}
```

```ts type-equiv
/** One adapter-discovered model; catalog membership is advisory, not request validation. */
interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
}
```

Correctness-sensitive model capacity is queried separately from the advisory catalog and is owned by the adapter serving the exact route.

```ts type-equiv
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}
```

```ts type-equiv
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * `EpochHeader.messagePrefix` + the derived history (dsh-agent-loop); a
   * hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * Session identity stamped by the loop for listener routing. Adapters ignore
   * it; replay uses it to keep concurrent parent and child cursors independent.
   */
  sessionId?: Branded<'SessionId'>
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata. Ordinary conversation
   * requests leave it unset.
   */
  purpose?: 'compaction'
}
```

Why a model response stopped is a merge-extensible reason. Terminal provider failures carry the streaming contract's [`LlmFailure`](llm-streaming.md#llmfailure):

```ts type-equiv
/**
 * Why a model response stopped.
 * Merge-extensible so adapters can surface provider-specific reasons.
 */
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}
```

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`. `TokenUsage` (per-call accounting with disjoint cache fields) is detailed on [llm-streaming.md](llm-streaming.md).

`GenerateOptions.tools` carries `ToolSchema` — the JSON-schema description of a tool, as sent to the model. It is declared in dsh-llm (not dsh-tools) precisely because it is part of the request the loop assembles every step:

```ts type-equiv
/**
 * JSON-schema description of a tool, as sent to the model.
 *
 * Declared here (not in dsh-tools) because it is part of {@link GenerateOptions};
 * dsh-tools' ToolDefinition and dsh-system-prompt's PromptAssembly both import
 * it from this package.
 */
interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

The model-facing `ToolSchema` is the wire shape; the registered `ToolDefinition` that produces it (schema + `execute`) is on [tools.md](tools.md).

### The request envelope: `LlmCallConfig` and the logged header

The loop builds each request from logged state. `EpochHeader` records call config, rendered prompt, authoritative returned tool order (configured by `toolOrder`, or lexicographic when unset), and session prefix through full `request/header` snapshots. Together with derived history, this makes the request reconstructable from the session log. See [session.md](session.md#the-request-header-event-requestheader) and the [reconstructability Agent Note](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md).

`agent/request` receives a frozen call-config seed and may return a replacement to switch provider, model, or sampling. `agent/session-prefix` composes request-only prefix messages once per loop instance, and the header records the exact result used. Requests reaching `llm/stream` are deep-frozen, so mutation throws, and carry a process-local loop identity so observers do not confuse separately logged frozen auxiliary calls with conversation requests.

On the wire, a loop-built request reads in this order: the `system` slot (the rendered prompt assembly) → `messagePrefix` (the frozen session prefix) → the derived history — the boundary snapshot, whose tail is the newest `user/message` on a turn's first step and the previous step's tool results on later steps. The prefix never enters the derived history; its durable record is the header events, and the dev invariant recomputes exactly this equation against every loop-built request.

FIXME(call-config-shape): revisit the exact definition of this type — which fields are genuinely epoch-level for cache purposes (`model` certainly; the sampling scalars sit here out of caution), and where provider-specific extras (reasoning options, extra body params) belong when an adapter needs them.

```ts type-equiv
/**
 * Provider + model + sampling scalars of one conversation's requests. Every field maps
 * 1:1 onto the same-named `GenerateOptions` field; the loop builds requests
 * from the logged header rather than accepting these per call.
 */
interface LlmCallConfig {
  provider: string
  model: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

## Sessions

A `Session` is an **append-only log** of typed `SessionEvent`s — the single source of truth. The LLM message history is *derived* from the log (`deriveMessages()`), not stored separately. The event vocabulary derives from `SessionEventMap`:

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * One immutable entry in the session log.
 *
 * A proper discriminated union over `type` (not independent `type`/`data`
 * unions), so `switch (event.type)` narrows `event.data` without casts.
 *
 * The {@link sourceEventSeqs} and {@link surfaceOp} fields are conditional:
 * they only exist on {@link SurfaceEventType} variants (`user/message`,
 * `assistant/message`, `tool/result`, `context/message`, `steering/message`).
 * Non-surface events (boundary markers, chunks, usage, errors) never carry
 * surface metadata — the compiler enforces this at `Session.append()`
 * call sites.
 */
type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: number
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
  } & (K extends SurfaceEventType ? {
    /**
     * Seq numbers of events that are provenance sources of this event
     * (e.g. the `assistant/chunk` seqs that built an `assistant/message`,
     * or the surface nodes shadowed by a compaction replace node). An
     * `assistant/message` may carry a present empty array for a known empty
     * provider stream; omission means unrecorded provenance.
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

The fourteen event variants (`turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `prompt/blocked`, `context/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `steering/message`, `todo/write`, `request/header`), the `deriveMessages()` projection rules, the `TurnTrigger`/`TurnEndReason` reasons, and the turn-enclosure invariant are on **[session.md](session.md)**. How the log is made durable — the `SessionPersistence` seam, JSONL/SQLite backends, the `session/flush` checkpoint, crash recovery, and `SessionHeader` — is on **[persistence.md](persistence.md)**.

## The agent handle

`Agent` is the surface every plugin (UI, hooks, orchestrators) programs against. The concrete implementation is package-internal to dsh-agent-loop; nothing outside the loop depends on it.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

`InjectOptions` extends ordinary message attribution with durable model-hidden JSON metadata:

```ts type-equiv
/** Options specific to durable synthetic context injection. */
interface InjectOptions extends SendOptions {
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}
```

```ts type-equiv
/** Stable runtime cause accepted by {@link Agent.cancel}. */
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
```

```ts type-equiv
/** Public agent handle; its concrete implementation is internal to `@deepseek-ai/dsh-agent-loop`. */
interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * Queue one detached, frozen lossless-JSON item. If claimed, it is the sole
   * ordinary message in its FIFO-ordered turn; the next claimed item waits for
   * that turn's checkpoint.
   * Invalid input throws synchronously before notification or enqueue.
   */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Submit steering while the agent is `running`. An open turn records it at
   * the next steering checkpoint before a request or continuation decision;
   * policy may stop before another step. After turn close and its checkpoint,
   * any remainder is queued for a later turn; terminal `agent/turn-stop`,
   * cancellation, or disposal may discard it. Uses the same synchronous
   * snapshot-and-validation boundary as {@link send}; when idle, delegates to it.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Append detached model-facing context without running the model. An open-turn
   * injection joins at the current log position unless the current tool batch is
   * executing; then it waits FIFO until that batch settles and drains before turn
   * close even when interrupted. Idle injection uses a one-shot turn and durability
   * checkpoint. Disposal awaits idle checkpoints; flush failures report through `agent/error`.
   */
  inject(content: ContentBlock[], options?: InjectOptions): void

  /**
   * Clear all queued and steering work, including items waiting to start, and
   * abort the active turn. An effective call first emits
   * `agent/cancel-requested` with the resolved typed cause. The first cause wins
   * for the active turn, and `whenIdle()` resolves after cancellation reaches
   * quiescence. Omission means `{ kind: 'user' }`. Idle cancellation is a no-op
   * and does not arm later work. The active turn snapshots and freezes the cause.
   * @param cause - the stable caller intent carried by the current turn signal.
   */
  cancel(cause?: AgentCancelCause): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>

}
```

`AgentStatus` is `'idle' | 'running' | 'disposed'`, and `SessionId` is branded. `running` describes the driver-wide drain interval, which can span turn close, its durability checkpoint, and consecutive queued turns; it does not prove a turn is still open. `AgentOptions` is merge-extensible and currently includes `provider?` and `model?`; dispatch requires both after `agent/request`. Persona belongs to `dsh-system-prompt`: an agent-scoped `deployment:persona` may shadow the global default.

The cause is a TypeScript-enforced same-process input. An active holder copies its discriminant into the runtime-only `AbortSignal.reason`; it is retired before `turn/end` publication. `agentInterruptReasonOf(signal)` recognizes `user`, `parent`, and lifecycle-only `disposed` without consulting ambient initiator state. Durable `turn/end` retains the coarse `{ kind: 'aborted' }` outcome; request provenance would require a separate durable event rather than overloading the terminal result.

The [event taxonomy](../architecture.md#event) owns the `agent/*` lifecycle, checkpoint, and waterfall contracts. Turn and step boundaries are durable session events rather than agent emits.

## Initiating Agent

The process-local initiator carried by `ctx.agents` is the exact `Agent` above, not a separate frame or copied identity. Ambient presence is neither liveness proof nor authorization; the [initiator-scope decision](../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns its lifetime and boundary rules.

## Interception decisions

Each `agent/*` interception waterfall returns a small, seam-specific typed union — the unified Decision idiom (the tool seams' `PreToolDecision`/`PostToolDecision` in [tools.md](tools.md) follow the same shape). A CC/Codex hook bridge maps its `permissionDecision`/`decision`/`continue`/`additionalContext` fields onto these; a native plugin returns them directly. Prompt and post-tool decisions share one model-facing context shape, `HookContext`, which is `inject()`ed as a `context/message` and therefore carries a REQUIRED `source` (a missing source would default to `{kind:'user'}` and mislabel plugin context as a user prompt). Its `content` reaches the model verbatim as a user-role message, while JSON `meta` persists plugin state without exposing it to the model. Both decisions carry `additionalContexts[]` so every entry preserves its own provenance and metadata. Continuation reasons are steering messages instead and deliberately use the narrower content/source shape.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
/** Model-facing context injected by a listener; `source` prevents plugin text from being labeled as user input. */
interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  /** Opaque JSON state retained in the session event but hidden from the model. */
  meta?: JsonValue
}
```

`agent/prompt-submit` returns a `PromptDecision` (allow the turn's claimed queued message — optionally rewriting its `content` or attaching `additionalContexts` — or record `prompt/blocked` and end that zero-step turn as `rejected`):

```ts type-equiv
/**
 * Prompt interception result. `allow.content` replaces the prompt and each
 * `additionalContexts` entry becomes a separate context message. `block`
 * records a durable `prompt/blocked` and ends the claimed prompt's zero-step
 * turn as rejected.
 */
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }
```

`agent/turn-continuation` returns a `ContinuationDecision` (the loop's default is `continue` when the step had tool calls or steering was injected, else `stop`; a `continue` `reason` is recorded as next-step steering in the same turn and therefore carries no context metadata — the typed `/goal` pattern):

```ts type-equiv
/** Turn continuation override; a continue reason is recorded as next-step steering in the same turn. */
type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: { content: ContentBlock[]; source: MessageSource } }
```

`agent/request-error` receives the exact original `RequestError` beside its immutable `LlmFailure`, an immutable list of failures that already authorized another request in the consecutive sequence, the turn signal, and `next()`. Recovery plugins route on `failure.code`, not the live error's message; each policy counts only its own codes, and a successful request clears the history:

```ts type-equiv
/** Model-request failure with an optional machine-routable provider code. */
type RequestError = Error & { code?: string }
```

It returns a `RequestErrorDecision`; `retry` opens a new numbered step after the recovery listener's durable mutation, while `fail` retains the structured failure on `turn/end`:

```ts type-equiv
/** Failed-request recovery decision; `retry` opens another numbered step while listeners delegate by calling `next()`. */
type RequestErrorDecision = { action: 'fail' } | { action: 'retry' }
```

`agent/post-step` is awaited after assistant output, real or synthetic tool results, buffered context, and steering are durable but before `step/end`. A cancelled tool batch reaches it with an aborted signal after draining; its signature is `(agent, turn, step, signal)`, and replayable facts remain in the session log rather than a transient payload.

`agent/turn-stop` returns the stop-only `ContinuationStop` subset or `undefined`. The loop calls this serial checkpoint after folding the ordinary decision, its reason, and pending steering; a stop is terminal and discards pending steering.

```ts type-equiv
/**
 * The terminal subset of {@link ContinuationDecision}. A listener on
 * `agent/turn-stop` returns this to make the already-composed continuation
 * outcome terminal; `undefined` abstains.
 */
type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>
```

`agent/session-start` carries a `SessionStartSource` (why the session lifecycle began; a bridge keys its SessionStart matcher on it):

```ts type-equiv
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

`agent/session-prefix` composes a `Message[]` once per loop instance. The deep-frozen result is recorded in the request header and prepended to every derived history, making it the home for session-stable openers. A resumed instance recomposes; mid-session changes use append-only context channels. The waterfall returns content directly because it contributes rather than decides.

## `ToolDefinition`

The one pipeline-authoring type that is core: what every registered tool *is* — a model-facing `ToolSchema` plus an `execute` function and optional UI presenters. A tool author rarely constructs it by hand (the `defineTool` DSL builds it with typed args), but it is the contract the registry holds and the loop dispatches through.

Its full fields, the `defineTool`/`SchemaSpec`/`InferArgs` typed schema DSL, the `ToolExecution`/`ToolExecutionResult` waterfall shapes, and the tool-presentation UI vocabulary are on **[tools.md](tools.md)**.
