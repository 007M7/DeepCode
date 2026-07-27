# core/ — product API spine

English | [中文](README.zh.md)

The session log, system-prompt assembly, tool registry, agent vocabulary, and concrete loop that form the harness's default control spine. These are **product** packages — the stable surface plugins and consumers build against.

| Package | Role | ctx key |
|---|---|---|
| `scope/` | Scoped-context registration primitive (scope tags, scope-filtered dispatch) | (library — no ctx key) |
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Scoped tool registry + pre-policy, guards, around-dispatch, post-policy, and final-result observation | `ctx.tools` |
| `agent/` | Agent interface, live registry, process-local initiator scope, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | Concrete plugin implementing the public `Agent` contract and owning the loop driver | `ctx.agentLoop` |

`scope/` is the one non-service package here: a dependency-free library (`createScope`/`scopeOf`/`scopeTarget`) the registries and the loop build per-agent scoping on — it sits below `session/` and `system-prompt/` in the module graph precisely so they can consume it without a cycle.

`agent-loop` is the one concrete implementation of the `agent` seam and lives here because it is the harness's default product loop. It runs each driver inside `ctx.agents.withInitiator()`. Extension plugins depend on `agent`, including when they need the initiating Agent, and never on `agent-loop` directly, so the loop stays swappable.

The default composition that wires this spine into a runnable agent lives in [`examples/agent-spine-demo`](../examples/agent-spine-demo/README.md): one bundle plugin that loads the control spine plus selected default capabilities (`timer` + `llm` + sessions + fallback session titles + system-prompt + tools + agents + invariants + the local [skill family](../skill/README.md) + `tool-bash` + workspace-context + `agent-loop`) and forwards `agent-loop`'s `agents` list as its own config. It sits in `examples/` — ready-to-run demo/reference bundles — not in `core/`: `core/` ships the swappable spine pieces, while a demo bundle picks one concrete composition of them and adds a front door.
