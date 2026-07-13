# @deepseek-ai/dsh-tool-subagent

The `subagent` tool lets the model delegate one self-contained task and collect the child's final output. It is a thin consumer of `ctx.subagents`; changing the configured provider changes the transport without changing the model-facing execution contract.

## Provider selection

Each plugin instance binds to exactly one provider. The model sees `{ description, prompt }`, not a provider selector. To expose multiple transports, load the plugin multiple times with distinct `toolName` values.

The description is derived from `provider.inheritsParentContext`: spawn and ACP tell the model to provide a standalone prompt, while fork says the child already sees completed conversation turns. The plugin follows `subagent/provider-added` and `subagent/provider-removed`, so concurrent Cordis plugin loading does not create a registration-order dependency.

## Lifecycle

`execute` passes the tool execution's abort signal when present, otherwise supplies an inert signal to satisfy the required `SubagentStartRequest.signal`. It awaits `ctx.subagents.start(...)`, then awaits `run.result` inside a `try/finally` that always calls `run.dispose()`. The selected signal therefore covers startup and live execution, while disposal guarantees quiescence on success, failure, and abort.

A non-`completed` stop reason becomes an `isError` tool result; partial child output is never reported as success. The current tool blocks the parent turn until collection finishes; background and polling modes are deferred.

## Config

| Key | Meaning |
|---|---|
| `provider` | Required `ctx.subagents` provider name. |
| `toolName` | Model-facing tool name (default `subagent`). Must be unique per plugin instance. |
| `agentOptions` | Default child agent options, currently including `model`. |
| `persona` | Per-child persona; requires provider `persona` capability. |
| `toolFilter` | Per-child global-tool restriction; requires provider `toolFilter` capability. |
| `maxDepth` | Absolute delegation-depth cap; requires provider `depthLimit` capability. |

`toolFilter` changes the child's visible global tool layer; it is not a parent-derived authority ceiling. See the [agent-scope security non-goal](../../../docs/rfc/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-explicit-non-goals).

## Model Experience

| Context surface | What the model sees | Token effect |
|---|---|---|
| Standalone-provider schema | While a fresh-context provider exists, the configured tool uses the exact [standalone tool](#standalone-provider-tool-description) and [`prompt` parameter](#standalone-provider-prompt-description) descriptions. | Fixed schema cost per parent request while mounted. Removing the provider removes the whole schema. |
| Inherited-context-provider schema | A provider that seeds completed turns uses the exact [inherited-context tool](#inherited-context-provider-tool-description) and [`prompt` parameter](#inherited-context-provider-prompt-description) descriptions. Both variants describe `description` exactly as `A short (3-5 word) description of the delegated task, for display.` | Fixed schema cost per parent request while mounted. Exposing multiple providers adds one independently named schema per load. |
| Tool-call history and result | The task description and full prompt remain in the parent assistant tool call. Success contains only the child's data-dependent final text. Other stop reasons become exactly `Error: subagent run was cancelled`, `Error: subagent run failed`, `Error: subagent run hit its token limit before finishing`, `Error: subagent declined the task`, or `Error: subagent run ended abnormally (<reason>)`; a call without an owning agent becomes `Error: subagent tool requires a calling agent (exec.agent was undefined)`. Intermediate child steps never enter the parent. | Prompt and final output are data-dependent retained tokens. All child working context is paid in the child and omitted from the parent. |

### Verbatim model-visible text

#### Standalone-provider tool description

```text
Delegate a self-contained task to a subagent (a separate agent that works in its own context) and return its final result. Use this to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent runs to completion and you receive only its final answer, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation.
```

#### Standalone-provider prompt description

```text
The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.
```

#### Inherited-context-provider tool description

```text
Delegate a task to a subagent that INHERITS this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn), returning only its final result. Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive only its final answer, not its intermediate steps.
```

#### Inherited-context-provider prompt description

```text
The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new.
```

## Known Limitations and Deferred Work

- **Delegation blocks the parent turn** — synchronous collect only; background start and poll collection are deferred to the long-running-runtime redesign.
- **Duplicate `toolName` across waiting loads is detected late** (`TODO(subagent-dup-toolname)`) — two loads waiting on providers collide only when a provider arrives, and the throw rolls back the provider's fiber rather than the misconfigured tool's; config-time detection needs a cross-fiber registry of intended names.
- **Child policy is fixed per tool registration** — `model`, persona, tool filter, and depth cap come from this plugin load's config, not model-call arguments; exposing another policy requires another distinctly named tool.
