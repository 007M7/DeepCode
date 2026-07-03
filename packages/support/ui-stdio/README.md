# @deepseek-ai/dsh-ui-stdio

A minimal stdio (readline) UI, as a plugin. It reads lines from stdin and feeds them to an agent (`send` when idle, `steer` while a turn is running), and renders that agent's streamed output and tool activity to stdout. A UI is "just a plugin" here — it only consumes the `agent/*` event taxonomy plus the `agents` service (`inject: ['agents']`), so the same plugin drives any example or product surface.

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

- `agent/stream-chunk` — `text-delta` is written verbatim; `reasoning-delta` is wrapped in the dim SGR (`\x1B[2m … \x1B[0m`) so the chain-of-thought is visually subordinate to the answer. Reasoning rendering is inert when no `reasoning-delta` chunks arrive (e.g. a mock model), so it is always on.
- `agent/turn-start` / `agent/turn-end` — a `[<agent> turn N]` header and a trailing `> ` prompt.
- `session/event` — `tool/call` renders `[tool call] name(args)`; `tool/result` renders the joined text blocks as `[tool result] …`.

## The I/O seam

The production entry point `apply(ctx, config)` binds the real `process` streams. The testable core is `createStdioChat(ctx, config, runtime)`, where `runtime: StdioRuntime` supplies `input` / `output` / `exit`. This seam is deliberately **not** part of the serializable `Config` (streams and functions do not belong in YAML config); it exists so the render, EOF, and disposal branches can be exercised with fakes instead of hijacking globals.

## Piped-stdin exit

On stdin EOF the plugin exits the process, but carefully:

- **No work submitted** (empty stdin, blank-only lines): exit immediately — no turn will ever start, so there is nothing to wait for. Gating on an observed `running` here would hang forever.
- **Work submitted**: exit the next time the agent settles to `idle` *after* having been observed `running`. `agent.send()` does not synchronously flip status to `running`, so requiring an observed `running` first (`sawRunning`) avoids exiting in the gap before the turn starts and dropping work; and the loop batches several queued messages into one turn, so the exit keys off the idle transition rather than counting sends.

Disposal (HMR or fiber teardown) closes the readline interface, which also fires `close` — a `disposed` guard ensures teardown never calls `process.exit`.

## Plugin export shape

Named `name` / `inject` / `Config` / `apply`, with **no default export**: the cordis Loader's `unwrapExports` does `exports.default ?? exports`, so a stray default would collapse the module to the bare function and drop the `inject` namespace (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)). The keyless Loader-path e2e smokes in `examples/{echo,coding}-agent` guard this end-to-end.
