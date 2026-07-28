# Core Data Structures

English | [中文](core.zh.md)

This folder catalogs the **data structures** of the DeepSeek Harness — what each core type represents, its literal shape, and where the full detail lives. It complements [architecture.md](../architecture.md), which describes *behavior* (the service map, the session/turn/step lifecycle, the event taxonomy); this page describes the *vocabulary* that behavior moves around.

## What counts as "core"

The harness is a microkernel: a tiny core plus many plugins. Most types belong to one plugin or one capability. A handful, though, are the **spine** — the language the agent loop and its events traffic in on *every* turn, no matter which optional plugins are loaded. Those are "core".

Precisely, a data structure is **core** if either:

1. it flows through the agent-loop spine — the loop holds it, derives it, streams it, or logs it on every turn (a `Message`, a `StreamChunk`, a `SessionEvent`, the `Agent` handle itself), independent of which plugins are present; **or**
2. it is the single headline type a plugin author writes against a pipeline — `ToolDefinition` (what every tool *is*).

Everything else is documented on a **sub-page**, not here. The rule that draws the line: *the type you write, hold, or receive is core; the machinery that types it, renders it, or persists it is a sub-page detail.* So `ToolDefinition` is core, but the `ValueSchemaSpec`/`ParameterSchemaSpec` inference machinery that types it, the `ToolCallView`/`ToolResultView` render-intent vocabulary that renders it, and the `SessionPersistence` seam that stores the event log are not — they live on the sub-pages below.

| Sub-page | Owns |
|---|---|
| [llm-streaming.md](llm-streaming.md) | the `StreamChunk` wire protocol + adapter contract, `BlockAssembler`, the `LlmAdapter` seam |
| [token-meter.md](token-meter.md) | immutable scalar and positional replay measurements with consumed-log revisions |
| [scope.md](scope.md) | scoped registration identity, dispatch carriers, and the owned `Scope` context |
| [goal.md](goal.md) | persisted goal identity, lifecycle snapshots, activation, change records, and round attribution |
| [commands.md](commands.md) | the human-command seam: definitions, adapter discovery, direct invocation, results, and parsing views |
| [session.md](session.md) | the full `SessionEventMap` variant catalog, `TurnTrigger`/`TurnEndReason`, `deriveMessages()`, execution enclosure, and standalone events |
| [persistence.md](persistence.md) | the durability seam: `SessionPersistence`, JSONL + SQLite backends, `session/flush`, crash recovery, `SessionHeader` |
| [session-query.md](session-query.md) | logical records, bounded exact-event reads, relationship traces, semantic filters/documents, and full-text result pages |
| [session-title.md](session-title.md) | durable title snapshots, source provenance, and the asynchronous provider contract |
| [system-prompt.md](system-prompt.md) | per-assembly context, tool-provider results, prompt sections, and cooperative assembly |
| [tools.md](tools.md) | `ToolDefinition` full fields, the schema DSL, `ToolExecution`/`ToolResult`, tool-presentation UI types, and the guarded execution pipeline |
| [user-interaction.md](user-interaction.md) | the UI-backed human question/answer seam: `AskUserQuestionRequest`, answer/options vocabulary, provider API, error taxonomy |
| [approval.md](approval.md) | the one-shot user-approval seam: `ApprovalRequest`, `ApprovalOutcome`, per-session policy, audit and answerer contracts |
| [bash.md](bash.md) | the bash executor seam: `BashExecRequest`/`Spec`, `BashRunResult`, background `BashProcess` handles |
| [subprocess.md](subprocess.md) | the subprocess seam: fully-explicit `SubprocessSpawnSpec`, offset-based output readers, unclassified `SubprocessOutcome`, and the managed `DSH_*` environment vocabulary |
| [pty.md](pty.md) | persistent terminal ids, backend/session contracts, send readiness, bounded reads, and owner-visible snapshots |
| [sandbox.md](sandbox.md) | per-session policy resolution and the process-confinement seam: file-effect modes, execution/provider policies, `ConfinedArgv`, enforcement and fail-closed errors |
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

Source: [`packages/llm/llm/src/message.ts`](../../packages/llm/llm/src/message.ts)

A `Message` is one identified, immutable role/source/content value. Model-produced assistant messages carry provider/model ownership and optional adapter-private replay metadata in their source:

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
/** One immutable message representation shared by delivery, durable history, and model requests. */
interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required producer provenance. */
  readonly source: MessageSource
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
  model: ModelMessageSource
  tool: ToolMessageSource
}
```

## Streaming

Adapters emit a raw **chunk** protocol; the loop logs the chunks (replay fidelity) while feeding the same chunks through a `BlockAssembler` to rebuild blocks and messages. `StreamChunk` is a closed discriminated union over `type` — `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`.

The full union, the adapter contract (usage-before-finish, raw-JSON tool arguments, the two sanctioned error paths), and `BlockAssembler` live on **[llm-streaming.md](llm-streaming.md)**.

<a id="the-model-request-and-result"></a>

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

Correctness-sensitive metadata is resolved separately from the advisory catalog and is owned by the adapter serving the exact route. Context capacity and reasoning choices share one exact-model result so consumers do not repeat authoritative model resolution.

```ts type-equiv
/** Provider-owned context capacity for one exact provider/model route. */
interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}
```

Reasoning effort is another exact-route capability. The core brands identifiers but does not enumerate their values; each adapter owns the ordered set, display names, and optional deployment default.

```ts type-equiv
/** Adapter-owned identifier for one model's selectable reasoning effort. */
type ReasoningEffortId = Branded<'ReasoningEffortId'>
```

```ts type-equiv
/** Display metadata for one adapter-owned reasoning effort. */
interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}
```

```ts type-equiv
/** Selectable reasoning efforts for one exact provider/model route. */
interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}
```

```ts type-equiv
/** Exact-route model metadata resolved by its owning adapter. */
interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo
}
```

```ts type-equiv
/** A single model request, fully assembled. */
interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
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
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title'
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

The loop builds each request from logged state. `EpochHeader` records call config, rendered prompt, and authoritative returned tool order (configured by `toolOrder`, or lexicographic when unset) through full `request/header` snapshots. Together with derived history, this makes the request reconstructable from the session log. See [session.md](session.md#the-request-header-event-requestheader) and the [reconstructability Agent Note](../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md).

`agent/request` receives a frozen call-config seed and may return a replacement to switch provider, model, reasoning effort, or sampling. After the waterfall, the loop prepares the exact model capability under the turn signal, rejects unsupported explicit effort ids without clamping, materializes an adapter-configured default, and logs the effective value. The prepared call keeps one adapter registration through dispatch. Requests reaching `llm/stream` are deep-frozen, so mutation throws, and carry a process-local loop identity so observers do not confuse separately logged frozen auxiliary calls with conversation requests.

On the wire, a loop-built request reads the `system` slot (the rendered prompt assembly) followed by the derived history — the boundary snapshot, whose tail is the newest `user/message` on a turn's first step and the previous step's tool results on later steps. The dev invariant recomputes exactly this equation against every loop-built request.

FIXME(call-config-shape): revisit which remaining fields are genuinely epoch-level for cache purposes (`model` and the model-owned reasoning effort are explicit; the sampling scalars sit here out of caution).

```ts type-equiv
/**
 * Provider, model, reasoning effort, and sampling scalars of one conversation's
 * requests. Every field maps 1:1 onto the same-named `GenerateOptions` field;
 * the loop builds requests from the logged header rather than accepting these
 * per call.
 */
interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
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
 * `assistant/message`, `tool/result`, `steering/message`).
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

The twelve event variants (`turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `steering/message`, `todo/write`, `request/header`), the `deriveMessages()` projection rules, the `TurnTrigger`/`TurnEndReason` reasons, and the execution-enclosure and standalone-event rules are on **[session.md](session.md)**. How the log is made durable — the `SessionPersistence` seam, JSONL/SQLite backends, the `session/flush` checkpoint, crash recovery, and `SessionHeader` — is on **[persistence.md](persistence.md)**.

## The agent handle

`Agent` is the surface every plugin (UI, hooks, orchestrators) programs against. The concrete implementation is package-internal to dsh-agent-loop; nothing outside the loop depends on it.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

```ts type-equiv
/**
 * Which inbox queue a {@link Agent.send} item joins:
 * - `next-turn` — the item becomes its own turn, claimed at a turn boundary.
 * - `next-step` — during prompt admission or an open turn, the item stages for
 *   the next safe step boundary; otherwise it is promoted per its `wakeup`
 *   flag.
 */
type SendTarget = 'next-turn' | 'next-step'
```

```ts type-equiv
/** Resolved inbox placement reported when an accepted message is enqueued. */
type InboxPlacement = 'queued' | 'steering'
```

```ts type-equiv
/**
 * Options for the unified {@link Agent.send} primitive over the
 * (`target` × `wakeup`) matrix. Named presets: {@link Agent.followup}
 * (`next-turn`/wakeup), {@link Agent.steer} (`next-step`/wakeup), and
 * {@link Agent.inject} (`next-step`/no-wakeup).
 *
 * The object is complete so routing policy is explicit.
 */
interface SendOptions {
  /** Queue the item joins. */
  target: SendTarget
  /**
   * Whether this item makes the model run: wake a parked driver (`next-turn`)
   * or force a continuation step (`next-step` while running). A `false`
   * `next-turn` item queues without waking; a `false`
   * `next-step` item attaches durable context without forcing another step
   * (the injection preset).
   */
  wakeup: boolean
}
```

The fixed-preset aliases own `target` and `wakeup`; their already identified `UserMessage` carries role, content, and provenance. Its `MessageId` remains stable across that message's `agent/inbox/*` events without being returned by the delivery methods. Injection bypasses the FIFOs and never appears on those events.

```ts type-equiv
/** Options for {@link Agent.cancel}. */
interface CancelOptions {
  /**
   * Preserve queued and steering inbox items instead of discarding them. The
   * active turn is still aborted, but un-started and pending work survives for a
   * later turn and no `agent/inbox/discard` fires.
   */
  keepInbox?: boolean
}
```

```ts type-equiv
/** Stable runtime cause accepted by {@link Agent.cancel}. */
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
```

`Agent` is an interface over the public live-agent contract. Concrete drivers own the `followup`/`steer`/`inject` aliases and route them through `send`'s (`target` × `wakeup`) matrix.

```ts type-equiv
/** Public live-agent handle with aliases over the unified delivery primitive. */
interface Agent {
  /** The single identity shared with {@link session}. */
  readonly id: SessionId
  /** The provider route and model this agent's requests use. */
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** The current lifecycle state, mirrored on every `agent/status` transition. */
  readonly status: AgentStatus
  /**
   * Whether a `next-step` send currently stages for prompt admission or the
   * open turn. Unlike {@link status}, this excludes admission exit and turn
   * settlement, when a waking `next-step` send becomes a queued follow-up.
   */
  readonly acceptsNextStep: boolean
  /** Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject registration afterward. */
  readonly ctx: Context

  /**
   * The unified delivery primitive over the (`target` × `wakeup`) matrix.
   * It routes the caller's typed content and source as follows:
   *
   * - `next-turn` queues an item that becomes the sole ordinary message of its
   *   own FIFO-ordered turn; `wakeup:true` wakes a
   *   parked driver, while `wakeup:false` queues without waking.
   * - `next-step` with `wakeup:true` stages steering during prompt admission
   *   or an open turn; outside that window it falls back to a woken
   *   `next-turn`.
   * - `next-step` with `wakeup:false` injects durable model-facing context
   *   without running the model: admission or an open turn stages it for the
   *   next safe log position, while an injection outside that window appends
   *   immediately without opening a turn. If admission closes without a turn,
   *   a context-only boundary appends immediately; context staged beside
   *   steering remains pending with it.
   * The agent publishes or queues the identified frozen message as-is.
   * @param message - identified model-facing content and its producer provenance.
   * @param options - target queue and wakeup decision.
   */
  send(message: UserMessage, options: SendOptions): void

  /**
   * Clear queued and steering work — unless `keepInbox` — and abort the active
   * turn. An effective call first emits `agent/cancel-requested` with the
   * resolved typed cause. The first cause wins for the active turn, and
   * `whenIdle()` resolves after cancellation reaches quiescence. Idle
   * cancellation is a no-op and does not arm later work.
   * @param cause - the stable caller intent carried by the current turn signal.
   * @param options - cancellation options; `keepInbox` preserves pending work.
   */
  cancel(cause: AgentCancelCause, options?: CancelOptions): void

  /** Resolve at idle quiescence; disposal waits for driver exit rather than only the status transition. */
  whenIdle(): Promise<void>

  /**
   * Queue an ordinary follow-up turn and wake the driver — the
   * `next-turn`/wakeup preset of {@link send}. The item becomes the sole
   * ordinary message of its own turn.
   * @param message - identified prompt content and its producer provenance.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering during prompt admission or an open turn — the
   * `next-step`/wakeup preset of {@link send}. It stages for the next steering
   * checkpoint before a request or stop decision. If the activity fails before
   * that boundary, the remainder stays staged without waking the agent; retry
   * or a later prompt takes it. Outside that window steering falls back to a
   * woken follow-up turn, while cancellation or disposal may discard pending
   * steering.
   * @param message - identified steering content and its producer provenance.
   */
  steer(message: UserMessage): void

  /**
   * Append model-facing context without running the model — the
   * `next-step`/no-wakeup preset of {@link send}. Admission or an open turn
   * stages it at the next safe log position; outside that window it appends
   * immediately without opening a turn. If admission closes without a turn,
   * a context-only boundary appends immediately; context staged beside
   * steering remains pending with it.
   * @param message - identified injected context and its producer provenance.
   */
  inject(message: UserMessage): void
}
```

`AgentStatus` is `'idle' | 'running'`, and `SessionId` is branded. Disposal removes the agent from the registry and emits `agent/disposed`; it is not a terminal status value. `running` describes the driver-wide drain interval and may span consecutive queued turns; it does not prove a turn is still open. `acceptsNextStep` is the narrower routing predicate for callers that must choose between steering the current admission/turn and submitting a fresh admitted prompt. `AgentOptions` is merge-extensible: core declares `provider?`, `model?`, and `maxTokens?` (dispatch requires provider and model after `agent/request`). When present, `maxTokens` must be a positive safe integer and caps every conversation-model request; omission leaves the provider default in control. Persona belongs to `dsh-system-prompt`: an agent-scoped `deployment:persona` may shadow the global default.

The cause is a TypeScript-enforced same-process input. An active `TurnCancellation` holder copies its discriminant into the runtime-only `AbortSignal.reason` and is retired before `turn/end` publication; the frozen `AbortSignal.reason` remains readable after that retirement. Only the loop reads the cause (`user`, `parent`, or lifecycle-only `disposed`) back off its own machine-private signal at settlement — there is no public reader, and a signal grants cooperating listeners no classification authority. Durable `turn/end` retains the coarse `{ kind: 'aborted' }` outcome; request provenance would require a separate durable event rather than overloading the terminal result.

The [event taxonomy](../architecture.md#event) owns the `agent/*` lifecycle, checkpoint, and waterfall contracts. Turn and step boundaries are durable session events rather than agent emits.

## Initiating Agent

The process-local initiator carried by `ctx.agents` is the exact `Agent` above, not a separate frame or copied identity. Ambient presence is neither liveness proof nor authorization; the [initiator-scope decision](../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.md) owns its lifetime and boundary rules.

## Interception decisions

Prompt and post-tool decisions use the same identified `UserMessage` shape as durable user-role input. Each `additionalContexts` entry becomes a separate `user/message`, preserving its identity and provenance. Hook bridges map their native decision fields onto these typed results.

Source: [`packages/core/agent/src/types.ts`](../../packages/core/agent/src/types.ts)

`agent/prompt-submit` returns a `PromptDecision` before a turn opens. Allow may rewrite the claimed prompt or attach `additionalContexts`; block rejects admission without creating turn events:

```ts type-equiv
/**
 * Prompt interception result. `allow.content` replaces the prompt, while
 * `additionalContexts` appends model-facing context before the turn starts.
 * An `allow` returned by a listener is authoritative: a listener wrapping
 * `next()` preserves both fields unless it intentionally replaces them.
 */
type PromptDecision =
  | { kind: 'allow'; content?: ContentBlock[]; additionalContexts?: UserMessage[] }
  | { kind: 'block'; reason: string }
```

`agent/request-error` runs after a failed model step closes and before its turn closes. Listeners can repair durable state or await policy work while the failed turn's signal is still live. A handling listener returns `{ kind: 'retry' }` without calling `next()`; the default `undefined` leaves the failure terminal.

```ts type-equiv
/** Action returned by a listener that owns model-request recovery. */
type RequestErrorAction = { kind: 'retry' } | undefined
```

```ts type-equiv
/** Model-request failure with an optional machine-routable provider code. */
type RequestError = Error & { code?: string }
```

`agent/step` is the single serial boundary before request derivation. `agent/turn-stopping` runs when a turn has no tool or steering continuation, before one final steering drain.

`agent/session-start` carries a `SessionStartSource` (why the session lifecycle began; a bridge keys its SessionStart matcher on it):

```ts type-equiv
/** Why a session lifecycle began; seeded creates are `startup`, while persisted loads are `resume`. */
type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'
```

## `ToolDefinition`

The one pipeline-authoring type that is core: what every registered tool *is* — a model-facing `ToolSchema` plus an `execute` function and optional final-content and UI callbacks. A tool author rarely constructs it by hand (the `defineTool` DSL builds it with typed args), but it is the contract the registry holds and the loop dispatches through.

Its full fields, the `defineTool`/`ValueSchemaSpec`/`ParameterSchemaSpec` typed schema DSL, the `ToolExecution`/`ToolExecutionResult` waterfall shapes, and the tool-presentation UI vocabulary are on **[tools.md](tools.md)**.
