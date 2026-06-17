# @deepseek-ai/dsh-acp

The **Agent Client Protocol (ACP)** bridge: exposes the DeepSeek Harness coding agent as an ACP server over JSON-RPC stdio, so editors (Zed and other ACP clients) can drive it — streaming render, tool-call display, and resumable sessions.

It is a **client-driver / UI plugin**, the structured analogue of the readline `stdio-chat` plugin — NOT a loop change and NOT a [capability seam](../../docs/rfc/implemented/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

## Service / plugin

`apply(ctx, config)` — wires an `AgentSideConnection` (from `@agentclientprotocol/sdk`) to `process.stdin`/`process.stdout` and implements the ACP `Agent` method surface.

`inject: ['agents', 'sessions', 'sessionPersistence']` — programs against the interface packages only (never `dsh-agent-loop`). `sessionPersistence` is required because `initialize` advertises `loadSession: true`.

### Config

| Key | Default | Meaning |
|---|---|---|
| `model` | — | Model name for created agents (must have a registered adapter). |
| `systemPrompt` | — | Per-agent system prompt. |
| `agentName` | `deepseek-harness-acp` | Server name reported in `initialize`. |
| `agentVersion` | `0.0.1` | Server version reported in `initialize`. |

## ACP method mapping

| ACP method | Harness seam | Notes |
|---|---|---|
| `initialize` | static | negotiate `protocolVersion`; advertise text-only `promptCapabilities` and `loadSession: true` |
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | single-session MVP (a 2nd is rejected — RFC 011 lifts this); `cwd` must be absolute AND equal the server launch dir; `additionalDirectories` rejected; `mcpServers` ignored |
| `session/load` | `ctx.agents.resume(...)` | replays the persisted event log to the client as `session/update` — the USER side (`user/message` → `user_message_chunk`), assistant text/reasoning (`assistant/chunk`), and tool calls/results (`tool/call` + `tool/result`). The single-session slot is reserved (`loading`) BEFORE the async resume so a pipelined `load`/`new` can't leak a second agent; the PERSISTED header `cwd` is validated via a metadata-only `list()` BEFORE resume (not just the requested `cwd`), so a mismatch rejects without ever constructing an agent. After the async resume a `closed` re-check refuses to install a record if the bridge tore down mid-load |
| `session/prompt` | `agent.send()` | text-only; rejects image/audio and empty prompts; one in-flight prompt; settles on the OWNING turn's end (a turn that ends in `error` rejects the RPC) |
| `session/cancel` | `agent.abort()` | aborts a running step + settles the prompt `cancelled` (see limitation below) |
| `session/update` | `session/event` | `agent_message_chunk` (text-delta), `agent_thought_chunk` (reasoning-delta), `user_message_chunk` (load replay), `tool_call`/`tool_call_update` |

## Settle-exactly-once

A `session/prompt` resolves (or rejects) exactly once, keyed off the canonical session log (the `session/event` stream), NOT the `agent/turn-start`/`agent/turn-end` events. One listener captures the prompt's owning turn from the log's `turn/start` and settles on the matching `turn/end` — the one signal that always fires (`closeTurn` appends it unconditionally, even when a boundary emit throws and the `agent/turn-end` EVENT is skipped). A prompt settles only on ITS OWN turn (`inflight.turn === turn/end.turn`), so a stale `turn/end` for a previously-cancelled turn whose end arrives late can never settle the wrong prompt. A turn that ends `error` REJECTS the RPC with an internal error carrying the failure message (ACP has no error stop reason); every other reason resolves via the codec. As a fallback, when the agent settles to `idle`/`disposed` with a prompt still pending — e.g. a `session/event` listener registered before the bridge threw and starved the bridge's listener — an `agent/status` handler reconciles the prompt from the log (the owning turn's `turn/end`, or `cancelled` if the turn was torn down without one). An empty/whitespace prompt is rejected up front — it would queue no work, so no turn would start and the RPC would hang.

## Disposal & disconnect

Teardown reaches quiescence: settle any pending prompt as `cancelled`, `agent.abort()`, then `await agent.whenIdle()` — the interface-level quiescence signal (NOT `agent/status('disposed')`, which fires before the driver exits). The same teardown runs on a **client disconnect** (`conn.closed` resolves when the editor quits / the transport EOFs), so a vanished client never leaves an orphaned running agent whose `session/update` writes are silently swallowed. The two paths are idempotent (each clears the record first).

## Known limitations (tracked TODOs)

- **`TODO(rfc010-permission-gate)`** — the `tools/execute` permission gate (`session/request_permission`) is NOT implemented in this PR; tools run with the executor's full authority. The ownership `WeakMap<Agent, sessionId>` seam is laid down so the gate (and RFC 011 per-session permission ownership) can build on it. RFC 010 stays `proposed` until the gate lands.
- **`TODO(rfc010-cancel-prestep)`** — `session/cancel` (and teardown/disconnect) is honest RPC/UI cancellation plus best-effort abort: a *running* step is aborted, but a turn that is queued-but-not-yet-started (the gap before `agent.abort()` has an `AbortController` to signal) may still run to completion. This same window means disposal/disconnect can return while one short queued turn still runs, and a prompt accepted right after a pre-step cancel can be batched into the cancelled turn (the loop merges queued messages into one turn). A loop-level queue-aware cancel will close this; the single-in-flight-prompt rule bounds the worst case to one extra prompt.
- **`TODO(rfc010-agent-disposal)`** — the factory (`ctx.agents.create`/`resume`) returns no per-agent disposer, so teardown aborts+drains the agent but cannot individually unregister it; on a bare client disconnect (no host dispose) the idled agent lingers in `ctx.agents` until the host context disposes. Single-session-per-connection makes this benign today (a reconnect spins up a fresh context); RFC 011 adds the per-session disposal seam.
- **`cwd`** — only the server's launch directory is honored; a `session/new.cwd` (or a persisted `session/load` header cwd) that differs is rejected (RFC 010 § Deferred — no path from session cwd to the bash workdir yet).

## stdout is the protocol

The JSON-RPC frames go on stdout, so this plugin MUST run in an example that loads **no stdout logger** (the console logger writes to stdout and would corrupt the frames). The guarantee is config-only — see `examples/acp-agent` (no console logger) and RFC 010 § Risks. A stderr exporter is fine for logging.

## Running

`pnpm run demo:acp` boots `examples/acp-agent` (needs `DEEPSEEK_API_KEY`). Point an ACP client at it; for Zed, add to `agent_servers`:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "pnpm",
      "args": ["run", "demo:acp"]
    }
  }
}
```
