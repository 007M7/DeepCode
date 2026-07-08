# core/ — product API spine

The packages every harness build is assembled from: the session log, the system-prompt assembly, the tool registry, the agent vocabulary, and the one concrete loop that drives them. These are **product** packages — the stable surface plugins and consumers build against.

| Package | Role | ctx key |
|---|---|---|
| `session/` | Event-sourced session log + in-memory store | `ctx.sessions` |
| `system-prompt/` | Prompt-section + tool-schema assembly registry | `ctx.systemPrompt` |
| `tools/` | Tool registry + `tools/pre-execute`/`tools/post-execute` pipeline | `ctx.tools` |
| `skill/` | Agent skill provider registry + request-time skill listing | `ctx.skills` |
| `skill-local/` | Local filesystem skill provider | (registers on `ctx.skills`) |
| `tool-skill/` | Model-facing `skill` loader tool | (registers on `ctx.tools`) |
| `agent/` | Agent interface, registry, `agent/*` event vocabulary | `ctx.agents` |
| `agent-loop/` | The concrete loop plugin: `ReactLoopAgent` + the loop driver | `ctx.agentLoop` |
| `agent-core/` | Bundle plugin: the default executor-less/UI-less spine as code | (loads the spine) |

`agent-loop` is the one concrete implementation of the `agent` seam and lives here because it is the harness's default product loop; everything else in `core/` is interface/vocabulary. Plugins depend on the `agent` vocabulary, never on `agent-loop` directly, so the loop stays swappable.

`agent-core` is the composition counterpart: one bundle plugin that loads the default spine (`timer` + `llm` + sessions + system-prompt + tools + skill registry + local skill provider + agents + invariants + `tool-bash` + `tool-skill` + `agent-loop`) and forwards `agent-loop`'s `agents` list as its own config. App packages (`ui/stdio-agent`, `ui/acp-agent`) consume it and add only a front door; a leaf adds the swappable backends plus any optional product tools it wants to expose. It lives in `core/` because it composes the shared core while leaving executors, LLM adapters, non-local skill providers, and UI front doors outside the bundle.
