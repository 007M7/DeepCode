# Packages

Packages use the `@deepseek-ai/dsh-*` scope. Each is a Cordis `Service` subclass or function plugin; contributions use `ctx.effect()`, `ctx.on()`, or `ctx.waterfall()`. Authoring rules: [package](AGENTS.md) and [root](../AGENTS.md#conventions).

## Hierarchy

Packages are grouped by modular role at `packages/<group>/<pkg>/`. The group directory is a pure container (no `package.json`); the package name stays `@deepseek-ai/dsh-<pkg>` regardless of group. **Each group README is the canonical per-package map** — package roles, ctx keys, and the product-vs-support split live there, next to the code.

| Group | Role | Release expectation |
|---|---|---|
| [`core/`](core/README.md) | Product API spine: session, system-prompt, tools, agent, and the concrete loop | Product — stable surface |
| [`llm/`](llm/README.md) | LLM capability family: the abstract service + provider adapters | Product — stable surface |
| [`bash/`](bash/README.md) | Bash capability family: the executor seam, a local impl, and the model-facing tool | Product — stable surface |
| [`code-runtime/`](code-runtime/README.md) | Code-execution capability family: the abstract runtime seam for model-written programs + a worker-thread backend | Product — stable surface |
| [`sandbox/`](sandbox/README.md) | Process-confinement seam; bwrap/Landlock/Seatbelt backends | Product — stable surface |
| [`fs/`](fs/README.md) | Filesystem capability family: the abstract seam, a local impl, and the model-facing file tools | Product — stable surface |
| [`skill/`](skill/README.md) | Skill capability family: the provider registry, local provider, and model-facing catalog/loader | Product — stable surface |
| [`compact/`](compact/README.md) | Compaction capability family: the abstract seam + a basic backend (tool deferred) | Product — stable surface |
| [`context/`](context/README.md) | Opt-in request-context enrichment | Product — stable surface |
| [`subagent/`](subagent/README.md) | Subagent capability family: the provider-registry seam and the model-facing delegation tool | Product — stable surface |
| [`workflow/`](workflow/README.md) | Workflow capability family: the script-engine seam, the worker-thread engine, and the model-facing `workflow` tool | Product — stable surface |
| [`web/`](web/README.md) | Web capability family: the abstract seam, search/fetch provider impls, and the model-facing web tools | Product — stable surface |
| [`timeout/`](timeout/README.md) | Tool-call timeout policy: the `tools/execute` deadline enforcer | Product — stable surface |
| [`todo/`](todo/README.md) | Todo/planning family: the model-facing `todo_write` tool | Product — stable surface |
| [`guard/`](guard/README.md) | Loop-hygiene guards: advisory repeat-call reminders | Product — stable surface |
| [`cordis/`](cordis/README.md) | Self-referential runtime toolset: inspect the live runtime's plugins and services, mount/unmount model-written plugins ([design](../docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) | Product — stable surface |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library | Product — stable surface |
| [`session-persistence/`](session-persistence/README.md) | Persistence capability family: the seam + JSONL/SQLite backends | Product — stable surface |
| [`session-query/`](session-query/README.md) | Session retrieval family: logical corpus, surface records, and bounded exact reads | Product — stable surface |
| [`ui/`](ui/README.md) | Editor/client integration surfaces: ACP bridge, JSON-RPC SDK server, app packages, user-approval and user-interaction seams, ask-user tool | Product — stable surface |
| [`support/`](support/README.md) | Dev/test/example infrastructure (invariants, replay adapter, subagent mock) | Support — lower compatibility expectations |
| [`util/`](util/README.md) | Low-level zero-dependency utilities shared across groups (the `Branded<B>` primitive) | Support — small, stable, harness-dep-free |

The split is the point: a package's group says whether it is part of the product API or support/test/example infrastructure, so release and removal decisions do not treat every package as an equal public contract. New packages join an existing group; adding a new top-level group is a deliberate act (extend the group READMEs and this table).

## Dependencies

The inter-package dependency graph is generated: [docs/module-graph.md](../docs/module-graph.md) (`pnpm run gen-module-graph`, freshness-gated in CI).

The rule it must obey: **extension plugins depend on interfaces, never on the concrete loop.** `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. The sanctioned exception is a **composition/bundle** package like `dsh-agent-core`, whose whole job is to assemble the concrete spine: it depends on `dsh-agent-loop` (and the other concrete spine plugins) on purpose. The rule constrains plugins that EXTEND the system, not the bundle that COMPOSES it. A swappable capability splits into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).

Package READMEs cover purpose, APIs, extension points, and [Model Experience](../docs/cookbook/adding-a-package.md#4-write-the-package-readme) unless on the model-agnostic [omission allowlist](../scripts/verify-package-readme-model-experience.ts). They also carry `## Known Limitations and Deferred Work` or use its [allowlist](../scripts/verify-package-readme-limitations.ts).
