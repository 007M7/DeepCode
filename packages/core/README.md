# core/ — product API spine

The packages every harness build is assembled from: the session log, the system-prompt assembly, the tool registry, the agent vocabulary, and the one concrete loop that drives them. These are **product** packages — the stable surface plugins and consumers build against.

| Package | Role | ctx key |
|---|---|---|
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Tool registry + `tools/execute` waterfall | `ctx.tools` |
| `agent/` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | The concrete loop plugin: `ReactLoopAgent` + the loop driver | `ctx.agentLoop` |
| `agent-core/` | Bundle plugin: the providerless/executor-less/UI-less spine as code | (loads the spine) |

`agent-loop` is the one concrete implementation of the `agent` seam and lives here because it is the harness's default product loop; everything else in `core/` is interface/vocabulary. Plugins depend on the `agent` vocabulary, never on `agent-loop` directly, so the loop stays swappable.

`agent-core` is the composition counterpart: one bundle plugin that loads the whole providerless spine (`timer` + `llm` + sessions + system-prompt + tools + agents + invariants + `tool-bash` + `agent-loop`) and forwards `agent-loop`'s `agents` list as its own config. App packages (`ui/stdio-agent`, `ui/acp-agent`) consume it and add only a front door; a leaf adds the swappable backends plus any optional product tools it wants to expose. It lives in `core/` because it composes exclusively `core/` + interface packages and ships no provider, executor, or UI of its own.
