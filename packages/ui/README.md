# ui/ — editor/client integration surfaces

Integrations that expose the agent to an external editor or client. These are **product** packages: a real surface a user drives the harness through.

| Package | Role | ctx key |
|---|---|---|
| `acp/` | Agent Client Protocol bridge: serves the agent to an ACP editor (Zed) over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |

A UI integration is a client-driver plugin, not a loop change and not a capability seam: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. The readline `ui-stdio` plugin is the unstructured analogue but lives in `support/` because it exists chiefly for the examples and the coverage gate — `ui/` is reserved for surfaces shipped as product.
