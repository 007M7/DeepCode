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

The service also announces provider lifecycle: `subagent/provider-added` (the frozen registry snapshot) fires after a registration and `subagent/provider-removed` (the accepted name) after an unregistration, so a consumer deriving state from a named provider (the model-facing tool wording) mirrors registry membership instead of assuming load order — the cordis Loader starts sibling plugins concurrently, so "listed earlier" does not mean "registered earlier". Run lifecycle is gated by provider readiness: `subagent/start` (payload `SubagentRunInfo`) fires only after `run.started` fulfills, and `subagent/end` (payload `SubagentRunEndInfo`) fires only for that announced run; readiness rejection emits neither. For spawn/fork, the start listener can resolve the published child via `ctx.agents.get(info.id)`; a remote provider need not have a local registry entry. Both events are **observe-only** plain emits. The service observes `result` immediately even while readiness is pending, clones its output before the caller can mutate it, and buffers that end payload until start has fired; a rejecting result cannot become an unhandled detached promise, start always precedes end, and a listener cannot corrupt the caller's result. `subagent/end` carries the cloned output as `lastAssistantMessage` on the settle path and omits it on infrastructure rejection. Any run-affecting decision is out of scope for this observe-only surface.

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| None directly | The provider registry registers no prompt or tool. Provider lifecycle makes a bound `dsh-tool-subagent` schema appear or disappear, and `inheritsParentContext` selects truthful fresh-versus-fork wording. Run events are observe-only. | Zero direct tokens. Child prompts and final results enter model contexts only through a provider and consumer. |

## Known Limitations and Deferred Work

- **The consumer collects synchronously** — it starts a run and awaits `result`; steering (`sendMessage`) is part of the contract but intentionally unused, and background / poll / spill semantics are deferred to a future redesign unifying long-running-tool handling across subagents and bash ([the seam RFC](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)).
- **The lifecycle events are observe-only** — a run-affecting `subagent/end` (an awaited continuation/decision surface) is deferred until a consumer needs one (`FIXME(subagent-continuation)`).

See `src/types.ts` for the full contracts.
