# ui/ — editor/client integration surfaces

Integrations that expose the agent to an external editor or client. These are **product** packages: a real surface a user drives the harness through.

| Package | Role | ctx key |
|---|---|---|
| `acp/` | Agent Client Protocol bridge: serves the agent to an ACP editor (Zed) over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `user-approval/` | One-shot user-approval mechanism, closed outcome vocabulary, audit events, and per-session approval policy | `ctx.approval` |
| `permission/` | User-facing permission presets (`workspace-write`/`danger-full-access`): one product-level select bundling the sandbox-mode and approval-policy knobs, written through to their session events | `ctx.permission` |
| `user-interaction/` | Abstract human question/answer seam used by UI-backed confirmation tools | `ctx.userInteraction` |
| `tool-ask-user/` | Model-facing `ask_user_question` tool over `ctx.userInteraction` | (registers on `ctx.tools`) |
| `stdio/` | Terminal readline channel over `ctx.agents`, `session/event`, and `ctx.userInteraction`; agent lifecycle stays with app/developer code | (drives `ctx.agents`) |
| `stdio-agent/` | Terminal stdio chat APP: the agent-core spine + console logger + readline UI + a pre-created `main` agent, with a `bin` | (composition + `bin`) |
| `acp-agent/` | ACP server APP: the agent-core spine + JSONL persistence + the `acp` bridge (no stdout logger), with a `bin` | (composition + `bin`) |
| `jsonrpc/` | Stdio JSON-RPC server for out-of-process SDK clients | (drives `ctx.agents`) |
| `jsonrpc-agent/` | Bin-only SDK runtime app that boots an external `cordis.yml` | (`bin` only) |
| `app-boot/` | Shared boot glue for the app bins: `.env` loading, fail-loud Loader guards, snapshot-aware config resolution, the settle-the-tree boot sequence | (library for the bins) |

A UI integration is a client-driver plugin, not a loop change and not a capability seam: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. The `jsonrpc` plugin is the SDK-client sibling of the `acp` bridge (a JSON-RPC server over `ctx.agents` for out-of-process SDK clients rather than editors). The [`stdio`](stdio/README.md) plugin is the unstructured readline analogue of the `acp` bridge; app bundles and SDK projects compose it explicitly with the services and tools their product profile selects.

`user-approval`, `user-interaction`, and `tool-ask-user` live here because asking a human is a UI-backed product affordance, not part of the providerless core spine. `user-approval` owns the one-shot `ctx.approval` decision mechanism and its policy tier; answerers remain with their UI channel owners. `user-interaction` remains provider-neutral (`ctx.userInteraction`), while `tool-ask-user` is its model-facing consumer and the app/bridge packages provide concrete providers.

`stdio-agent` and `acp-agent` compose the [`agent-core`](../core/agent-core/README.md) spine with their front-door plugins and own their boot bins; a leaf `cordis.yml` supplies backends and optional tools. `jsonrpc-agent` is bin-only because its external config also chooses the serving `jsonrpc` plugin. Each lives in `ui/` as a user-facing front door whose artifact owns its stdout policy.
