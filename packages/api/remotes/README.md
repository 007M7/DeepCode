# @deepseek-ai/dsh-api-remotes

English | [中文](README.zh.md)

Two-sided BFF for Host Remote capabilities selected by this application. The Host entry owns Agent/Session identity policy; the Client entry imports generated `/remote` artifacts as runtime values, mounts each contribution through `ctx.remote.$mount()`, and re-exports their declaration merges. Client business packages depend on this facade rather than the Gateway implementation or individual Remote runtime entries.

`createApiRemoteAgentResolver()` reuses live Agents, resumes ordinary cold sessions, deduplicates concurrent resumes, preserves the subagent ownership fence, and configures the same resolver for TypeRT `agent` and `session` lookups. The standard Web API Proxy supplies its Agent defaults and scope setup, then uses the returned resolver for legacy methods, so migrated and unmigrated methods share one policy implementation.

The current Client assembly mounts only the Goal Remote contribution. Cordis effect ownership withdraws every contribution when this assembly unloads, while `@deepseek-ai/dsh-api-gateway/client` owns descriptor validation, traced namespace Services, direct and scoped methods, invocation, and cancellation. The Client entry consumes the shared `TypeRTClientRemote` interface through Cordis and does not import the concrete Gateway.

This package contains no transport or Host service discovery logic. Its Client face can be reused by Web or a future TUI that provides the same React-free `ctx.remote` contract.

## Model Experience

None, as this BFF selects Remote application methods and identity policy but registers no model surface.

#### KV Cache effect

No direct effect; mounted Host capabilities own any model-visible behavior they trigger.

## Known Limitations and Deferred Work

- The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime.
- Additional capabilities require an explicit `/remote` value import and mount in this assembly.
- The standard Web Host supplies resume defaults and Agent-scope setup from the legacy API Proxy until that remaining BFF configuration moves into `api-remotes`.
