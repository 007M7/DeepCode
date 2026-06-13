# Packages

Harness packages, all under the `@deepseek-ai/dsh-*` scope. Each package is a Cordis service (microkernel plugin-style): it exports a default `Service` class that gets registered via `ctx.plugin()`, declares its ctx key and events through declaration merging, and exposes extension points through `ctx.effect()`, `ctx.on()`, and `ctx.waterfall()`.

## Dependency graph

```
dsh-llm          (no harness deps — pure vocabulary)
dsh-session       ← dsh-llm
dsh-system-prompt ← dsh-llm
dsh-agent         ← dsh-llm, dsh-session
dsh-tools         ← dsh-llm, dsh-system-prompt, dsh-agent
dsh-agent-loop    ← dsh-llm, dsh-session, dsh-system-prompt, dsh-tools, dsh-agent
```

The rule: plugins depend on interfaces, never on the concrete loop. `dsh-agent-loop` is swappable — UI/hook/tool plugins keep working against the `dsh-agent` vocabulary if the loop is replaced.

## What goes where

| Package | Role | ctx key |
|---|---|---|
| `llm/` | Abstract LLM service + content-block vocabulary + chunk assembler | `ctx.llm` |
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Tool registry + `tools/execute` waterfall | `ctx.tools` |
| `agent/` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | THE concrete plugin: `LoopAgent` + the loop driver | `ctx.agentLoop` |

Each package has its own `README.md` with purpose, service API, events, extension points, and deliberate non-goals (TODOs).

## Conventions (applied across all harness packages)

- **Registrations are effects**: every contribution (adapter, tool, section, agent, event listener) goes through `ctx.effect()` / `ctx.on()`, so disposal and HMR clean up automatically. Every `register()` returns the disposer.
- **Declaration merging for events and ctx**: services declare their events in `declare module 'cordis' { interface Events { ... } }` and their ctx key in `interface Context`.
- **Waterfall semantics**: `ctx.waterfall` listeners receive `(...args, next)` and MUST call `next()` to delegate; returning without it short-circuits (the veto mechanism).
- **Extensible unions**: `ContentBlockMap`, `MessageSourceMap`, `FinishReasonMap`, `TurnTriggerMap`, `TurnEndReasonMap`, and `SessionEventMap` use the merge-extensible-map pattern so plugins can add variants via declaration merging.
- **ESM everywhere**; imports use package names across package boundaries, `.ts` extensions within a package.
- **Tests**: vitest, colocated under `packages/<name>/tests/*.spec.ts`. Every registry needs an HMR-safety test. Err on the side of more tests.
