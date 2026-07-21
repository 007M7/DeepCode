# ui/ — editor/client integration surfaces

Integrations that expose the agent to an external editor or client. These are **product** packages: a real surface a user drives the harness through.

| Package | Role | ctx key |
|---|---|---|
| `acp/` | Agent Client Protocol bridge: serves agents, commands, and live/replayed title updates to an ACP editor over JSON-RPC stdio | (drives `ctx.agents`/`ctx.sessions`) |
| `commands/` | Human-command registry: shared discovery metadata, scoped shadowing, cancellation, and direct UI dispatch | `ctx.commands` |
| `user-approval/` | One-shot user-approval mechanism, closed outcome vocabulary, audit events, and per-session approval policy | `ctx.approval` |
| `permission/` | User-facing permission presets (`workspace-write`/`danger-full-access`): one product-level select bundling the sandbox-mode and approval-policy knobs, written through to their session events | `ctx.permission` |
| `user-interaction/` | Abstract human question/answer seam used by UI-backed confirmation tools | `ctx.userInteraction` |
| `tool-ask-user/` | Model-facing `ask_user_question` tool over `ctx.userInteraction` | (registers on `ctx.tools`) |
| `tui/` | Interactive pi-tui terminal channel; renders session titles/events and tool intents, and answers `ctx.userInteraction` | (drives `ctx.agents`) |
| `jsonrpc/` | Stdio JSON-RPC server for out-of-process SDK clients | (drives `ctx.agents`) |
| `app-boot/` | Shared boot glue for the app bins: `.env` loading, fail-loud Loader guards, snapshot-aware config resolution, the settle-the-tree boot sequence | (library for the bins) |

A UI integration is a client-driver plugin, not a loop change and not a capability seam: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. The `jsonrpc` plugin is the SDK-client sibling of the `acp` bridge (a JSON-RPC server over `ctx.agents` for out-of-process SDK clients rather than editors). [`tui`](tui/README.md) is the interactive terminal front door; non-interactive tasks use the headless `cli-demo` app instead of a UI channel. [`commands`](commands/README.md) is the human-only discovery and dispatch plane shared by TUI and ACP; command input and output do not become model messages.

`user-approval`, `user-interaction`, and `tool-ask-user` live here because asking a human is a UI-backed product affordance, not part of the providerless core spine. `user-approval` owns the one-shot `ctx.approval` decision mechanism and its policy tier; answerers remain with their UI channel owners. `user-interaction` remains provider-neutral (`ctx.userInteraction`), while `tool-ask-user` is its model-facing consumer and the app/bridge packages provide concrete providers.

The runnable app bundles that bake these bridges into boot bins — the TUI app, ACP server app, and JSON-RPC SDK-runtime bin — live in [`examples/`](../examples/README.md) (`tui-demo`, `acp-demo`, `jsonrpc-demo`), each composed over the [`agent-spine-demo`](../examples/agent-spine-demo/README.md) bundle. `ui/` keeps the reusable bridge/channel plugins and the `app-boot` glue; each front door owns its stdout policy, and a leaf `cordis.yml` supplies backends and optional tools.
