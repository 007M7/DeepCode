# code-runtime/ — code-execution capability family

English | [中文](README.zh.md)

The code-execution capability seam (see [capability seams](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): an abstract runtime interface for executing one model-written program against host-provided async bindings, capturing what it printed and returned. The consumer is the tool registry's [Code Mode](../core/tools/README.md) (`tools: { mode: code }` — the `run_code` tool and the generated TypeScript SDK); design in the [Code Mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.md). **Product** packages.

| Package | Role | ctx key |
|---|---|---|
| `code-runtime/` | Abstract code-execution seam (interface + vocabulary) | `ctx.codeRuntime` |
| [`code-runtime-worker/`](code-runtime-worker/README.md) | Worker-thread backend: fresh worker per run, TypeScript via host-side type-strip (annotations advisory, never type-checked), port-bridged bindings, budget/heap containment | registers `ctx.codeRuntime` |
| [`e2b/code-runtime-e2b`](../e2b/code-runtime-e2b/README.md) | E2B backend: host type-strip and bindings, fresh remote runner/worker, framed bridge, remote process-group cleanup | registers `ctx.codeRuntime` |

Backends differ by execution substrate and source language—both readonly descriptors on the service—and register `ctx.codeRuntime` without touching the interface or its consumer. The E2B ownership split is recorded in the [shared E2B runtime note](../../.agents/notes/implemented/feature/2026-07-27-e2b-remote-runtime-poc.md).
