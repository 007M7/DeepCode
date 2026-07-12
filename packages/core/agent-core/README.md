# @deepseek-ai/dsh-agent-core

The **default executor-less, UI-less agent spine** as ONE Cordis bundle plugin. It loads the fixed set of services every harness agent needs, including the local skill provider, and forwards the loop's `agents` list as its own config — so an app package composes a working agent by adding only a front door and the swappable backends.

This is the package to read to see **the whole plugin tree at once** and the canonical teaching map for the shared spine.

## The tree it loads

`apply(ctx, config)` mounts each of these as a child of the bundle fiber:

```
@cordisjs/plugin-timer            timer service (writes nothing to stdout)
@deepseek-ai/dsh-llm              abstract LLM service + content-block vocabulary
@deepseek-ai/dsh-session          event-sourced session log + store
@deepseek-ai/dsh-system-prompt    prompt-section + tool-schema assembly
@deepseek-ai/dsh-tools            tool registry + tools/pre-execute/post-execute
@deepseek-ai/dsh-skill            skill provider registry
@deepseek-ai/dsh-skill-local      local filesystem skill provider
@deepseek-ai/dsh-agent            agent registry + agent/* event vocabulary
@deepseek-ai/dsh-invariants       dev-mode event-contract assertions
@deepseek-ai/dsh-tool-bash        the model-facing bash/bash_output/bash_kill schemas
@deepseek-ai/dsh-workspace-context  AGENTS.md/CLAUDE.md workspace context loader
@deepseek-ai/dsh-tool-skill       session-prefix skill catalog + model-facing loader schema
@deepseek-ai/dsh-agent-loop       THE concrete loop (gets the forwarded `agents`)
                                  (dsh-system-prompt gets the forwarded `persona`)
```

## What it deliberately leaves OUTSIDE the bundle

The spine is everything COMMON to every front door. The swappable and front-door-coupled pieces stay out, picked by whatever loads the bundle:

- **the LLM adapter** — the bundle ships the abstract `llm` service; the leaf registers a concrete adapter on `ctx.llm` (`llm-deepseek`, `llm-pi-ai`, `llm-replay`).
- **the bash executor** — the bundle ships `tool-bash` (the consumer schema); the leaf provides `ctx.bash` (`bash-local` or a sandboxed impl).
- **non-local skill providers** — the bundle ships the skill registry, the local filesystem provider, and the `skill` tool; deployments can add other providers such as embedded or remote catalogs as siblings.
- **presentation + per-app infra** — the stdio UI / ACP bridge, a console logger, `hmr`. These form the coupled "front-door cluster" that the app packages ([`dsh-stdio-agent`](../../ui/stdio-agent/README.md), [`dsh-acp-agent`](../../ui/acp-agent/README.md)) bake in. `timer` is in the spine (common to both, stdout-silent); a console logger is NOT (it writes to stdout, which the ACP bridge reserves for JSON-RPC).

This is the [interface/implementation/consumer seam](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md) raised to the composition level: the bundle owns the shared spine, the leaf owns the backends, the app package owns the front door.

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-agent-core'
// { agents?, persona?, toolOrder?, tools?, skills?, workspaceContext } — workspaceContext requires { maxBytes } or false;
// so validation and defaulting can never drift from the owners.
```

The bundle FORWARDS each field to the child that owns it: `agents` to `agent-loop` (default `[]`), so each app supplies its own pre-created agents — a stdio app pre-creates a `main`; the ACP app pre-creates none (it creates agents on demand at `session/new`) — `persona` and `toolOrder` to `dsh-system-prompt`; `tools` to the tool registry for its presentation mode; `skills.registry`, `skills.local`, and `skills.tool` to the skill registry, local provider, and model-facing consumer; and the required `workspaceContext` choice to `dsh-workspace-context` (`{ maxBytes }` enables loading and `false` disables it). Workspace instructions are registered before the skill catalog so their session-prefix message renders first. Forwarding is exactly why the owners can live in the shared spine even though the apps disagree on what to configure.

## Why a code bundle, not a shared YAML include

A YAML include can dedupe config, but it cannot own a `bin` or enforce front-door coupling. The app packages own that cluster, so the default ACP shape contains no stdout logger entry for a leaf to reproduce; a deployment can still add a sibling logger explicitly. Services register in the root store keyed by their isolate symbol, so a child loaded here is visible to the bundle's siblings (the leaf's adapter and executor); Cordis gates every read on `inject`, never on load order.
