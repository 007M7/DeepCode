# Agent Note: Capability seams — interface / implementation / consumer split

Status: implemented

English | [中文](2026-06-13-capability-seams.zh.md)

## Problem

The harness has swappable capabilities — bash execution today, sandboxed/remote executors and alternative model providers tomorrow. A capability has three concerns that change at different rates and for different reasons: the *contract* (what the capability is), the *implementation* (how it runs), and the *consumer surface* (what the model and other plugins program against). Bundling them in one package couples those rates of change — swapping a local executor for a sandboxed one would churn the tool schemas the model sees, even though the model-facing contract never changed.

This is distinct from "who provides vs. needs a capability at runtime", which Cordis already answers with services + `inject` (a provider registers `ctx.bash`; a consumer declares `inject: ['bash']` and its fiber pends until the service exists). That mechanism is necessary but doesn't dictate package boundaries; this Agent Note does.

## Decision

A swappable capability is **three packages**:

1. **Interface** — an abstract service + the vocabulary types, owning the `ctx.<key>` and depending only on its vocabulary dependencies (e.g. `dsh-bash`: `BashExecutor`, `BashRunResult`, `BashProcess`).
2. **Implementation** — a concrete subclass loaded as a plugin (e.g. `dsh-bash-local`: subprocesses, process-group kills, spill-file truncation). Sandboxed/remote backends are sibling packages implementing the same interface.
3. **Consumer** — what the model and plugins see (e.g. `dsh-tool-bash`: the `bash` schema, with background handles registered into the generic task runtime). Consumers `inject` the interface key and never import implementation types.

Implementation and consumer then evolve independently: a sandboxed executor replaces `dsh-bash-local` without touching a tool schema.

The split is not mandatory when the parts are genuinely one concern: the LLM seam folds interface + consumer into `dsh-llm` (the consumer is the loop itself, not a swappable schema surface) with adapters as the implementation packages. Don't split preemptively — a capability with one conceivable implementation and one consumer stays one package until a second appears.

## Terminology: "seam" names the trio, not the interface

A **seam** is the whole capability — the three roles together: a **Service Definition** (the Cordis `Service` that owns `ctx.<key>` and the vocabulary; an abstract class such as `BashExecutor`, or a concrete registry such as `WebService`), one or more **Service providers** (implementations that register a backend), and a **Consumer** (the model- or plugin-facing surface). `packages/bash` is the canonical example — `dsh-bash` / `dsh-bash-local`+`dsh-bash-sandbox` / `dsh-tool-bash`. The interface package alone is the *Service Definition*, one member — not the seam. The Service Definition is never a TypeScript `interface`; where prose must name it, use the class name or `abstract class`, never `interface`. Reserving "seam" strictly for the trio and realigning the many existing "the X seam" usages is deferred to a follow-up; the [glossary](../../../../docs/glossary.md#capability-seam) is the canonical entry.

## Alternatives considered

- **One combined package** — rejected because it recouples the three rates of change the split exists to separate (the whole point).
- **`@cordisjs/plugin-capability`** — a different axis entirely: it is a permission/capability-*security* service (named permissions with inheritance, tested against a session via `ctx.capability.test`), a candidate for the deferred permissions/sandbox work on the `tools/pre-execute` deny/ask seam, NOT a mechanism for swapping implementations. Confusing the two ("capability") is the trap this Agent Note names.

## Consequences

More packages and more boilerplate per capability (a `package.json`/`tsconfig`/README trio, the inject wiring). Bought: implementations and consumers ship and version independently, and a new backend never risks the model-facing contract. The rule is documented in [AGENTS.md](../../../../AGENTS.md) § Conventions ("Capability seams are three packages") and [architecture.md](../../../../docs/architecture.md) § "Capability seams"; the bash trio is the reference template. When to fold vs. split is a judgment call the architecture doc spells out — this Agent Note records *why* the default is to split.
