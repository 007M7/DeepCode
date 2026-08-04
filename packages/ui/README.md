# ui/ — human and SDK-client integration surfaces

English | [中文](README.zh.md)

Human-facing channels and the out-of-process SDK server. These are **product** packages: real interfaces that a person or SDK client drives.

| Package | Role | ctx key |
|---|---|---|
| `commands/` | Human-command registry: shared discovery metadata, scoped shadowing, cancellation, and direct UI dispatch | `ctx.commands` |
| `user-approval/` | One-shot user-approval mechanism, closed outcome vocabulary, audit events, and per-session approval policy | `ctx.approval` |
| `permission/` | User-facing permission presets (`workspace-write`/`danger-full-access`): one product-level select bundling the sandbox-mode and approval-policy knobs, written through to their session events | `ctx.permission` |
| `user-interaction/` | Abstract human question/answer seam used by UI-backed confirmation tools | `ctx.userInteraction` |
| `tool-ask-user/` | Model-facing `ask_user_question` tool over `ctx.userInteraction` | (registers on `ctx.tools`) |
| `jsonrpc/` | Stdio JSON-RPC server for out-of-process SDK clients | (drives `ctx.agents`) |
| `app-boot/` | Shared boot glue for the app bins: `.env` loading, fail-loud Loader guards, snapshot-aware config resolution, the settle-the-tree boot sequence | (library for the bins) |

A UI integration is a client-driver plugin, not a loop change: it consumes the existing `agent/*` event taxonomy and the `dsh-agent` factory. [`jsonrpc`](jsonrpc/README.md) serves out-of-process SDK clients, while non-interactive one-shot tasks use `cli-demo`. [`commands`](commands/README.md) is the human-only discovery and dispatch plane for interactive adapters; command input and output do not become model messages.

`user-approval`, `user-interaction`, and `tool-ask-user` live here because asking a human is a UI-backed product affordance, not part of the providerless core spine. `user-approval` owns the one-shot `ctx.approval` decision mechanism and its policy tier; answerers remain with the channel or automation transport that owns the agent. `user-interaction` remains provider-neutral (`ctx.userInteraction`), while `tool-ask-user` is its model-facing consumer and interactive app packages provide concrete providers.

The runnable app bundles composed over [`agent-spine-demo`](../examples/agent-spine-demo/README.md) live in [`examples/`](../examples/README.md) (`cli-demo`, `acp-demo`, `jsonrpc-demo`), each with its own entry contract. The product [`dsh`](../../apps/cli/README.md) CLI uses no demo bundle. `ui/` keeps the reusable human/SDK channel plugins and shared `app-boot` glue; the automation-only ACP transport lives in [`acp/`](../acp/README.md). Each front door owns its stdout policy, and a leaf `cordis.yml` supplies backends and optional tools.
