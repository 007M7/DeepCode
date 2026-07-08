# code-runtime/ — code-execution capability family

The code-execution capability seam (see [capability seams](../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)): an abstract runtime interface for executing one model-written program against host-provided async bindings, capturing what it printed and returned. The consumer is the tool registry's Code Mode, and the first implementation (a Node worker-thread backend) is specified alongside it in the [Code Mode RFC](../../docs/rfc/proposed/feature/2026-06-15-code-mode.md). **Product** packages.

| Package | Role | ctx key |
|---|---|---|
| `code-runtime/` | Abstract code-execution seam (interface + vocabulary) | `ctx.codeRuntime` |

The interface lives at `code-runtime/code-runtime/`. Backends differ by execution substrate (worker thread, process, container) and by source language — both readonly descriptors on the service — and register `ctx.codeRuntime` without touching the interface or its consumer; that split is what makes a hardened backend a drop-in later.
