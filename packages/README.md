# Packages

Harness packages live under the `@deepseek-ai/dsh-*` scope. Each is a Cordis plugin: it exports a `Service` subclass or functional plugin, declares ctx keys/events through declaration merging, and extends through `ctx.effect()`, `ctx.on()`, and `ctx.waterfall()`. Authoring conventions: [AGENTS.md](AGENTS.md) and root [AGENTS.md](../AGENTS.md) § Conventions.

## Hierarchy

Packages are grouped by role at `packages/<group>/<pkg>/`. The group directory is a pure container; package names stay `@deepseek-ai/dsh-<pkg>`. Group READMEs are the canonical maps for package roles, ctx keys, and product-vs-support split.

| Group | Role | Release expectation |
|---|---|---|
| [`core/`](core/README.md) | Product API spine: session, system-prompt, tools, agent, and the concrete loop | Product — stable surface |
| [`llm/`](llm/README.md) | LLM capability family: the abstract service + provider adapters | Product — stable surface |
| [`bash/`](bash/README.md) | Bash capability family: the executor seam, a local impl, and the model-facing tool | Product — stable surface |
| [`code-runtime/`](code-runtime/README.md) | Code-execution capability family: the abstract runtime seam for model-written programs + a worker-thread backend | Product — stable surface |
| [`fs/`](fs/README.md) | Filesystem capability family: the abstract seam, a local impl, and the model-facing file tools | Product — stable surface |
| [`compact/`](compact/README.md) | Compaction capability family: the abstract seam + a basic backend (tool deferred) | Product — stable surface |
| [`subagent/`](subagent/README.md) | Subagent capability family: the provider-registry seam and the model-facing delegation tool | Product — stable surface |
| [`web/`](web/README.md) | Web capability family: the abstract seam, search/fetch provider impls, and the model-facing web tools | Product — stable surface |
| [`spill/`](spill/README.md) | Spill capability family: the storage seam, a local impl, and the tool-result spill policy | Product — stable surface |
| [`todo/`](todo/README.md) | Todo/planning family: the model-facing `todo_write` tool | Product — stable surface |
| [`timeout/`](timeout/README.md) | Tool-call timeout policy: the `tools/execute` deadline enforcer | Product — stable surface |
| [`guard/`](guard/README.md) | Loop-hygiene guards: advisory repeat-call reminders | Product — stable surface |
| [`hooks/`](hooks/README.md) | Hook bridges + the shared Claude Code / Codex wire-protocol library | Product — stable surface |
| [`session-persistence/`](session-persistence/README.md) | Persistence capability family: the seam + JSONL/SQLite backends | Product — stable surface |
| [`ui/`](ui/README.md) | Editor/client integration surfaces (the ACP bridge) + the app packages | Product — stable surface |
| [`support/`](support/README.md) | Dev/test/example infrastructure (invariants, replay adapter, subagent mock) | Support — lower compatibility expectations |
| [`util/`](util/README.md) | Low-level zero-dependency primitives shared across groups (branding, timeout, retention) | Support — small, stable, harness-dep-free |

The split marks product API versus support/test/example infrastructure, so release and removal decisions do not treat every package as equally public. New packages join an existing group; a new top-level group updates the group READMEs and this table.

## Dependencies

The dependency graph is generated: [docs/module-graph.md](../docs/module-graph.md) (`pnpm run gen-module-graph`, freshness-gated in CI).

The rule it must obey: **extension plugins depend on interfaces, never on the concrete loop.** `dsh-agent-loop` is swappable, so UI/hook/tool plugins keep working against `dsh-agent` if the loop changes. The exception is a composition bundle like `dsh-agent-core`: it depends on `dsh-agent-loop` because it assembles the concrete spine. Swappable capabilities split into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).

Each package has its own `README.md` with purpose, service API, events, extension points, and deliberate non-goals (TODOs).
