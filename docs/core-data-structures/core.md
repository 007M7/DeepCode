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
| [session.md](session.md) | the full `SessionEventMap` variant catalog, `TurnTrigger`/`TurnEndReason`, `deriveMessages()`, the turn-enclosure invariant |
| [persistence.md](persistence.md) | the durability seam: `SessionPersistence`, JSONL + SQLite backends, `session/flush`, crash recovery, `SessionHeader` |
| [session-query.md](session-query.md) | logical records, bounded exact-event reads, and relationship traces |
| [system-prompt.md](system-prompt.md) | per-assembly context, tool-provider results, prompt sections, and cooperative assembly |
| [tools.md](tools.md) | `ToolDefinition` full fields, the schema DSL, `ToolExecution`/`ToolResult`, tool-presentation UI types, and the guarded execution pipeline |
| [user-interaction.md](user-interaction.md) | the UI-backed human question/answer seam: `AskUserQuestionRequest`, answer/options vocabulary, provider API, error taxonomy |
| [approval.md](approval.md) | the one-shot user-approval seam: `ApprovalRequest`, `ApprovalOutcome`, per-session policy, audit and answerer contracts |
| [bash.md](bash.md) | the bash executor seam: `BashExecRequest`/`Spec`, `BashRunResult`, background `BashProcess` handles |
| [sandbox.md](sandbox.md) | the process-confinement seam: file-effect modes, `SandboxPolicy`, `ConfinedArgv`, enforcement and fail-closed errors |
| [code-runtime.md](code-runtime.md) | the code-execution seam: `CodeRunRequest`/`Result`, binding namespaces, captured logs, the `CodeRunFailure` taxonomy |
| [filesystem.md](filesystem.md) | the filesystem seam: `FsTarget`, read/write/edit outcomes, observed-file state, `FsErrorCode` |
| [skills.md](skills.md) | the skill service: discovery priority, `SkillSummary`/`SkillDefinition`, session-prefix catalog, model-facing `skill` loading |
| [compaction.md](compaction.md) | the compaction seam: the `compact/*` session events, `CompactionResult`, the `CompactService` interface |
| [subagent.md](subagent.md) | the subagent seam: the named-provider registry, `SubagentStartRequest`/`Result`/`Run`, the start-time-vs-runtime capability split |
| [web.md](web.md) | the web access seam: `WebSearchRequest`/`Result`, `WebFetchRequest`/`Result`, `WebFetchBody`, provider availability, `WebError` |
| [spill.md](spill.md) | the spill storage seam: `SaveTextSpill`, `SpillOwner`/`SpillSource`, `SpillRef`, the branded `SpillLocator` |
| [workflow.md](workflow.md) | the workflow seam: `WorkflowStartRequest`, `WorkflowMeta`, `WorkflowRun`/`Result`, the `workflow/*` event payloads, `WorkflowError` fatality |

> Type definitions on this page are pasted **verbatim** from source and drift-checked by `pnpm run verify-type-equiv` (see [development.md](../development.md#documenting-types-verbatim-ts-type-equiv)). Inline JSDoc is omitted for readability; follow the source link for the full contracts.

FIXME(catalog-verbs): the drift gate covers only the nouns (the pasted type shapes); every method surface on these pages is hand-written prose. core-data-structures should probably also generate the *verbs* — the public methods of the cataloged classes — so a signature change cannot silently outdate the catalog.

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

IDs that cross package boundaries are **branded** — structurally strings, but non-interchangeable at the type level (an `AgentId` can't be passed where a `CallId` is expected). Construction goes through a per-type factory; comparison, logging, and JSON behave as ordinary strings.

The `Branded<B>` primitive lives in its own type-only package, [dsh-brand](../../packages/util/brand) (no runtime code, no harness-package dependency), so any package can brand the ids it owns without depending on an unrelated capability package.

Source: [`packages/util/brand/src/index.ts`](../../packages/util/brand/src/index.ts)

```ts type-equiv
type Branded<B extends string> = string & { readonly [BRAND]: B }
```

The three core IDs are `CallId`, `SessionId`, and `AgentId`. Capability packages brand their own ids too, such as `TaskId` in [tasks.md](tasks.md).

## Content blocks and messages

A conversation is `Message`s; a message is an array of typed **content blocks**. The block union derives from `ContentBlockMap`.

Source: [`packages/llm/llm/src/types.ts`](../../packages/llm/llm/src/types.ts)

```ts type-equiv
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
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  /** Present only on assistant messages produced by a routed adapter. */
  provenance?: AssistantProvenance
}
```

Where a message came from is itself a merge-extensible sum type:

```ts type-equiv
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
interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}
```

```ts type-equiv
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

```ts type-equiv
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
}
```

Why a model response stopped is a merge-extensible reason:

```ts type-equiv
interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted' }
  'error': { kind: 'error'; message: string; code?: string }
}
```

`FinishReason = FinishReasonMap[keyof FinishReasonMap]`. `TokenUsage` (per-call accounting with disjoint cache fields) is detailed on [llm-streaming.md](llm-streaming.md).

`GenerateOptions.tools` carries `ToolSchema` — the JSON-schema description of a tool, as sent to the model. It is declared in dsh-llm (not dsh-tools) precisely because it is part of the request the loop assembles every step:

```ts type-equiv
interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}
```

The model-facing `ToolSchema` is the wire shape; the registered `ToolDefinition` that produces it (schema + `execute`) is on [tools.md](tools.md).

### The request envelope: `LlmCallConfig` and the logged header

The loop builds each request from logged state. `EpochHeader` records call config, rendered prompt, authoritative returned tool order (configured by `toolOrder`, or lexicographic when unset), and session prefix through full `request/header` snapshots. Together with derived history, this makes the request reconstructable from the session log. See [session.md](session.md#the-request-header-event-requestheader) and the [reconstructability RFC](../rfc/implemented/architecture/2026-07-05-reconstructable-requests.md).

`agent/request` receives a frozen call-config seed and may return a replacement to switch provider, model, or sampling. `agent/session-prefix` composes request-only prefix messages once per loop instance, and the header records the exact result used. Requests reaching `llm/stream` are deep-frozen, so mutation throws.

On the wire, a loop-built request reads in this order: the `system` slot (the rendered prompt assembly) → `messagePrefix` (the frozen session prefix) → the derived history — the boundary snapshot, whose tail is the newest `user/message` on a turn's first step and the previous step's tool results on later steps. The prefix never enters the derived history; its durable record is the header events, and the dev invariant recomputes exactly this equation against every loop-built request.

FIXME(call-config-shape): revisit the exact definition of this type — which fields are genuinely epoch-level for cache purposes (`model` certainly; the sampling scalars sit here out of caution), and where provider-specific extras (reasoning options, extra body params) belong when an adapter needs them.

```ts type-equiv
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
     * or the surface nodes shadowed by a compaction replace node).
     */
    sourceEventSeqs?: number[]
    /** How this event entered the surface; absent for non-surface events. */
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

The fourteen event variants (`turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `prompt/blocked`, `context/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `steering/message`, `todo/write`, `request/header`), the `deriveMessages()` projection rules, the `TurnTrigger`/`TurnEndReason` reasons, and the turn-enclosure invariant are on **[session.md](session.md)**. How the log is made durable — the `SessionPersistence` seam, JSONL/SQLite backends, the `session/flush` checkpoint, crash recovery, and `SessionHeader` — is on **[persistence.md](persistence.md)**.

## The agent handle

`Agent` is the surface every plugin (UI, hooks, orchestrators) programs against. The concrete implementation is `ReactLoopAgent` in dsh-agent-loop; nothing outside the loop depends on the implementation.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

`InjectOptions` extends ordinary message attribution with context-only framing and durable model-hidden JSON metadata:

```ts type-equiv
interface InjectOptions extends SendOptions {
  envelope?: ContextEnvelope
  meta?: JsonValue
}
```

```ts type-equiv
interface Agent {
  readonly id: AgentId
  readonly options: AgentOptions
  readonly session: Session
  readonly status: AgentStatus

  /**
   * The agent's scope context (`@deepseek-ai/dsh-scope`, key = this agent):
   * registrations through it — tools, prompt sections/variables, listeners,
   * restrictions — are visible to this agent only and unwind when it is
   * disposed; `agent.ctx.on('agent/…')` listeners fire only for this agent.
   */
  readonly ctx: Context

  /**
   * Queue a user message. Starts a turn when idle; otherwise waits for the next
   * turn. Content and the resolved source are accepted as one detached,
   * deeply-frozen lossless-JSON record before notification or enqueue, so
   * caller or `agent/queued` listener in-place mutation cannot change later
   * log/model input. Throws synchronously when either value is not losslessly
   * JSON-serializable; `agent/prompt-submit` may still return an explicit
   * replacement.
   */
  send(content: ContentBlock[], options?: SendOptions): void

  /**
   * Steer a running turn: content is injected between steps of the current
   * turn. Uses the same owned-value and synchronous-validation boundary as
   * {@link send}; when idle, behaves exactly like that method.
   */
  steer(content: ContentBlock[], options?: SendOptions): void

  /**
   * Inject in-session context (file-change notices, skill content, cron
   * notifications, …): appends a `context/message` session event the next model
   * request sees at its chronological position, rendered as synthetic context
   * rather than a user prompt. The default uses the canonical context tag;
   * `options.envelope: 'raw'` preserves caller-owned framing. Does not run the
   * model.
   *
   * In an open turn, inject appends at the current log position except while
   * the current tool-call batch executes: accepted context waits FIFO until the
   * batch settles, then appends after every recorded result and before turn
   * close even when execution is interrupted.
   *
   * Turn-enclosure (the turn-enclosure RFC): an inject while a turn is open joins that turn;
   * an inject while idle wraps its `context/message` in a one-shot `injection`
   * turn (`turn/start` → `context/message` → `turn/end`) and checkpoints it for
   * durability, so every event stays inside a turn and a persistence backend
   * never loses a between-turn notice. The idle checkpoint is fire-and-forget
   * (inject is synchronous): a failing flush is reported via `agent/error`
   * (step `0`) and the logger, never thrown into the caller.
   *
   * Live-adapter review has validated the canonical tagged-envelope rendering
   * against current DeepSeek behavior; provider-specific mismatches belong in
   * that adapter, not in the canonical session vocabulary.
   */
  inject(content: ContentBlock[], options?: InjectOptions): void

  /**
   * Cancel ALL pending work for the agent. `cancel()`:
   *
   * - clears the queued FIFO (un-started prompts never run) and the steering
   *   FIFO (steering for the cancelled turn is dropped, not re-enqueued);
   * - aborts the in-flight step if one is running (the turn ends `aborted`);
   * - drops a turn that is about to start (a `cancel()` landing in the
   *   pre-step window — after a `send()` queued but before the loop flips to
   *   `running`, or after `running` is emitted but before the first step) so
   *   that queued prompt does not run and cannot be batched into the cancelled
   *   turn.
   *
   * After `cancel()`, `whenIdle()` resolves on the post-cancel quiescent state.
   * `cancel()` on an idle agent with nothing queued or running is a safe no-op
   * — it does NOT arm anything that would drop a later legitimate prompt.
   */
  cancel(reason?: string): void

  /**
   * Resolve once the agent has reached quiescence after settling out of
   * `running`, or immediately if it is already idle with no queued work. A
   * non-owner's quiescence-observation hook: a consumer that does NOT own the
   * agent's lifecycle awaits this to proceed only after queued/running work has
   * fully stopped, rather than returning while the driver is still streaming or
   * about to start a queued turn — without itself tearing the agent down. (A
   * lifecycle OWNER does not need it: `AgentHandle.dispose()` already awaits the
   * loop-exit promise directly as part of stopping and unregistering. So this is
   * for a non-owning observer — e.g. a test awaiting a turn to settle, or a
   * monitor — that wants the settle signal but must not dispose the agent.)
   *
   * "Quiescence", not merely "status changed": a disposed agent emits
   * `agent/status('disposed')` from inside its disposer, BEFORE the driver loop
   * has unwound — so `whenIdle()` resolving on `disposed` must wait for the loop
   * to actually exit (the implementation chains the loop-exit promise), not just
   * observe the status flip. A mid-step disposal that never reaches `idle` still
   * unblocks the await this way.
   */
  whenIdle(): Promise<void>

  // Subagent delegation is realized on top of this interface by the
  // `@deepseek-ai/dsh-subagent` seam, not by a method here: a backend creates
  // the child through `ctx.agents.create` (fork seeds the child Session with a
  // balanced prefix of the parent's log via `CreateAgentOptions.seed`; spawn
  // starts fresh) and drives it as an ordinary Agent handle, so steer() and
  // event subscription work uniformly. See docs/core-data-structures/subagent.md.
}
```

`AgentStatus` is `'idle' | 'running' | 'disposed'`, and `AgentId` is branded. `AgentOptions` is merge-extensible and currently includes `provider?` and `model?`; dispatch requires both after `agent/request`. Persona belongs to `dsh-system-prompt`: an agent-scoped `deployment:persona` may shadow the global default.

The [event taxonomy](../architecture.md#event) owns the `agent/*` lifecycle, checkpoint, and waterfall contracts. Turn and step boundaries are durable session events rather than agent emits.

## Interception decisions

Each `agent/*` interception waterfall returns a small, seam-specific typed union — the unified Decision idiom (the tool seams' `PreToolDecision`/`PostToolDecision` in [tools.md](tools.md) follow the same shape). A CC/Codex hook bridge maps its `permissionDecision`/`decision`/`continue`/`additionalContext` fields onto these; a native plugin returns them directly. Prompt and post-tool decisions share one model-facing context shape, `HookContext`, which is `inject()`ed as a `context/message` and therefore carries a REQUIRED `source` (a missing source would default to `{kind:'user'}` and mislabel plugin context as a user prompt). Its optional `envelope` selects the canonical context tag or caller-owned raw framing, while JSON `meta` persists plugin state without exposing it to the model. Both decisions carry `additionalContexts[]` so every entry preserves its own provenance, framing, and metadata. Continuation reasons are steering messages instead and deliberately use the narrower content/source shape.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
interface HookContext {
  content: ContentBlock[]
  source: MessageSource
  envelope?: ContextEnvelope
  meta?: JsonValue
}
```

`agent/prompt-submit` returns a `PromptDecision` (allow a drained queued message — optionally rewriting its `content` or attaching `additionalContexts` — or block it; a batch whose every prompt is blocked opens a zero-step turn that ends `rejected`):

```ts type-equiv
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: HookContext[] }
  | { kind: 'block'; reason: string }
```

`agent/turn-continuation` returns a `ContinuationDecision` (the loop's default is `continue` when the step had tool calls or steering was injected, else `stop`; a `continue` `reason` is recorded as next-step steering in the same turn and therefore carries no context envelope or metadata — the typed `/goal` pattern):

```ts type-equiv
type ContinuationDecision =
  | { action: 'stop' }
  | { action: 'continue'; reason?: { content: ContentBlock[]; source: MessageSource } }
```

`agent/turn-stop` returns the stop-only `ContinuationStop` subset or `undefined`. The loop calls this serial checkpoint after folding the ordinary decision, its reason, and pending steering; a stop is terminal and discards pending steering.

```ts type-equiv
type ContinuationStop = Extract<ContinuationDecision, { action: 'stop' }>
```

`agent/session-start` carries a `SessionStartSource` (why the session lifecycle began; a bridge keys its SessionStart matcher on it):

```ts type-equiv
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

`agent/session-prefix` composes a `Message[]` once per loop instance. The deep-frozen result is recorded in the request header and prepended to every derived history, making it the home for session-stable openers. A resumed instance recomposes; mid-session changes use append-only context channels. The waterfall returns content directly because it contributes rather than decides.

## `ToolDefinition`

The one pipeline-authoring type that is core: what every registered tool *is* — a model-facing `ToolSchema` plus an `execute` function and optional UI presenters. A tool author rarely constructs it by hand (the `defineTool` DSL builds it with typed args), but it is the contract the registry holds and the loop dispatches through.

Its full fields, the `defineTool`/`SchemaSpec`/`InferArgs` typed schema DSL, the `ToolExecution`/`ToolExecutionResult` waterfall shapes, and the tool-presentation UI vocabulary are on **[tools.md](tools.md)**.
