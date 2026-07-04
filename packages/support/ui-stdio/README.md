# @deepseek-ai/dsh-ui-stdio

A minimal stdio (readline) UI, as a plugin. It reads lines from stdin and feeds them to an agent (`send` when idle, `steer` while a turn is running), and renders that agent's streamed output and tool activity to stdout. A UI is "just a plugin" here — it consumes the `session/event` transcript feed plus a few `agent/*` control events (`agent/status`, `agent/created`/`agent/disposed`) and the `agents` service (`inject: ['agents']`), so the same plugin drives any example or product surface.

This is a **convenience REPL for local testing and the demos, not a product surface** — its observable behavior is free to change. It is deliberately NOT treated as a load-bearing consumer when weighing whether a live event/API must exist: the boundary mirror events were removed precisely because "ui-stdio renders from them" is not a product constraint (it was migrated to `session/event`). The real product surfaces are the ACP bridge (`dsh-acp`) and the app packages.

This package consolidates what were two near-identical copies under `examples/echo-agent` and `examples/coding-agent`. The coding copy was a superset; this package IS that superset — dimmed chain-of-thought rendering plus robust piped-stdin EOF handling — with the per-consumer differences moved into `Config`.

## Config

| Key | Type | Default | Notes |
|---|---|---|---|
| `welcome` | string | `'ready.'` | Banner printed once on start, before the first `> ` prompt. |
| `agent` | string | `'main'` | Id of the agent that stdin **drives** (`send`/`steer`) and whose `agent/status` gates the EOF exit. Rendering is **not** scoped by it — see below. |

```yaml
- id: ui-stdio
  name: '@deepseek-ai/dsh-ui-stdio'
  config:
    welcome: 'agent REPL ready. Give it a coding task.'
```

## Rendering

Rendering is **global** — every agent's events are written to stdout, not just `config.agent`'s. `config.agent` scopes only *input* (which agent stdin drives) and the EOF-exit gate; the single-agent demos this serves have just one agent, so the distinction is moot for them. (A multi-agent UI that needs per-agent panes would filter these handlers by the agent argument — deliberately out of scope here.)

- `session/event` — the durable transcript feed drives ALL rendering, from a single listener so `inReasoning` transitions stay deterministic in append order: `assistant/chunk` writes the model's `text-delta` verbatim and wraps `reasoning-delta` in the dim SGR (`\x1B[2m … \x1B[0m`) so the chain-of-thought is visually subordinate to the answer (inert when no `reasoning-delta` chunks arrive, e.g. a mock model); `turn/start` prints a `[<agent> turn N]` header (the short agent label comes from a session-id→agent-id map seeded from `ctx.agents.list()` at install and kept live via `agent/created`/`agent/disposed`, since the turn event carries only the turn number); `turn/end` prints the trailing `> ` prompt; `tool/call` renders `[tool call] name(args)`; `tool/result` renders the joined text blocks as `[tool result] …`; and `todo/write` renders a glyphed checklist.

## The I/O seam

The production entry point `apply(ctx, config)` binds the real `process` streams. The testable core is `createStdioChat(ctx, config, runtime)`, where `runtime: StdioRuntime` supplies `input` / `output` / `exit`. This seam is deliberately **not** part of the serializable `Config` (streams and functions do not belong in YAML config); it exists so the render, EOF, and disposal branches can be exercised with fakes instead of hijacking globals.

## Piped-stdin exit

On stdin EOF the plugin exits the process, but carefully:

- **No work submitted** (empty stdin, blank-only lines): exit immediately — no turn will ever start, so there is nothing to wait for. Gating on an observed `running` here would hang forever.
- **Work submitted**: exit the next time the agent settles to `idle` *after* having been observed `running`. `agent.send()` does not synchronously flip status to `running`, so requiring an observed `running` first (`sawRunning`) avoids exiting in the gap before the turn starts and dropping work; and the loop batches several queued messages into one turn, so the exit keys off the idle transition rather than counting sends.

Disposal (HMR or fiber teardown) closes the readline interface, which also fires `close` — a `disposed` guard ensures teardown never calls `process.exit`.

## Plugin export shape

Named `name` / `inject` / `Config` / `apply`, with **no default export**: the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default would collapse the module to the bare function and drop the `inject` namespace (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). The keyless Loader-path e2e smokes in `examples/{echo,coding}-agent` guard this end-to-end.
