# Packages

Packages use the `@deepseek-ai/dsh-*` scope. Each is a Cordis `Service` subclass or function plugin; contributions use `ctx.effect()`, `ctx.on()`, or `ctx.waterfall()`. Authoring rules: [package](AGENTS.md) and [root](../AGENTS.md#conventions).

## Hierarchy

Packages live at `packages/<group>/<pkg>/`; groups are containers, while names remain `@deepseek-ai/dsh-<pkg>`. **Each group README is the canonical package/ctx-key map.**

| Group | Role | Release expectation |
|---|---|---|
| [`core/`](core/README.md) | Product API spine: sessions, prompts, tools, agent services, and the concrete loop | Product — stable surface |
| [`llm/`](llm/README.md) | LLM capability family: the abstract service + provider adapters | Product — stable surface |
| [`bash/`](bash/README.md) | Bash capability family: the executor seam, a local impl, and the model-facing tool | Product — stable surface |
| [`code-runtime/`](code-runtime/README.md) | Code-execution capability family: the abstract runtime seam for model-written programs + a worker-thread backend | Product — stable surface |
| [`sandbox/`](sandbox/README.md) | Process-confinement seam; bwrap/Landlock/Seatbelt backends | Product — stable surface |
| [`fs/`](fs/README.md) | Filesystem capability family: the abstract seam, a local impl, the model-facing file tools, and the bash-backed discovery tools | Product — stable surface |
| [`skill/`](skill/README.md) | Skill capability family: the provider registry, local provider, and model-facing catalog/loader | Product — stable surface |
| [`compact/`](compact/README.md) | Compaction capability family: the abstract seam + a basic backend (tool deferred) | Product — stable surface |
| [`context/`](context/README.md) | Model-visible request context, including workspace instructions and time context | Product — stable surface |
| [`subagent/`](subagent/README.md) | Subagent capability family: the provider-registry seam and the model-facing delegation tool | Product — stable surface |
| [`tasks/`](tasks/README.md) | Generic background-task runtime and model-facing `task_*` control tools | Product — stable surface |
| [`workflow/`](workflow/README.md) | Workflow capability family: the script-engine seam, the worker-thread engine, and the model-facing `workflow` tool | Product — stable surface |
| [`web/`](web/README.md) | Web capability family: the abstract seam, search/fetch provider impls, and the model-facing web tools | Product — stable surface |
| [`spill/`](spill/README.md) | Spill capability family: the storage seam, a local impl, and the tool-result spill policy | Product — stable surface |
| [`todo/`](todo/README.md) | Todo/planning family: the model-facing `todo_write` tool | Product — stable surface |
| [`timeout/`](timeout/README.md) | Tool-call timeout policy: the `tools/execute` deadline enforcer | Product — stable surface |
| [`guard/`](guard/README.md) | Loop-hygiene guards: advisory repeat-call reminders | Product — stable surface |
| [`cordis/`](cordis/README.md) | Self-referential runtime toolset: inspect the live runtime's plugins and services, mount/unmount model-written plugins ([design](../.agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md)) | Product — stable surface |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library | Product — stable surface |
| [`session-persistence/`](session-persistence/README.md) | Persistence capability family: the seam + JSONL/SQLite backends | Product — stable surface |
| [`session-query/`](session-query/README.md) | Session retrieval: logical corpus, bounded reads, lineage, and event relationships | Product — stable surface |
| [`sdk/`](sdk/README.md) | Project SDK tooling | Product — stable surface |
| [`ui/`](ui/README.md) | Editor/client integration surfaces: ACP bridge, JSON-RPC SDK server, user-approval/user-interaction seams, ask-user tool | Product — stable surface |
| [`examples/`](examples/README.md) | Demo bundles (agent-spine + TUI/one-shot CLI/ACP/JSON-RPC bins) the leaves load | Support — example infra |
| [`support/`](support/README.md) | Support infrastructure (testkits, invariants, replay, Loader smokes) | Support — lower compatibility expectations |
| [`util/`](util/README.md) | Low-level zero-dependency utilities shared across groups (`Branded<B>`, Harness home/path helpers, timeout, retention) | Support — small, stable, harness-dep-free |

Groups distinguish product API from support infrastructure. New packages join an existing group; a new group updates its README and this table.

## Dependencies

The dependency graph is generated: [docs/module-graph.md](../docs/module-graph.md) (`pnpm run gen-module-graph`, freshness-gated in CI).

The rule it must obey: **extension plugins depend on interfaces, never on the concrete loop.** `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. The sanctioned exception is a **composition/bundle** package like `dsh-agent-spine-demo`, whose whole job is to assemble the concrete spine: it depends on `dsh-agent-loop` (and the other concrete spine plugins) on purpose. The rule constrains plugins that EXTEND the system, not the bundle that COMPOSES it. A swappable capability splits into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)).

Package READMEs cover purpose, APIs, extension points, and [Model Experience](../docs/cookbook/adding-a-package.md#4-write-the-package-readme) unless on the model-agnostic [omission allowlist](../scripts/verify-package-readme-model-experience.ts). They also carry `## Known Limitations and Deferred Work` or use its [allowlist](../scripts/verify-package-readme-limitations.ts).
