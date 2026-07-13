# core/ — product API spine

The session log, system-prompt assembly, tool registry, agent vocabulary, and concrete loop that form the harness's default control spine. These are **product** packages — the stable surface plugins and consumers build against.

| Package | Role | ctx key |
|---|---|---|
| `scope/` | Scoped-context registration primitive (scope tags, scope-filtered dispatch) | (library — no ctx key) |
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Scoped tool registry + pre-policy, guards, around-dispatch, post-policy, and final-result observation | `ctx.tools` |
| `agent/` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | The concrete loop plugin: `ReactLoopAgent` + the loop driver | `ctx.agentLoop` |
| `agent-core/` | Bundle plugin: the default executor-less/UI-less spine as code | (loads the spine) |

`scope/` is the one non-service package here: a dependency-free library (`createScope`/`scopeOf`/`scopeTarget`) the registries and the loop build per-agent scoping on — it sits below `session/` and `system-prompt/` in the module graph precisely so they can consume it without a cycle.

`agent-loop` is the one concrete implementation of the `agent` seam and lives here because it is the harness's default product loop; everything else in `core/` is interface/vocabulary. Plugins depend on the `agent` vocabulary, never on `agent-loop` directly, so the loop stays swappable.

`agent-core` is the composition counterpart: one bundle plugin that loads the control spine plus selected default capabilities (`timer` + `llm` + sessions + system-prompt + tools + agents + invariants + the local [skill family](../skill/README.md) + `tool-bash` + `agent-loop`) and forwards `agent-loop`'s `agents` list as its own config. App packages (`ui/stdio-agent`, `ui/acp-agent`) consume it and add only a front door; a leaf adds the swappable backends plus any optional product tools it wants to expose. It lives in `core/` because it composes the shared control spine while leaving executors, LLM adapters, alternate skill providers, and UI front doors outside the bundle.
