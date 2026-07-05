# @deepseek-ai/dsh-agent-core

The **providerless, executor-less, UI-less agent spine** as ONE Cordis bundle plugin. It loads the fixed set of services every harness agent needs and forwards the loop's `agents` list as its own config — so an app package composes a working agent by adding only a front door and the swappable backends.

This is the package to read to see **the whole plugin tree at once** — the teaching role the inlined `echo-agent` `cordis.yml` used to play before the spine moved behind this bundle.

## The tree it loads

`apply(ctx, config)` mounts each of these as a child of the bundle fiber:

```
@cordisjs/plugin-timer            timer service (writes nothing to stdout)
@deepseek-ai/dsh-llm              abstract LLM service + content-block vocabulary
@deepseek-ai/dsh-session          event-sourced session log + store
@deepseek-ai/dsh-system-prompt    prompt-section + tool-schema assembly
@deepseek-ai/dsh-tools            tool registry + tools/pre-execute/post-execute
@deepseek-ai/dsh-agent            agent registry + agent/* event vocabulary
@deepseek-ai/dsh-invariants       dev-mode event-contract assertions
@deepseek-ai/dsh-tool-bash        the model-facing bash/bash_output/bash_kill schemas
@deepseek-ai/dsh-agent-loop       THE concrete loop (gets the forwarded `agents`)
                                  (dsh-system-prompt gets the forwarded `persona`)
```

## What it deliberately leaves OUTSIDE the bundle

The spine is everything COMMON to every front door. The swappable and front-door-coupled pieces stay out, picked by whatever loads the bundle:

- **the LLM adapter** — the bundle ships the abstract `llm` service; the leaf registers a concrete adapter on `ctx.llm` (`llm-deepseek`, `llm-pi-ai`, `llm-replay`).
- **the bash executor** — the bundle ships `tool-bash` (the consumer schema); the leaf provides `ctx.bash` (`bash-local` or a sandboxed impl).
- **presentation + per-app infra** — the stdio UI / ACP bridge, a console logger, `hmr`. These form the coupled "front-door cluster" that the app packages ([`dsh-stdio-agent`](../../ui/stdio-agent/README.md), [`dsh-acp-agent`](../../ui/acp-agent/README.md)) bake in. `timer` is in the spine (common to both, stdout-silent); a console logger is NOT (it writes to stdout, which the ACP bridge reserves for JSON-RPC).

This is the [interface/implementation/consumer seam](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md) raised to the composition level: the bundle owns the shared spine, the leaf owns the backends, the app package owns the front door.

## Config

```ts
import type { Config } from '@deepseek-ai/dsh-agent-core'
// { agents?, persona? } — the schema is z.intersect([AgentLoop.Config, SystemPrompt.Config]),
// so validation and defaulting can never drift from the owners'.
```

The bundle FORWARDS each field to the child that owns it: `agents` to `agent-loop` (default `[]`), so each app supplies its own pre-created agents — a stdio app pre-creates a `main`; the ACP app pre-creates none (it creates agents on demand at `session/new`) — and `persona` to `dsh-system-prompt` (default `''`), the deployment's persona section. Forwarding is exactly why the owners can live in the shared spine even though the apps disagree on what to configure.

## Why a code bundle, not a shared YAML include

A YAML include can dedupe the config, but it cannot OWN a `bin`, and it can only *describe* the front-door coupling in a comment and trust each leaf to obey. Moving the spine into a package, and the front-door cluster into the app packages, means the default leaf for an ACP server has no logger entry to copy wrong — "the ACP app never logs to stdout" stops being a prose warning a leaf must remember and becomes the app package's default shape (a leaf can still add a sibling logger, so the rule stays documented — but it has nothing to get wrong by default). Services register in the root store keyed by their isolate symbol, so a child loaded here is visible to the bundle's siblings (the leaf's adapter and executor) exactly as a nested `plugin-include` subtree's services were — cordis gates every read on `inject`, never on load order.
