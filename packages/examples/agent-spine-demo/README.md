# @deepseek-ai/dsh-agent-spine-demo

The **default executor-less, UI-less agent spine** as ONE Cordis bundle plugin. It loads the fixed set of services every harness agent needs, including the local skill provider, and forwards the loop's `agents` list as its own config — so an app package composes a working agent by adding only a front door and the swappable backends.

Read this package for the whole plugin tree and its composition order.

## The tree it loads

`apply(ctx, config)` mounts each of these as a child of the bundle fiber:

```
@cordisjs/plugin-timer            timer service (writes nothing to stdout)
@deepseek-ai/dsh-llm              abstract LLM service + content-block vocabulary
@deepseek-ai/dsh-session          event-sourced session log + store
@deepseek-ai/dsh-system-prompt    prompt-section + tool-schema assembly
@deepseek-ai/dsh-tools            registry + guarded pre/around/post/final-result pipeline
@deepseek-ai/dsh-skill            skill provider registry
@deepseek-ai/dsh-skill-local      local filesystem skill provider
@deepseek-ai/dsh-agent            agent registry + initiator scope + agent/* events
@deepseek-ai/dsh-llm-retry        bounded transient request retry policy
@deepseek-ai/dsh-tasks            generic background-task registry
@deepseek-ai/dsh-invariants       dev-mode event-contract assertions
@deepseek-ai/dsh-tool-bash        the model-facing bash schema
@deepseek-ai/dsh-workspace-context  AGENTS.md/CLAUDE.md workspace context loader
@deepseek-ai/dsh-tool-skill       session-prefix skill catalog + model-facing loader schema
@deepseek-ai/dsh-tool-tasks       task_output/task_list/task_kill schemas + completion notices
@deepseek-ai/dsh-agent-loop       THE concrete loop (gets the forwarded `agents`)
                                  (dsh-system-prompt gets the forwarded `persona`)
```

## What it deliberately leaves OUTSIDE the bundle

The spine is everything COMMON to every front door. The swappable and front-door-coupled pieces stay out, picked by whatever loads the bundle:

- **the LLM adapter** — the bundle ships the abstract `llm` service; the leaf registers a concrete adapter on `ctx.llm` (`llm-deepseek`, `llm-pi-ai`, `llm-replay`).
- **the bash executor** — the bundle ships `tool-bash` (the consumer schema); the leaf provides `ctx.bash` (`bash-local` or a sandboxed impl).
- **non-local skill providers** — the bundle ships the skill registry, the local filesystem provider, and the `skill` tool; deployments can add other providers such as embedded or remote catalogs as siblings.
- **presentation + per-app infra** — the terminal TUI or ACP front door and `hmr`. These form the coupled front-door cluster that the app packages ([`dsh-tui-demo`](../tui-demo/README.md), [`dsh-acp-demo`](../acp-demo/README.md)) bake in. `timer` is in the spine because it is common and stdout-silent; front doors own stdout and remain outside.

This is the [interface/implementation/consumer seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) raised to the composition level: the bundle owns the shared spine, the leaf owns the backends, the app package owns the front door.

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-agent-spine-demo'
// { agents?, maxParallelToolCalls?, persona?, toolOrder?, tools?, dshHome?, skills?, workspaceContext, toolBash?, toolTasks?, llmRetry? }
// workspaceContext requires { maxBytes } or false; the other owner schemas supply defaults.
```

The bundle FORWARDS each field to the child that owns it: `agents` and `maxParallelToolCalls` to `agent-loop` (`agents` defaults to `[]`; the cap defaults there), so each app supplies its own pre-created agents — TUI and headless apps pre-create `main`, while the ACP app creates agents on demand at `session/new`; `llmRetry` to the bounded retry policy; `persona` and `toolOrder` to `dsh-system-prompt`; `tools` to the tool registry for its presentation mode; `skills.registry`, `skills.local`, and `skills.tool` to the skill registry, local provider, and model-facing consumer; the required `workspaceContext` choice to `dsh-workspace-context` (`{ maxBytes }` enables loading and `false` disables it); and `toolBash`/`toolTasks` to the two model-facing tool plugins the bundle owns. Set `skills.enabled: false` to omit both the local provider and model-facing skill tool, and set `toolTasks: false` to retain the task service for foreground producers without exposing `task_output` / `task_list` / `task_kill`. It resolves `dshHome` once through [`@deepseek-ai/dsh-home`](../../util/home/README.md) and forwards that absolute value to tool-bash's managed environment and enabled local skill discovery. An absent top-level `dshHome` adopts `skills.local.dshHome`; supplying both with different resolved paths fails loudly. `toolBash.enableRunInBackground` controls only the bash producer; independently loaded producers keep their own config. Workspace instructions register before the skill catalog so their session-prefix message renders first. App packages use `pickSpineConfig()` to copy only these bundle-owned fields.

## Why a code bundle, not a shared YAML include

A YAML include can deduplicate config but cannot own a bin or provide front-door defaults. App packages make stdout-safe ACP wiring the default, though a leaf can still add an unsafe logger. Bundle children register services in the root isolate-keyed store, so injected leaf siblings see them without load-order coupling.

The bounded retry policy may repeat a transiently failed request in a new numbered step. Retry status and failed partial chunks stay outside model history, each provider attempt can still incur billing, front doors derive usage across every logged step, and the reconstructed request preserves the prior prefix for provider cache reuse.

## Model Experience

Indirectly, through `dsh-system-prompt`, `dsh-tool-skill`, `dsh-tool-bash`, `dsh-tools`, and `dsh-llm-retry`, which this bundle mounts without adding model-bound wrapper content.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Most of the spine set is fixed in code** — `apply()` always mounts the core services and `tool-bash`; config can omit the bundled skills and task-control tools, but swapping the loop or dropping another spine member means composing a different bundle.
- **`dsh-invariants` mounts unconditionally** — this bundle has no toggle, so every composition using it pays the dev-mode relational assertions; Session's always-on validation and freezing are separate.
