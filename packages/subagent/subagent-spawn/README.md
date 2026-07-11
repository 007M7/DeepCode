# @deepseek-ai/dsh-subagent-spawn

In-process provider that runs each request as a fresh child [`Agent`](../../core/agent) on the same Cordis application. The child has a new session and no inherited conversation; it uses the parent model unless overridden.

The package delegates lifecycle work to [`startInProcessRun`](../subagent-inprocess/README.md) with no seed. Child creation, persona, tool filtering, structured output, cancellation, and quiescent disposal are owned by the shared driver. `run.started` resolves only after publication, so `subagent/start` observers can resolve the child from `ctx.agents`.

## Capabilities

`{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`

## Config

| Key | Meaning |
|---|---|
| `providerName` | Registry name on `ctx.subagents` (default `spawn`). |
