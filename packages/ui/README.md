# ui/ — editor/client integration surfaces

Integrations that expose the agent to an external editor or client. These are **product** packages: a real surface a user drives the harness through.

| Package | Role | ctx key |
|---|---|---|
| `acp/` | Agent Client Protocol bridge: serves the agent to an ACP editor (Zed) over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `stdio-agent/` | Terminal stdio chat APP: the agent-core spine + console logger + readline UI + a pre-created `main` agent, with a `bin` | (composition + `bin`) |
| `acp-agent/` | ACP server APP: the agent-core spine + JSONL persistence + the `acp` bridge (no stdout logger), with a `bin` | (composition + `bin`) |

A UI integration is a client-driver plugin, not a loop change and not a capability seam: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. The readline `ui-stdio` plugin is the unstructured analogue but lives in `support/` because it exists chiefly for the examples and the coverage gate — `ui/` is reserved for surfaces shipped as product.

`stdio-agent` and `acp-agent` are the two **app packages**: each composes the [`core/agent-core`](../core/agent-core/README.md) spine with its coupled front-door cluster (and owns the boot `bin`), so a leaf `cordis.yml` is just the swappable backends plus one app entry. They live in `ui/` because each IS a user-facing front door; the stdout-purity coupling (logger vs. no logger) becomes a property of the artifact rather than a leaf convention.
