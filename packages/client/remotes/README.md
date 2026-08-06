# @deepseek-ai/dsh-client-remotes

English | [中文](README.zh.md)

Platform-neutral Client facade for Host Remote capabilities selected by this application. Its Client entry imports generated `/remote` artifacts as runtime values, mounts each contribution through `ctx.api`, and re-exports their declaration merges. Client business packages depend on this facade rather than the Host API Gateway or individual Remote runtime entries.

The current assembly mounts only the Goal Remote contribution. Cordis effect ownership withdraws every contribution when this assembly unloads, while the Client face of `@deepseek-ai/dsh-host-api-gateway` owns descriptor validation, concrete root and scoped methods, invocation, and cancellation.

This package contains no transport or Host discovery logic. It can be reused by Web or a future TUI Client that provides the same React-free `ctx.api` contract.

## Model Experience

None, as this Client assembly selects Remote application methods and registers no model surface.

#### KV Cache effect

No direct effect; mounted Host capabilities own any model-visible behavior they trigger.

## Known Limitations and Deferred Work

- The capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime.
- Additional capabilities require an explicit `/remote` value import and mount in this assembly.
