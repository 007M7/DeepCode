# @deepseek-ai/dsh-subagent

The **subagent seam**: an abstract `SubagentService` (`ctx.subagents`) for an agent delegating work to another agent. A *subagent* is a child agent; a `SubagentProvider` is one transport for running it.

This package is the interface third of the capability seam, split so each concern evolves (and swaps) independently:

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-subagent` (this) | the interface: registry service + vocabulary types |
| `@deepseek-ai/dsh-subagent-spawn` | an implementation: fresh in-process child |
| `@deepseek-ai/dsh-subagent-fork` | an implementation: in-process child seeded from the parent's log |
| `@deepseek-ai/dsh-subagent-acp` | an implementation: ACP client driving another process |
| `@deepseek-ai/dsh-tool-subagent` | the model-facing tool over `ctx.subagents` |

Unlike the bash seam (one executor per context, second load throws), **multiple providers coexist** here. Each registers under a unique name and a caller picks one by name — the shape mirrors the LLM adapter registry (`LlmService.registerAdapter`), not the single-service bash executor. This is the requirement that rules out the bash shape: an agent may want an in-process child for a cheap subtask and an out-of-process ACP child for an isolated one, in the same runtime.

## Service API (`ctx.subagents`)

| Member | Semantics |
|---|---|
| `registerProvider(provider)` | Register a frozen acceptance snapshot under `provider.name`; later caller mutation cannot change registry behavior or HMR cleanup, while `start` stays bound to the original provider receiver. Throws `SubagentError('DUPLICATE_PROVIDER')` on a name clash. Effect-scoped (HMR-safe); returns the disposer. |
| `getProvider(name)` | Look up the frozen registry snapshot (`undefined` if absent). |
| `list()` | Registered provider names (insertion order). |
| `start(name, request)` | Resolve the provider (`NO_PROVIDER` if absent), validate every requested START-TIME capability (`UNSUPPORTED_CAPABILITY` for the first unmet one — before any child is created), then delegate to `provider.start`. Emit `subagent/start` only after `run.started` fulfills and the paired `subagent/end` after that started run settles; a pre-publication readiness rejection emits neither. |

## Capabilities: two kinds, discovered two ways

- **Start-time features** (`outputSchema`, `depthLimit`, `toolFilter/persona`) are a static `provider.capabilities` descriptor, checked by the service BEFORE a run exists. A request that needs one the provider lacks is **rejected loud** (`UNSUPPORTED_CAPABILITY`), never accepted-then-ignored.
- **Runtime features** (steering, resume) are **optional methods** on `SubagentRun` (`sendMessage?`, `resume?`). The method's presence IS the capability; TS narrowing is the discovery mechanism — a consumer cannot call an absent method without narrowing first, so there is no silent degradation path.

Beside `capabilities` sits one DESCRIPTIVE fact, not validated by the service: `provider.inheritsParentContext` — whether a child sees the parent conversation (`fork`: true — seeded with the completed-turn prefix; `spawn`/`acp`: false). The model-facing consumer (`dsh-tool-subagent`) derives truthful tool wording from it.

## Run lifecycle

`provider.start(request)` returns a `SubagentRun`: a handle with `started` (the publication/readiness promise), `result` (the terminal outcome), `cancel()`, `dispose()`, and the optional runtime methods. `started` resolves only after the provider has established a real child and rejects if the attempt fails or is cancelled first. `result` resolves with a `SubagentResult` (`output`, optional `structured`, `stopReason`) — it does **not** reject on a child-level failure (a model/transport failure resolves with `stopReason: 'error'`), so the consumer maps a non-`completed` reason to an `isError` tool result. The consumer MUST `dispose()` on every path (success, error, abort) to reach child quiescence and avoid leaking an idle child / session.

The service emits provider-added and provider-removed after registry changes, so consumers track membership without assuming sibling load order. A run emits `subagent/start` only after readiness and `subagent/end` only after that announced run settles; readiness rejection emits neither. Both are observe-only. Result settlement is observed immediately, cloned, and buffered until start to prevent unhandled rejection, preserve start-before-end ordering, and isolate listener mutation. Settled output appears as `lastAssistantMessage`; infrastructure rejection omits it. Remote providers need not publish a local agent.

## Scope (first cut)

The consumer collects **synchronously**: it starts a run and awaits `result`. Steering (`sendMessage`) is part of the contract but intentionally unused. Background / poll / spill semantics are deferred to a future redesign unifying long-running-tool handling across subagents and bash. See the RFC: [docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).

See `src/types.ts` for the full contracts.
