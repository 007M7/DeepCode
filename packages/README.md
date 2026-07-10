# Packages

Harness packages, all under the `@deepseek-ai/dsh-*` scope. Each package is a Cordis plugin (microkernel-style): it exports either a default `Service` subclass or a functional plugin, declares its ctx key/events through declaration merging, and exposes extension points through `ctx.effect()`, `ctx.on()`, and `ctx.waterfall()`. Authoring conventions: [AGENTS.md](AGENTS.md) (subtree) and the root [AGENTS.md](../AGENTS.md) § Conventions.

## Hierarchy

Packages are grouped by modular role at `packages/<group>/<pkg>/`. The group directory is a pure container (no `package.json` of its own); the package name stays `@deepseek-ai/dsh-<pkg>` regardless of group. **Each group README is the canonical per-package map** — package roles, ctx keys, and the product-vs-support split live there, next to the code.

| Group | Role | Release expectation |
|---|---|---|
| [`core/`](core/README.md) | Product API spine: session, system-prompt, tools, agent, and the concrete loop | Product — stable surface |
| [`llm/`](llm/README.md) | LLM service and provider adapters | Product — stable surface |
| [`bash/`](bash/README.md) | Bash executor seam, local backend, and tool | Product — stable surface |
| [`code-runtime/`](code-runtime/README.md) | Model-written code seam and worker-thread backend | Product — stable surface |
| [`fs/`](fs/README.md) | Filesystem seam, local backend, and file tools | Product — stable surface |
| [`compact/`](compact/README.md) | Compaction seam and basic backend (tool deferred) | Product — stable surface |
| [`subagent/`](subagent/README.md) | Subagent provider registry and delegation tool | Product — stable surface |
| [`tasks/`](tasks/README.md) | Background-task registry and generic `task_*` controls | Product — stable surface |
| [`workflow/`](workflow/README.md) | Workflow seam, worker-thread engine, and tool | Product — stable surface |
| [`web/`](web/README.md) | Web provider registry and search/fetch tools | Product — stable surface |
| [`timeout/`](timeout/README.md) | Tool-call timeout policy: the `tools/execute` deadline enforcer | Product — stable surface |
| [`todo/`](todo/README.md) | Todo/planning family: the model-facing `todo_write` tool | Product — stable surface |
| [`guard/`](guard/README.md) | Loop-hygiene guards: advisory repeat-call reminders | Product — stable surface |
| [`cordis/`](cordis/README.md) | Self-referential runtime toolset: inspect the live runtime's plugins and services, mount/unmount model-written plugins ([design](../docs/rfc/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) | Product — stable surface |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library | Product — stable surface |
| [`session-persistence/`](session-persistence/README.md) | Persistence seam and JSONL/SQLite backends | Product — stable surface |
| [`ui/`](ui/README.md) | Editor/client integration surfaces: ACP bridge, app packages, user-interaction seam, ask-user tool | Product — stable surface |
| [`support/`](support/README.md) | Dev/test/example infrastructure (invariants, replay adapter, subagent mock) | Support — lower compatibility expectations |
| [`util/`](util/README.md) | Low-level zero-dependency utilities shared across groups (the `Branded<B>` primitive) | Support — small, stable, harness-dep-free |

The split is the point: a package's group says whether it is part of the product API or support/test/example infrastructure, so release and removal decisions do not treat every package as an equal public contract. New packages join an existing group; adding a new top-level group is a deliberate act (extend the group READMEs and this table).

## Dependencies

The inter-package dependency graph is generated: [docs/module-graph.md](../docs/module-graph.md) (`pnpm run gen-module-graph`, freshness-gated in CI).

The rule it must obey: **extension plugins depend on interfaces, never on the concrete loop.** `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. The sanctioned exception is a **composition/bundle** package like `dsh-agent-core`, whose whole job is to assemble the concrete spine: it depends on `dsh-agent-loop` (and the other concrete spine plugins) on purpose. The rule constrains plugins that EXTEND the system, not the bundle that COMPOSES it. A swappable capability splits into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).

Each package has its own `README.md` with purpose, service API, events, extension points, and deliberate non-goals (TODOs).
