# ui/ — editor/client integration surfaces

Integrations that expose the agent to an external editor or client. These are **product** packages: a real surface a user drives the harness through.

| Package | Role | ctx key |
|---|---|---|
| `acp/` | Agent Client Protocol bridge: serves the agent to an ACP editor (Zed) over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `user-interaction/` | Abstract human question/answer seam used by UI-backed confirmation tools | `ctx.userInteraction` |
| `tool-ask-user/` | Model-facing `ask_user_question` tool over `ctx.userInteraction` | (registers on `ctx.tools`) |
| `stdio-agent/` | Terminal stdio chat APP: the agent-core spine + console logger + readline UI + a pre-created `main` agent, with a `bin` | (composition + `bin`) |
| `acp-agent/` | ACP server APP: the agent-core spine + JSONL persistence + the `acp` bridge (no stdout logger), with a `bin` | (composition + `bin`) |
| `app-boot/` | Shared boot glue for the two app bins: `.env` loading, fail-loud Loader guards, snapshot-aware config resolution, the settle-the-tree boot sequence | (library for the bins) |

A UI integration is a client-driver plugin, not a loop change and not a capability seam: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. The readline UI is the unstructured analogue of the `acp` bridge and lives INSIDE the stdio app (the `stdio-chat` module of [`stdio-agent/`](stdio-agent/README.md)): it is scaffolding for that one front door, not an independently swappable integration, so it carries no package boundary of its own.

`user-interaction` and `tool-ask-user` live here because asking a human is a UI-backed product affordance, not part of the providerless core spine. The seam remains provider-neutral (`ctx.userInteraction`), while the tool is the model-facing consumer and the app/bridge packages provide concrete providers.

`stdio-agent` and `acp-agent` are the two **app packages**: each composes the [`core/agent-core`](../core/agent-core/README.md) spine with its coupled front-door cluster (and owns the boot `bin`), so a leaf `cordis.yml` is the swappable backends plus one app entry plus any optional product tools. They live in `ui/` because each IS a user-facing front door; the stdout-purity coupling (logger vs. no logger) becomes a property of the artifact rather than a leaf convention.
