# Core

English | [中文](core.zh.md)

The **core** subsystem is [`packages/core`](../../packages/core/README.md) — the control spine every composition boots: the event-sourced session log, system-prompt assembly, the tool registry, the agent vocabulary, and the concrete loop that drives them. This page owns the spine's shared vocabulary — the `Agent` handle, its delivery and interception contracts, and the repo-wide type patterns — and orients to the group's dedicated pages; the folder is indexed in the [subsystems README](README.md).

## The spine, package by package

A turn flows through the six packages in one loop: the driver in [`agent-loop`](../../packages/core/agent-loop) claims a queued prompt, opens a turn on the [session log](session.md) (`ctx.sessions`), assembles the request prefix through [system-prompt](system-prompt.md) (`ctx.systemPrompt`) and derives history from the log, streams the model response through the [LLM seam](llm-streaming.md), dispatches tool calls through the [tool registry](tools.md) (`ctx.tools`), and appends every model-visible fact back onto the log before the next step derives from it.

| Package | Owns | Page |
|---|---|---|
| `session/` | The append-only `SessionEvent` log and in-memory store — the single source of truth (`ctx.sessions`) | [session.md](session.md) |
| `system-prompt/` | Prompt-section and tool-schema assembly (`ctx.systemPrompt`) | [system-prompt.md](system-prompt.md) |
| `tools/` | The scoped tool registry and guarded execution pipeline (`ctx.tools`) | [tools.md](tools.md) |
| `agent/` | The `Agent` interface, live registry, initiator scope, and `agent/*` event vocabulary (`ctx.agents`) | this page |
| `agent-loop/` | The concrete driver implementing the public `Agent` contract (`ctx.agentLoop`) | this page |
| `scope/` | The scoped-registration primitive the registries and loop build per-agent scoping on | [scope.md](scope.md) |

`scope/` is the one non-service package: a dependency-free library (`createScope`/`scopeOf`/`scopeTarget`) that sits below `session/` and `system-prompt/` in the module graph precisely so they can consume it without a cycle. `agent-loop` is the one concrete implementation of the `agent` seam and lives here because it is the harness's default product loop; it runs each driver inside `ctx.agents.withInitiator()`. Extension plugins depend on `agent` — including when they need the initiating Agent — and never on `agent-loop` directly, so the loop stays swappable. The default composition that wires this spine into a runnable agent is [`examples/agent-spine-demo`](../../packages/examples/agent-spine-demo/README.md).

<a id="what-counts-as-core"></a>

## What this page owns

The conversation vocabulary the loop moves — `Message`, `ContentBlock`, `StreamChunk`, the model request — is declared by [`packages/llm`](../../packages/llm/README.md) and documented on [llm-streaming.md](llm-streaming.md); the session-event, prompt-assembly, and tool vocabularies live on this group's dedicated pages above. What remains here is the vocabulary shared by everything: the `Agent` handle and its delivery, cancellation, and interception contracts (declared by `packages/core/agent`), the `SessionEvent` envelope, and the two type patterns every subsystem follows. The scoping rule is recorded in the [subsystems-catalog Agent Note](../../.agents/notes/implemented/process/2026-06-20-core-data-structures-catalog.md): the type you write, hold, or receive is documented where its declaring subsystem is; the machinery that types, renders, or persists it stays on that machinery's page.

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
| `ContentBlockMap` | dsh-llm | `ContentBlock` | [llm-streaming.md](llm-streaming.md#content-blocks-and-messages) |
| `MessageSourceMap` | dsh-llm | `MessageSource` | [llm-streaming.md](llm-streaming.md#content-blocks-and-messages) |
| `FinishReasonMap` | dsh-llm | `FinishReason` | [llm-streaming.md](llm-streaming.md#the-model-request-and-result) |
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

`InboxItemId` is a process-local branded string minted for each accepted FIFO occurrence. It is intentionally distinct from `MessageId`: sending the same immutable message twice creates two independently addressable pending items.

```ts type-equiv
/** One independently addressable accepted occurrence in an agent inbox. */
interface InboxItem {
  /** Agent-loop-minted occurrence identity. */
  readonly id: InboxItemId
  /** Identified message delivered by the caller. */
  readonly message: UserMessage
  /** Acceptance-time FIFO classification. */
  readonly placement: InboxPlacement
}
```

```ts type-equiv
/** A user-requested mutation of one still-pending queued occurrence. */
type InboxAction =
  | { readonly kind: 'edit'; readonly content: ContentBlock[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }
```

```ts type-equiv
/** Result of applying an inbox action at the synchronous ownership boundary. */
type InboxActionResult = 'applied' | 'not-found' | 'steer-unavailable'
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

The fixed-preset aliases own `target` and `wakeup`; their already identified `UserMessage` carries role, content, and provenance. Its `MessageId` remains stable when an edit replaces content or strict steer transfers the immutable message. The original queued occurrence ends and strict steer accepts a new steering occurrence with a distinct `InboxItemId`. Injection bypasses the FIFOs and never appears on inbox lifecycle events.

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

`SteeringReceipt.outcome` always resolves. `admitted` identifies the turn and step whose immutable request history contains that exact message; `rejected` means lifecycle or terminal policy discarded it first. Synchronous input validation still throws from `steer()`.

```ts type-equiv
/** Stable runtime cause accepted by {@link Agent.cancel}. */
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
```

`Agent` is an interface over the public live-agent contract. Concrete drivers own the `followup`/`steer`/`inject` aliases and route them through `send`'s (`target` × `wakeup`) matrix.

```ts type-equiv
/**
 * Public live-agent handle with aliases over the unified delivery primitive.
 * @typert object
 */
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
   * Reserve admission of the next ordinary turn while this agent is idle, so an
   * operation can mutate durable history before any queued prompt derives a
   * request from it. Already-accepted waking work has right of way, including a
   * send whose wake is still a pending microtask. Later sends keep their
   * ordinary placement, FIFO order, and `wakeup` facts, and
   * {@link acceptsNextStep} stays `false`, so a waking `next-step` send becomes
   * a queued follow-up rather than steering; cancellation and disposal may
   * still discard them. {@link inject} is not withheld. {@link whenIdle} treats
   * a live reservation as activity, while lifecycle teardown does not await it.
   * @returns the idempotent release, or `undefined` when the agent is running, already reserved, or already committed to waking work.
   */
  reserveTurnAdmission(): (() => void) | undefined

  /**
   * Mutate one still-pending queued occurrence synchronously. Editing preserves
   * the message identity and queue position; removal publishes its terminal
   * discard. Steer strictly transfers the message into the current next-step
   * window, or returns `steer-unavailable` without changing the queued
   * occurrence. Steering occurrences and driver-claimed items return
   * `not-found`.
   * @param id - independently addressable queued occurrence.
   * @param action - edit, remove, or strict steer operation.
   * @returns the applied outcome or the reason no mutation occurred.
   */
  updateInbox(id: InboxItemId, action: InboxAction): InboxActionResult

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
   * Run one non-turn maintenance task from the true idle phase. The task starts
   * synchronously after claiming that phase; later waking input remains in the
   * inbox until the task settles, while public status stays `idle`.
   * `whenIdle()` follows both the task and any waking work released behind it.
   * @param task - operation whose fulfillment or rejection is preserved, with a signal aborted by {@link cancel}.
   * @throws synchronously when turn-driving or another maintenance task already owns the agent.
   * @returns the task promise.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>

  /**
   * Route identified input to an inbox boundary and optionally wake the driver.
   * Waking input submitted after active cancellation is queued for the next
   * turn and runs when the aborted activity converges to idle; a `disposed`
   * cancel leaves it parked. A wake submitted while already idle always opens
   * its turn boundary, even when its message is cleared before the driver
   * claims ([cancel-convergence wake latch](../../../../.agents/notes/implemented/bug-fix/2026-08-07-cancel-convergence-wake-latch.md)).
   * @param message - identified content and its producer provenance.
   * @param target - the preferred next-turn or next-step inbox boundary.
   * @param wakeup - whether delivery may wake the driver.
   */
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void

  /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and its producer provenance.
   */
  followup(message: UserMessage): void

  /**
   * Submit steering with a message-owned admission receipt — the
   * `next-step`/wakeup preset of {@link send}. During prompt admission or an
   * open turn, the message waits in the steering FIFO until a committed step
   * snapshots it; outside that window it enters the ordinary queued FIFO. The
   * receipt resolves `admitted` only after the message joins that step's
   * immutable request history, or `rejected` when terminal policy,
   * cancellation, or disposal discards it first. A non-terminal turn close may
   * leave it staged for a later admitted prompt without settling the receipt.
   * @param message - identified steering content and its producer provenance.
   * @returns the receipt for this exact message's eventual admission outcome.
   */
  steer(message: UserMessage): SteeringReceipt

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

`AgentStatus` is `'idle' | 'running'`, and `SessionId` is branded. Disposal removes the agent from the registry and emits `agent/disposed`; it is not a terminal status value. `running` describes the driver-wide drain interval and may span consecutive queued turns; it does not prove a turn is still open. `acceptsNextStep` is the narrower routing predicate for callers that must choose between steering the current admission/turn and submitting a fresh admitted prompt. A live turn-admission reservation is quiescence-relevant without changing `status` or turning later queue entries into steering; its only authority is to defer the next driver claim until release. `AgentOptions` is merge-extensible: core declares `provider?`, `model?`, and `maxTokens?` (dispatch requires provider and model after `agent/request`). When present, `maxTokens` must be a positive safe integer and caps every conversation-model request; omission allows the exact-model adapter default to materialize before the request header, or otherwise leaves provider behavior unchanged. Persona belongs to `dsh-system-prompt`: an agent-scoped `deployment:persona` may shadow the global default.

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

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis surface

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` surface lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentloop--agentloop"></a>

### `ctx.agentLoop` — `AgentLoop`

Concrete agent factory and driver service.

```ts cordis-catalog
/**
 * Create an agent and session under one caller-supplied identity, owned by
 * the accessing fiber. Constructor-driven config calls mint a fresh combined
 * id before entering this boundary.
 * @param id - shared agent/session identity.
 * @param options - concrete loop options.
 * @param meta - optional fresh-session workspace metadata.
 * @returns the published running agent.
 */
create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader, 'cwd'> = {}): Agent

/**
 * Create an owned agent on a caller-supplied session id.
 * @param ownerCtx - caller context that structurally owns the lifecycle.
 * @param options - identities, session seed/metadata, loop options, setup, and cancellation.
 * @returns the published handle.
 */
async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>

/**
 * Resume an owned agent from the configured persistence service.
 * @param ownerCtx - caller context that owns load, setup, and the live lifecycle.
 * @param options - persisted identity, loop options, setup, and cancellation.
 * @returns the published handle.
 */
async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
```

Types: [SessionHeader](persistence.md)

Source: [`packages/core/agent-loop/src/index.ts:252`](../../packages/core/agent-loop/src/index.ts)

<a id="ctxagents--agentregistry"></a>

### `ctx.agents` — `AgentRegistry`

Agent service (`ctx.agents`): tracks live agents and carries the initiating Agent through one process-local asynchronous driver chain. Agent *creation* is provided by whichever plugin implements the AgentFactory (`@deepseek-ai/dsh-agent-loop`), registered via setFactory.

Initiator methods provide same-process causal attribution only. Ambient presence is neither liveness proof nor authorization; subjects and owners remain explicit, as does identity at worker, process, persistence, and wire boundaries. Returned Promise boundaries drain during teardown, except a nested lineage that starts an owning-fiber unload is excluded from its own drain.

```ts cordis-catalog
/**
 * Read the Agent that initiated the inherited asynchronous driver chain.
 * Use this optional form for logging, tracing, metrics, or host attribution
 * that also supports agentless calls. When a parent creates a child, setup
 * reports the causal parent while `agentCtx.agent` identifies the child.
 * @returns the inherited Agent, or `undefined` outside an initiator boundary
 *   and inside an explicit clearing boundary.
 * @throws when this service instance has been disposed.
 */
currentInitiator(): Agent | undefined

/**
 * Read the initiating Agent and fail when no initiator boundary is active.
 * Use this for private helpers contractually below a driver, or for a
 * deployment-owned outbound request whose contract forbids agentless calls.
 * Generic or direct-call seams use optional lookup or explicit request fields.
 * @returns the inherited Agent.
 * @throws when no initiator is active or this service instance has been disposed.
 */
requireInitiator(): Agent

/**
 * Run an operation with one exact Agent as its process-local initiator. The
 * exact synchronous value or Promise returned by the operation is preserved.
 * Custom drivers and test harnesses wrap their complete returned foreground
 * lifetime.
 * A queue or wire receiver may establish this boundary only after validating
 * explicit identity and resolving the exact live Agent; this method does neither.
 * Detached work remains owned by the subsystem that starts it.
 * @param agent - initiating Agent to inherit; presence is neither liveness proof nor authorization.
 * @param operation - synchronous or asynchronous operation to invoke.
 * @returns the exact value returned by `operation`.
 * @throws when the initiator scope is closing/disposed, or when `operation` throws.
 */
withInitiator<T>(agent: Agent, operation: () => T): T

/**
 * Run an operation inside a boundary that hides any inherited initiating
 * Agent. The exact synchronous value or Promise is preserved.
 * Use this while creating lazy shared timers, queue pumps, pool maintenance,
 * watchers, or exporters so they do not inherit the first Agent that happens
 * to initialize them. It clears only initiator attribution, not explicit
 * fields, and does not own or drain detached resources.
 * @param operation - synchronous or asynchronous operation to invoke without an initiator.
 * @returns the exact value returned by `operation`.
 * @throws when the initiator scope is closing/disposed, or when `operation` throws.
 */
withoutInitiator<T>(operation: () => T): T

/**
 * Register the agent-creation factory (the loop calls this on construction,
 * effect-scoped). A traced Cordis service is canonicalized to its concrete
 * target; each create/resume call is then traced through that caller's
 * context so ownership follows the caller without stacking proxy layers.
 * Throws if a factory is already registered. Returns the disposer; on
 * dispose the factory slot is cleared.
 * @param factory - the loop-owned factory {@link create}/{@link resume} delegate to.
 * @returns the disposer that clears the factory slot. The exact
 *   Cordis effect disposer (single-shot): composite (generator) effects may
 *   yield it directly — exact identity nests the teardown in order.
 */
setFactory(factory: AgentFactory): () => void

/**
 * Create and publish a new agent through the registered factory.
 * Distinct from {@link register} (which records an already-constructed
 * agent): this constructs the agent and its session. Rejects if no factory is
 * registered or creation/setup fails. The resolved {@link AgentHandle} lets
 * the owner tear down exactly this agent.
 * @param options - shared identity, session seed/metadata, and agent options.
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
async create(options: CreateAgentOptions): Promise<AgentHandle>

/**
 * Load a persisted session and resume an agent on it through the registered
 * factory. Rejects if no factory is registered; the factory rejects if
 * session persistence is not configured or persistence/setup fails.
 * @param options - persisted identity, configuration, and optional setup.
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
async resume(options: ResumeAgentOptions): Promise<AgentHandle>

/**
 * Register a live agent. Throws if an agent with the same id is already
 * registered. Emits `agent/created` on registration and `agent/disposed`
 * when the calling fiber is disposed — both with the agent's scope carrier
 * (`scopeTarget(agent, agent)`): the subject is the agent in hand, so the
 * emits are scope-filtered regardless of which context invoked `register`
 * (calling through `agent.ctx` scopes EFFECTS; dispatch scoping always
 * requires passing the carrier). Returns the disposer.
 * @param agent - the already-constructed agent to record in the store.
 * @returns the EXACT Cordis effect disposer (single-shot; a repeat call
 *   returns undefined without awaiting an in-flight teardown). Exact
 *   identity is load-bearing: a composite (generator) effect that owns a
 *   teardown ORDER — the agent factory's lifecycle chain — must yield THIS
 *   function so Cordis nests the unregistration at that yield position;
 *   yielding a wrapper would leave it disposing as a concurrent sibling on
 *   owner unload, unregistering the agent (and emitting `agent/disposed`)
 *   while its final turn is still draining.
 */
register(agent: Agent): () => void

/**
 * Insert an already-constructed agent without announcing it. This is the
 * advanced ordered-lifecycle primitive used by the async agent factory: it
 * first completes setup while the agent is unpublished, then assigns the
 * returned detach closure into its pre-installed composite teardown before
 * calling {@link announce}. Ordinary callers use {@link register}.
 * @param agent - the prepared, unpublished agent.
 * @param owner - live agent whose scoped context created this agent, or
 *   undefined for a top-level runtime root. This is runtime ownership, not
 *   the resumed session's durable parent lineage.
 * @returns an idempotent closure that removes this exact entry and emits
 *   `agent/disposed` with listener failures contained. When called from a
 *   synchronous `agent/created` listener, removal and disposal wait until
 *   that creation dispatch unwinds.
 */
enter(agent: Agent, owner: Agent | undefined): () => void

/**
 * Announce an agent previously inserted with {@link enter}.
 * @param agent - the live inserted agent to announce.
 * @throws if `agent` is not the exact live registry entry for its id, or its
 *   creation announcement already began (including a reentrant call from a
 *   creation listener).
 */
announce(agent: Agent): void

/**
 * Look up a live agent.
 * @param id - the shared agent/session id to look up.
 * @returns the agent, or undefined when no live agent has that id.
 */
get(id: SessionId): Agent | undefined

/**
 * Test whether a live agent was created through one exact parent agent's
 * scoped context. Runtime ownership is independent of durable session
 * lineage and remains unambiguous when unrelated providers reuse an id.
 * @param id - the candidate child agent's shared agent/session id.
 * @param owner - the expected runtime creator agent.
 * @returns true only while the exact child entry is live under that owner.
 */
isOwnedBy(id: SessionId, owner: Agent): boolean

/**
 * All live agents, in registration order.
 * @returns a fresh array; mutating it does not affect the registry.
 */
list(): Agent[]

/**
 * All live top-level agents in registration order. A top-level agent was
 * created without an owning agent context; durable session lineage does not
 * affect this runtime relation, so a resumed fork may still be a root.
 * @returns a fresh array; mutating it does not affect the registry.
 */
roots(): Agent[]
```

Source: [`packages/core/agent/src/index.ts:242`](../../packages/core/agent/src/index.ts)

<a id="agent-events"></a>

### `agent/*` events

<a id="agentcancel-requested--emit"></a>

#### `agent/cancel-requested` — emit

Effective broad cancellation was requested, before queued/outbox work is cleared or the active turn is aborted. This observe-only notification cannot veto cancellation; listener failures are contained.

```ts cordis-catalog
/**
 * Effective broad cancellation was requested, before queued/outbox work
 * is cleared or the active turn is aborted. This observe-only notification
 * cannot veto cancellation; listener failures are contained.
 * @param agent - the agent whose current work is being cancelled.
 * @param cause - the explicit typed cancellation cause.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/cancel-requested'(this: Scoped<Agent>, agent: Agent, cause: AgentCancelCause): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:353`](../../packages/core/agent/src/types.ts)

<a id="agentcreated--emit"></a>

#### `agent/created` — emit

A fully configured agent and live session were published. Setup is composition-only; `agent/session-start` is the first startup-driving seam. Synchronous listener failure vetoes publication, while returned-promise rejection is reported. Detach requested during dispatch waits until every creation listener has observed the stable entry.

```ts cordis-catalog
/**
 * A fully configured agent and live session were published. Setup is
 * composition-only; `agent/session-start` is the first startup-driving seam.
 * Synchronous listener failure vetoes publication, while returned-promise
 * rejection is reported. Detach requested during dispatch waits until every
 * creation listener has observed the stable entry.
 * @param agent - the newly registered agent with its live session and completed setup.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/created'(this: Scoped<Agent>, agent: Agent): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:158`](../../packages/core/agent/src/types.ts)

<a id="agentdisposed--emit"></a>

#### `agent/disposed` — emit

An agent left the registry; AgentLoop emits this after driver quiescence and scoped-registration unwind, but before session detachment. Custom registry users own their driver-ordering contract.

```ts cordis-catalog
/**
 * An agent left the registry; AgentLoop emits this after driver quiescence
 * and scoped-registration unwind, but before session detachment. Custom
 * registry users own their driver-ordering contract.
 * @param agent - the exact agent removed from the registry.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/disposed'(this: Scoped<Agent>, agent: Agent): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:167`](../../packages/core/agent/src/types.ts)

<a id="agenterror--emit"></a>

#### `agent/error` — emit

A step or turn errored. The machine reports a failure here (plus the logger) even when the error has no in-turn position for a durable record.

```ts cordis-catalog
/**
 * A step or turn errored. The machine reports a failure here (plus the
 * logger) even when the error has no in-turn position for a durable record.
 * @param agent - the agent whose turn errored.
 * @param turn - the turn in which the failure surfaced.
 * @param step - the step at which the failure surfaced.
 * @param error - the failure, verbatim.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: unknown): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:289`](../../packages/core/agent/src/types.ts)

<a id="agentinboxdequeue--emit"></a>

#### `agent/inbox/dequeue` — emit

The driver claimed one item out of the inbox: a queued item at a turn boundary, or steering drained between steps. Fires after the item leaves its FIFO and before it becomes a durable message.

```ts cordis-catalog
/**
 * The driver claimed one item out of the inbox: a queued item at a turn
 * boundary, or steering drained between steps. Fires after the item leaves
 * its FIFO and before it becomes a durable message.
 * @param agent - the agent whose inbox item was claimed.
 * @param item - the exact claimed occurrence.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/inbox/dequeue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:196`](../../packages/core/agent/src/types.ts)

<a id="agentinboxdiscard--emit"></a>

#### `agent/inbox/discard` — emit

Pending inbox items were dropped without delivering them, so every enqueue occurrence receives exactly one terminal `agent/inbox/dequeue` OR `agent/inbox/discard`. `cancel()` without `keepInbox`, including disposal, emits this after `agent/cancel-requested` when applicable and before aborting the active work. Fires once per drop with every dropped item.

```ts cordis-catalog
/**
 * Pending inbox items were dropped without delivering them, so every
 * enqueue occurrence receives exactly one terminal `agent/inbox/dequeue` OR
 * `agent/inbox/discard`. `cancel()` without `keepInbox`, including disposal,
 * emits this after `agent/cancel-requested` when applicable and before
 * aborting the active work. Fires once per drop with every dropped item.
 * @param agent - the agent whose inbox items were dropped.
 * @param items - the discarded occurrences in FIFO order (queued then steering); never empty.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/inbox/discard'(this: Scoped<Agent>, agent: Agent, items: InboxItem[]): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:204`](../../packages/core/agent/src/types.ts)

<a id="agentinboxenqueue--emit"></a>

#### `agent/inbox/enqueue` — emit

An item entered the queued or steering inbox. `placement` is the acceptance-time routing result; listeners must not reconstruct it from later agent or session state.

```ts cordis-catalog
/**
 * An item entered the queued or steering inbox. `placement` is the
 * acceptance-time routing result; listeners must not reconstruct it from
 * later agent or session state.
 * @param agent - the owning agent.
 * @param item - accepted occurrence, message, and resolved placement.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/inbox/enqueue'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:185`](../../packages/core/agent/src/types.ts)

<a id="agentinboxupdate--emit"></a>

#### `agent/inbox/update` — emit

A still-pending queued item changed content. The item id, placement, and position remain stable while the event carries the replacement message.

```ts cordis-catalog
/**
 * A still-pending queued item changed content. The item id, placement, and
 * position remain stable while the event carries the replacement message.
 * @param agent - the owning agent.
 * @param item - the complete post-update occurrence.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/inbox/update'(this: Scoped<Agent>, agent: Agent, item: InboxItem): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:321`](../../packages/core/agent/src/types.ts)

<a id="agentprompt-submit--waterfall"></a>

#### `agent/prompt-submit` — waterfall

Allow, rewrite, or block one claimed prompt before it becomes a user message or opens a turn. Call `next()` for the unchanged default. The signal controls only this admission attempt; listeners may cooperate with it but must not retain it for a later attempt or turn.

```ts cordis-catalog
/**
 * Allow, rewrite, or block one claimed prompt before it becomes a user
 * message or opens a turn. Call `next()` for the unchanged default. The
 * signal controls only this admission attempt; listeners may cooperate with
 * it but must not retain it for a later attempt or turn.
 * @param agent - the agent whose turn claimed the message.
 * @param message - the frozen claimed message, including identity and source.
 * @param signal - the current turn's explicit abort signal.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode waterfall
 */
'agent/prompt-submit'(this: Scoped<Agent>, agent: Agent, message: UserMessage, signal: AbortSignal, next: () => Promise<PromptDecision>): Promise<PromptDecision>
```

Types: [Scoped](scope.md) · [UserMessage](session.md)

Source: [`packages/core/agent/src/types.ts:230`](../../packages/core/agent/src/types.ts)

<a id="agentrequest--waterfall"></a>

#### `agent/request` — waterfall

Replace the frozen call configuration. `await next()` yields the config the machine would use (agent options on the first request, the logged header afterwards); return a replacement to switch. Model-visible content must use logged channels; this seam cannot mutate messages.

```ts cordis-catalog
/**
 * Replace the frozen call configuration. `await next()` yields the config
 * the machine would use (agent options on the first request, the logged
 * header afterwards); return a replacement to switch. Model-visible
 * content must use logged channels; this seam cannot mutate messages.
 * @param agent - the agent making the model call.
 * @param turn - the open turn number.
 * @param step - the step whose request this is.
 * @param signal - the current turn's explicit abort signal.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode waterfall
*/
'agent/request'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, signal: AbortSignal, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```

Types: [LlmCallConfig](llm-streaming.md) · [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:243`](../../packages/core/agent/src/types.ts)

<a id="agentrequest-error--waterfall"></a>

#### `agent/request-error` — waterfall

Handle a model-request failure after its failed step has closed but before the failed turn closes. A listener returns `{ kind: 'retry' }` without calling `next()` when it owns the error, or calls `next()` to delegate. The default `undefined` leaves the failure terminal.

```ts cordis-catalog
/**
 * Handle a model-request failure after its failed step has closed but
 * before the failed turn closes. A listener returns `{ kind: 'retry' }`
 * without calling `next()` when it owns the error, or calls `next()` to
 * delegate. The default `undefined` leaves the failure terminal.
 * @param agent - the agent whose request failed.
 * @param turn - the open turn number.
 * @param step - the failed step number.
 * @param error - the original model-request failure.
 * @param failure - serializable facts normalized at the final adapter boundary.
 * @param priorFailures - immutable failures that already authorized another
 * retry turn in this consecutive sequence.
 * @param retryPolicy - immutable policy of the adapter registration that served
 * the failed request, or `undefined` if no final adapter served it.
 * @param signal - the turn abort signal.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode waterfall
 */
'agent/request-error'(this: Scoped<Agent>, agent: Agent, turn: number, step: number, error: RequestError, failure: LlmFailure, priorFailures: readonly LlmFailure[], retryPolicy: ResolvedRetryPolicy | undefined, signal: AbortSignal, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>
```

Types: [LlmFailure](llm-streaming.md) · [ResolvedRetryPolicy](llm-streaming.md) · [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:259`](../../packages/core/agent/src/types.ts)

<a id="agentsession-start--emit"></a>

#### `agent/session-start` — emit

The session lifecycle began, once before the first turn. Use `agent.inject()` to seed model-facing context. This is a notification, not a veto; disposal requested by a lifecycle owner is rechecked before the driver starts.

```ts cordis-catalog
/**
 * The session lifecycle began, once before the first turn. Use
 * `agent.inject()` to seed model-facing context. This is a notification, not
 * a veto; disposal requested by a lifecycle owner is rechecked before the
 * driver starts.
 * @param agent - the agent whose session lifecycle began.
 * @param source - why the session started (fresh startup, resume, …).
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/session-start'(this: Scoped<Agent>, agent: Agent, source: SessionStartSource): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:216`](../../packages/core/agent/src/types.ts)

<a id="agentstatus--emit"></a>

#### `agent/status` — emit

Agent status changed (`idle` ⇄ `running`). `send()` does not enter `running` synchronously; drive lifecycle from this event.

```ts cordis-catalog
/**
 * Agent status changed (`idle` ⇄ `running`). `send()` does not enter
 * `running` synchronously; drive lifecycle from this event.
 * @param agent - the agent whose status flipped.
 * @param status - the status just entered (the transition's destination).
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode emit
 */
'agent/status'(this: Scoped<Agent>, agent: Agent, status: AgentStatus): void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:177`](../../packages/core/agent/src/types.ts)

<a id="agentturn-stopping--serial"></a>

#### `agent/turn-stopping` — serial

The turn is about to close: the model owes no response (no live tool calls, no fresh steering). Awaited before the boundary commits — a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn. Data decides, so listener order cannot change the outcome. The inverse control (stop a tool loop early) is data too: a tool result carrying `concludesTurn` ends the turn at its step.

```ts cordis-catalog
/**
 * The turn is about to close: the model owes no response (no live tool
 * calls, no fresh steering). Awaited before the boundary commits — a
 * listener that objects steers (`agent.steer(...)`) and the machine
 * re-reads its inbox: fresh steering runs another step, none closes the
 * turn. Data decides, so listener order cannot change the outcome. The
 * inverse control (stop a tool loop early) is data too: a tool result
 * carrying `concludesTurn` ends the turn at its step.
 * @param agent - the agent whose turn is at its stop boundary.
 * @param turn - the turn about to close.
 * @param signal - the current turn's explicit abort signal.
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
 * @mode serial
 */
'agent/turn-stopping'(this: Scoped<Agent>, agent: Agent, turn: number, signal: AbortSignal): Promise<void> | void
```

Types: [Scoped](scope.md)

Source: [`packages/core/agent/src/types.ts:277`](../../packages/core/agent/src/types.ts)

<a id="agent-loop-events"></a>

### `agent-loop/*` events

<a id="agent-loopconfig-start-failed--emit"></a>

#### `agent-loop/config-start-failed` — emit

A declarative agent entry failed before it could publish a live agent. Consumers that buffer work for the configured identity use this transient signal to reject that work instead of waiting forever. Normal factory teardown suppresses failures from the cancelled startup attempt.

```ts cordis-catalog
/**
 * A declarative agent entry failed before it could publish a live agent.
 * Consumers that buffer work for the configured identity use this
 * transient signal to reject that work instead of waiting forever. Normal
 * factory teardown suppresses failures from the cancelled startup attempt.
 * @param sessionId - exact shared agent/session identity that failed startup.
 * @param error - persistence, setup, or publication failure.
 * @mode emit
 */
'agent-loop/config-start-failed'(sessionId: SessionId, error: unknown): void
```

Source: [`packages/core/agent-loop/src/index.ts:157`](../../packages/core/agent-loop/src/index.ts)
<!-- END GENERATED cordis-surface -->
