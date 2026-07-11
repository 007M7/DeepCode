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
| `start(name, request)` | Resolve the provider (`NO_PROVIDER` if absent), read every caller field once into one acceptance snapshot, validate every requested START-TIME capability and scalar value before any child is created, and materialize prompt/schema/options/filter data through a single-pass lossless-JSON snapshot before delegating to `provider.start`. Return a frozen service-owned run wrapper whose provider fields are captured once, whose methods remain bound to the provider handle, and whose `result` is one detached, deeply frozen normalization shared by the caller and telemetry. Emit `subagent/start` only after `run.started` fulfills and the paired `subagent/end` after that started run settles; a pre-publication readiness rejection emits neither. |

## Capabilities: two kinds, discovered two ways

- **Start-time features** (`outputSchema`, `depthLimit`, `toolFilter/persona`) are a static `provider.capabilities` descriptor, checked by the service BEFORE a run exists. A request that needs one the provider lacks is **rejected loud** (`UNSUPPORTED_CAPABILITY`), never accepted-then-ignored.
- **Runtime features** (steering, resume) are **optional methods** on `SubagentRun` (`sendMessage?`, `resume?`). The method's presence IS the capability; TS narrowing is the discovery mechanism — a consumer cannot call an absent method without narrowing first, so there is no silent degradation path.

Beside `capabilities` sits one DESCRIPTIVE fact, not validated by the service: `provider.inheritsParentContext` — whether a child sees the parent conversation (`fork`: true — seeded with the completed-turn prefix; `spawn`/`acp`: false). The model-facing consumer (`dsh-tool-subagent`) derives truthful tool wording from it.

## Run lifecycle

`provider.start(request)` returns a provider-owned `SubagentRun`; `SubagentService.start` captures that handle once and returns a frozen service-owned wrapper with `started` (the publication/readiness promise), a normalized `result` (the terminal outcome), bound `cancel()` and `dispose()`, and bound optional runtime methods. `started` resolves only after the provider has established a real child and rejects if the attempt fails or is cancelled first. `result` resolves with one detached, deeply frozen `SubagentResult` (`output`, optional `structured`, `stopReason`) that the service and caller share — it does **not** reject on a child-level failure (a model/transport failure resolves with `stopReason: 'error'`), but malformed provider data rejects as an infrastructure contract fault. The consumer maps a non-`completed` reason to an `isError` tool result and MUST `dispose()` on every path (success, error, abort) to reach child quiescence and avoid leaking an idle child / session.

The service also announces provider lifecycle: `subagent/provider-added` (the frozen registry snapshot) fires after a registration and `subagent/provider-removed` (the accepted name) after an unregistration, so a consumer deriving state from a named provider (the model-facing tool wording) mirrors registry membership instead of assuming load order — the cordis Loader starts sibling plugins concurrently, so "listed earlier" does not mean "registered earlier". Run lifecycle is gated by provider readiness: the service captures the provider handle's public fields once, `subagent/start` (payload `SubagentRunInfo`) fires only after the accepted `started` promise fulfills, and `subagent/end` (payload `SubagentRunEndInfo`) uses the same accepted id and normalized result; readiness rejection emits neither. For spawn/fork, the start listener can resolve the published child via `ctx.agents.get(info.id)`; a remote provider need not have a local registry entry. Both events are **observe-only** plain emits whose service-owned payloads are deeply frozen before per-listener dispatch. The service observes the normalized `result` immediately even while readiness is pending and buffers that end payload until start has fired; a malformed provider result rejects the returned result promise and becomes contained `error` telemetry, a rejection cannot become an unhandled detached promise, start always precedes end, and one listener cannot corrupt either the caller or later listeners. `subagent/end` carries the same frozen output as `lastAssistantMessage` on a valid settle path and omits it on infrastructure or result-contract failure. Any run-affecting decision is out of scope for this observe-only surface.

## Scope (first cut)

The consumer collects **synchronously**: it starts a run and awaits `result`. Steering (`sendMessage`) is part of the contract but intentionally unused. Background, poll, and spill semantics are outside this seam; long-running-tool handling is shared work across subagents and bash. See the RFC: [docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md).

See `src/types.ts` for the full contracts.
