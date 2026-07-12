# @deepseek-ai/dsh-tool-subagent

The model-facing `subagent` tool: delegate a self-contained task to a child agent and return its final output. Pure schema + lifecycle shaping over the [`ctx.subagents`](../subagent/README.md) provider registry — an in-process, ACP, or future A2A backend swaps in without changing what the model sees.

## Provider selection is config, not model-facing

This plugin binds to **exactly one** provider (`Config.provider`). The model sees only `{ description, prompt }` — there is no provider/type parameter in the schema. To expose more than one transport, load the plugin more than once, each bound to a different provider **and a distinct `toolName`** (the tool registry rejects a duplicate name, so a second load that kept the default `subagent` name would throw). Keeping selection in config (not the schema) is the deliberate split: the *service* holds a multi-provider registry; the *tool* picks one.

## The description states the provider's conversation-history descriptor

The tool description and the `prompt` parameter description are DERIVED from the bound provider's `inheritsParentContext` (`providerWording`): a fresh-conversation provider (spawn, ACP) gets the standalone-prompt wording ("it does not see this conversation"), while fork tells the model the child is seeded with the conversation's completed turns and its prompt should state only what is new. The descriptor concerns conversation history only, not tool or authority inheritance. Because the description is fixed at tool registration, the tool **mirrors the provider's lifecycle** (`subagent/provider-added`/`-removed`): it registers when the bound provider is (or becomes) available and unregisters when the provider goes away — no load-order requirement (the cordis Loader starts sibling plugins concurrently, so "listed first" never guaranteed "registered first"), and an HMR reload of the backend re-derives the wording from the fresh provider. While the provider is absent the tool simply does not exist (a `ctx.logger` note records the wait; a typo'd provider name shows up as a tool that never materializes).

| Config key | Meaning |
|---|---|
| `provider` (required) | The `ctx.subagents` provider name to start runs on (`spawn`, `fork`, `acp`, …). |
| `toolName` | The model-facing tool name to register (default `subagent`). Set a distinct value per load when exposing multiple providers, e.g. `subagent` + `subagent_acp`. |
| `agentOptions` | Default per-child `{ model? }` applied to every spawned child. |
| `persona` | Per-child persona that shadows the deployment persona; requires the provider's `persona` capability. |
| `toolFilter` | Per-child `{ allow?, deny? }` restriction over global tools; requires the provider's `toolFilter` capability. |
| `maxDepth` | Maximum absolute delegation-tree depth for every child this tool starts; a non-negative safe integer validated when this plugin loads. Requires the provider's `depthLimit` capability. |

`toolFilter` uses [`ToolRegistry.restrict()`](../../core/tools/README.md)'s live global-view semantics and is not a parent-derived authority ceiling; see the [agent-scope security non-goal](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-explicit-non-goals).

## Lifecycle (synchronous collect)

`execute` starts a run on the configured provider and **awaits `run.result` inside a `try/finally` that always `dispose()`s the run** — the owned child agent/session is torn down on every path (success, error, abort), never leaked. The tool's abort signal (`exec.signal`) is bridged to `run.cancel()`. A non-`completed` stop reason (aborted/error/max-tokens/refusal) maps to an `isError` tool result rather than returning partial output as success.

Background / poll collection is deferred (see the [RFC](../../../docs/rfc/implemented/feature/2026-06-21-subagent-capability-seam.md)); this cut blocks the parent turn until the child finishes.
