# @deepseek-ai/dsh-agent-spine-demo

English | [中文](README.zh.md)

The **default executor-less, UI-less agent spine** as ONE Cordis bundle plugin. It loads the fixed set of services every harness agent needs, including the local skill provider, and forwards the loop's `agents` list as its own config — so an app package composes a working agent by adding only a front door and the swappable backends.

Read this package for the whole plugin tree and its composition order.

## The tree it loads

`apply(ctx, config)` mounts each of these as a child of the bundle fiber:

```
@cordisjs/plugin-timer            timer service (writes nothing to stdout)
@deepseek-ai/dsh-llm              abstract LLM service + content-block vocabulary
@deepseek-ai/dsh-session          event-sourced session log + store
@deepseek-ai/dsh-session-title    log-backed title service + deterministic fallback
@deepseek-ai/dsh-system-prompt    prompt-section + tool-schema assembly
@deepseek-ai/dsh-tools            registry + guarded pre/around/post/final-result pipeline
@deepseek-ai/dsh-skill            skill provider registry
@deepseek-ai/dsh-skill-local      local filesystem skill provider
@deepseek-ai/dsh-agent            agent registry + initiator scope + agent/* events
@deepseek-ai/dsh-goal             optional persisted same-session goal domain
@deepseek-ai/dsh-tool-goal        optional model-facing goal controls
@deepseek-ai/dsh-goal-session     optional same-session goal-round driver
@deepseek-ai/dsh-llm-retry        provider-routed request retry policy
@deepseek-ai/dsh-tasks-local      generic background-task registry
@deepseek-ai/dsh-invariants       configurable invariant registry service
@deepseek-ai/dsh-session/invariant
@deepseek-ai/dsh-agent/invariant
@deepseek-ai/dsh-scope/invariant
@deepseek-ai/dsh-agent-loop/invariant
                                  package-owned relational checks
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
- **model-backed session-title providers** — the bundle mounts the fallback service with overridable example limits (5 words, 40 fallback bytes, 80 accepted-title bytes); a leaf may opt into exactly one first-message or all-messages LLM provider.
- **the bash executor** — the bundle ships `tool-bash` (the consumer schema); the leaf provides `ctx.bash` (`bash-local` or a sandboxed impl).
- **non-local skill providers** — the bundle ships the skill registry, the local filesystem provider, and the `skill` tool; deployments can add other providers such as embedded or remote catalogs as siblings.
- **front-door + per-app infra** — the terminal TUI or ACP automation transport and `hmr`. App packages ([`dsh-tui-demo`](../tui-demo/README.md), [`dsh-acp-demo`](../acp-demo/README.md)) own those choices. `timer` is in the spine because it is common and stdout-silent; front doors own stdout and remain outside.

This is the [interface/implementation/consumer seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) raised to the composition level: the bundle owns the shared spine, the leaf owns the backends, the app package owns the front door.

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-agent-spine-demo'
// { agents?, maxParallelToolCalls?, persona?, toolOrder?, tools?, dshHome?, sessionTitle?, skills?, workspaceContext, toolBash?, toolTasks?, goals?, invariants? }
// workspaceContext requires { maxBytes } or false; the other owner schemas supply defaults.
```

The bundle FORWARDS each field to the child that owns it: `agents` and `maxParallelToolCalls` to `agent-loop` (`agents` defaults to `[]`; the cap defaults there), so each app supplies its own pre-created agents — TUI and headless apps pre-create `main`, while the ACP app creates agents on demand at `session/new`; `persona` and `toolOrder` to `dsh-system-prompt`; `tools` to the tool registry for its presentation mode; `sessionTitle` to the fallback title service; `skills.registry`, `skills.local`, and `skills.tool` to the skill registry, local provider, and model-facing consumer; the required `workspaceContext` choice to `dsh-workspace-context` (`{ maxBytes }` enables loading and `false` disables it); `invariants` to the invariant service; and `toolBash`/`toolTasks` to the two model-facing tool plugins the bundle owns. It always mounts `dsh-llm-retry`, while each leaf adapter owns its nested `retryPolicy`. Omitted `sessionTitle` uses the explicit example policy of 5 words, 40 fallback bytes, and 80 accepted-title bytes. A `goals` object opts into the persisted domain, model tools, and same-session driver while forwarding `goals.domain` and `goals.tool` to their owners; omission or `false` leaves the stack absent so headless callers retain one-turn settlement. Set `skills.enabled: false` to omit both the local provider and model-facing skill tool, and set `toolTasks: false` to retain the task service for foreground producers without exposing `task_output` / `task_list` / `task_kill`. It resolves `dshHome` once through [`@deepseek-ai/dsh-paths`](../../util/paths/README.md) and forwards that absolute value to tool-bash's managed environment and enabled local skill discovery. An absent top-level `dshHome` adopts `skills.local.dshHome`; supplying both with different resolved paths fails loudly. `toolBash.enableRunInBackground` controls only the bash producer; independently loaded producers keep their own config. Workspace instructions register before the skill catalog so their session-prefix message renders first. App packages use `pickSpineConfig()` to copy only these bundle-owned fields.

For example, `{ invariants: { enabled: true, package_allowlist: ['^@deepseek-ai/dsh-'], package_blocklist: ['agent-loop$'] } }` keeps the package-owned companions mounted but suppresses the blocked owner. Blocklist matches override allowlist matches; see [`dsh-invariants`](../../support/invariants/README.md) for regex and lifecycle rules.

## Why a code bundle, not a shared YAML include

A YAML include can deduplicate config but cannot own a bin or provide front-door defaults. The ACP app package makes protocol-pure stdout wiring the default, though a leaf can still add an unsafe logger. Bundle children register services in the root isolate-keyed store, so injected leaf siblings see them without load-order coupling.

The retry policy may repeat a failed request in a new numbered step. Retry status, provider errors, and failed partial chunks stay outside model history; each provider attempt can still incur billing, always mode has no attempt limit, front doors derive usage across every logged step, and the reconstructed request preserves the prior prefix for provider cache reuse.

## Model Experience

Indirectly, through `dsh-system-prompt`, `dsh-tool-skill`, `dsh-tool-bash`, `dsh-tools`, and `dsh-llm-retry`, plus `dsh-tool-goal` and goal-round prompts when `goals` is enabled. The bundle adds no model-bound wrapper content of its own.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Most of the spine set is fixed in code** — `apply()` always mounts the core services and `tool-bash`; config can omit bundled goals, skills, and task-control tools, but swapping the loop or dropping another spine member means composing a different bundle.
- **The invariant seam and companions remain fixed members** — `invariants.enabled: false` or package filters suppress checks but do not remove the service or companion registrations; Session's always-on validation and freezing are separate.
