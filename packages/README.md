# Packages

Harness packages, all under the `@deepseek-ai/dsh-*` scope. Each package is a Cordis plugin (microkernel-style): it exports either a default `Service` subclass or a functional plugin that gets registered via `ctx.plugin()`, declares its ctx key/events where applicable through declaration merging, and exposes extension points through `ctx.effect()`, `ctx.on()`, and `ctx.waterfall()`.

<!-- FIXME(package-hierarchy): packages/ is currently FLAT, mixing product
     packages (llm, session, agent, agent-loop, …) with example-coupled support
     packages (ui-stdio, llm-replay — extracted from examples/ for the coverage
     gate). ALL packages should eventually be regrouped into a deliberate
     hierarchy, e.g. packages/{core,examples,…}/, so the workspace-glob and
     tsconfig-paths churn happens ONCE rather than per extraction. Deferred to a
     dedicated restructure PR; do not add new top-level subgroups piecemeal. -->

## Dependency graph

```
dsh-llm          (no harness deps — pure vocabulary)
dsh-bash          (no harness deps — abstract executor seam)
dsh-session       ← dsh-llm
dsh-system-prompt ← dsh-llm
dsh-agent         ← dsh-llm, dsh-session
dsh-tools         ← dsh-llm, dsh-system-prompt, dsh-agent
dsh-bash-local    ← dsh-bash                       (BashExecutor impl)
dsh-tool-bash     ← dsh-bash, dsh-tools            (bash tool schemas)
dsh-llm-deepseek  ← dsh-llm                        (DeepSeek adapter)
dsh-llm-pi-ai     ← dsh-llm                        (pi-ai-backed adapter)
dsh-agent-loop    ← dsh-llm, dsh-session, dsh-system-prompt, dsh-tools, dsh-agent
dsh-invariants    ← dsh-llm, dsh-session, dsh-agent (dev-mode contract checks)
dsh-acp           ← dsh-agent, dsh-llm, dsh-session, dsh-session-persistence  (ACP JSON-RPC bridge)
dsh-ui-stdio      ← dsh-agent, dsh-llm, dsh-session (stdio readline UI plugin)
dsh-llm-replay    ← dsh-llm, dsh-session            (record/replay adapter for keyless snapshot tests)
```

The rule: plugins depend on interfaces, never on the concrete loop. `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced. A swappable capability splits into interface / implementation / consumer packages (the bash trio is the template — see [capability seams](../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md)).

## What goes where

| Package | Role | ctx key |
|---|---|---|
| `llm/` | Abstract LLM service + content-block vocabulary + chunk assembler | `ctx.llm` |
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Tool registry + `tools/execute` waterfall | `ctx.tools` |
| `agent/` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | THE concrete loop plugin: `ReactLoopAgent` + the loop driver | `ctx.agentLoop` |
| `bash/` | Abstract bash executor seam (interface + vocabulary) | `ctx.bash` |
| `bash-local/` | Local-subprocess `BashExecutor` implementation | (registers `ctx.bash`) |
| `tool-bash/` | Model-facing `bash`/`bash_output`/`bash_kill` tool schemas | (registers on `ctx.tools`) |
| `llm-deepseek/` | DeepSeek API adapter (hand-rolled fetch/SSE) | (registers on `ctx.llm`) |
| `llm-pi-ai/` | DeepSeek adapter via `@earendil-works/pi-ai` (design twin) | (registers on `ctx.llm`) |
| `invariants/` | Dev-mode event-contract invariants + session-log freeze | (listens on `session/*`, `agent/*`) |
| `acp/` | Agent Client Protocol bridge: serves the agent to an ACP editor over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `ui-stdio/` | Minimal stdio (readline) UI plugin: renders `agent/*` events, feeds stdin lines to the agent | (drives `ctx.agents`) |
| `llm-replay/` | Record/replay adapter: short-circuits `llm/stream` with chunks from a recorded session JSONL (keyless snapshot tests) | (listens on `llm/stream`) |

Each package has its own `README.md` with purpose, service API, events, extension points, and deliberate non-goals (TODOs).

## Conventions (applied across all harness packages)

- **Registrations are effects**: every contribution (adapter, tool, section, agent, event listener) goes through `ctx.effect()` / `ctx.on()`, so disposal and HMR clean up automatically. Every `register()` returns the disposer.
- **Declaration merging for events and ctx**: services declare their events in `declare module 'cordis' { interface Events { ... } }` and their ctx key in `interface Context`.
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)` and MUST call `next()` to delegate; returning without it short-circuits (the veto mechanism).
- **Extensible unions**: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnTriggerMap`, `TurnEndReasonMap`, and `SessionEventMap` use the merge-extensible-map pattern so plugins can add variants via declaration merging.
- **ESM everywhere**; imports use package names across package boundaries, `.ts` extensions within a package.
- **Tests**: vitest, colocated under `packages/<name>/tests/*.spec.ts`. Every registry needs an HMR-safety test. Err on the side of more tests.
