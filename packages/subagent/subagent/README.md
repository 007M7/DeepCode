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
| `registerProvider(provider)` | Register under `provider.name`. Throws `SubagentError('DUPLICATE_PROVIDER')` on a name clash. Effect-scoped (HMR-safe); returns the disposer. |
| `getProvider(name)` | Look up a provider (`undefined` if absent). |
| `list()` | Registered provider names (insertion order). |
| `start(name, request)` | Resolve the provider (`NO_PROVIDER` if absent), validate every requested START-TIME capability (`UNSUPPORTED_CAPABILITY` for the first unmet one — before any child is created), then delegate to `provider.start` and emit `subagent/start` / `subagent/end` around the run. |

## Capabilities: two kinds, discovered two ways

- **Start-time features** (`outputSchema`, `depthLimit`, `toolFilter`) are a static `provider.capabilities` descriptor, checked by the service BEFORE a run exists. A request that needs one the provider lacks is **rejected loud** (`UNSUPPORTED_CAPABILITY`), never accepted-then-ignored.
- **Runtime features** (steering, resume) are **optional methods** on `SubagentRun` (`sendMessage?`, `resume?`). The method's presence IS the capability; TS narrowing is the discovery mechanism — a consumer cannot call an absent method without narrowing first, so there is no silent degradation path.

## Run lifecycle

`provider.start(request)` returns a `SubagentRun`: a handle with a `result` promise, `cancel()`, `dispose()`, and the optional runtime methods. `result` resolves with a `SubagentResult` (`output`, optional `structured`, `stopReason`) — it does **not** reject on a child-level failure (a model/transport failure resolves with `stopReason: 'error'`), so the consumer maps a non-`completed` reason to an `isError` tool result. The consumer MUST `dispose()` on every path (success, error, abort) to reach child quiescence and avoid leaking an idle child / session.

## Scope (first cut)

The consumer collects **synchronously**: it starts a run and awaits `result`. Steering (`sendMessage`) is part of the contract but intentionally unused. Background / poll / spill semantics are deferred to a future redesign unifying long-running-tool handling across subagents and bash. See the RFC: [docs/rfc/proposed/feature/2026-06-21-subagent-capability-seam.md](../../../docs/rfc/proposed/feature/2026-06-21-subagent-capability-seam.md).

See `src/types.ts` for the full contracts.
