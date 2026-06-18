# @deepseek-ai/dsh-acp

The **Agent Client Protocol (ACP)** bridge: exposes the DeepSeek Harness coding agent as an ACP server over JSON-RPC stdio, so editors (Zed and other ACP clients) can drive it — streaming render, tool-call display, and resumable sessions. **N concurrent sessions per connection** (RFC 011): each maps to its own `LoopAgent`, and every event is demuxed strictly by session id so two sessions streaming at once never interleave.

It is a **client-driver / UI plugin**, the structured analogue of the readline `stdio-chat` plugin — NOT a loop change and NOT a [capability seam](../../docs/rfc/implemented/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

## Service / plugin

`apply(ctx, config)` — wires an `AgentSideConnection` (from `@agentclientprotocol/sdk`) to `process.stdin`/`process.stdout` and implements the ACP `Agent` method surface.

`inject: ['agents', 'sessions', 'sessionPersistence', 'tools']` — programs against the interface packages only (never `dsh-agent-loop`). `sessionPersistence` is required because `initialize` advertises `loadSession: true`; `tools` lets a tool own how its calls render (`presentCall`/`presentResult`) — the bridge looks the definition up by name and falls back to a generic presentation when a tool declares none (see Tool-call presentation).

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
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | creates a new session/agent; N concurrent sessions are allowed (RFC 011), keyed by id; `cwd` must be absolute (it becomes the session's workspace — see Per-session cwd); `additionalDirectories` rejected; `mcpServers` ignored |
| `session/load` | `ctx.agents.resume(...)` | replays the persisted event log to the client as `session/update` — the USER side (`user/message` → `user_message_chunk`), assistant text/reasoning (`assistant/chunk`), and tool calls/results (`tool/call` + `tool/result`). Re-loading an already-live id is rejected; the id's load slot is reserved (`loadingIds`) BEFORE the async resume so a pipelined load of the SAME id can't leak a second agent (distinct ids load concurrently). The resumed session keeps its PERSISTED header `cwd`, so its bash tools run in the original workspace; the requested `cwd` only needs to be absolute. After the async resume a `closed` re-check refuses to install a record if the bridge tore down mid-load |
| `session/prompt` | `agent.send()` | text-only; rejects image/audio and empty prompts; one in-flight prompt PER session (independent); settles on the OWNING turn's end (a turn that ends in `error` rejects the RPC) |
| `session/cancel` | `agent.abort()` | aborts a running step + settles the prompt `cancelled` for ONLY that session — a cancel never touches another session's stream or prompt (see limitation below) |
| `session/update` | `session/event` | `agent_message_chunk` (text-delta), `agent_thought_chunk` (reasoning-delta), `user_message_chunk` (load replay), `tool_call`/`tool_call_update` (title/kind/rawInput/content owned by the TOOL via `presentCall`/`presentResult` — see Tool-call presentation) |

## Multi-session (RFC 011)

The bridge multiplexes N sessions over one connection. Live sessions are held in a `Map<sessionId, SessionRecord>` (forward) with a `WeakMap<Agent, sessionId>` reverse map so `agent/*` events — which carry only the `Agent` — demux in O(1). Every `session/event` and `agent/status` is routed strictly to its owning record, so concurrent sessions never cross-settle or interleave their `session/update` notifications. State is per session: one in-flight prompt each, `session/cancel` aborts and settles only its own agent/prompt, and disposal drains every live session in parallel to quiescence. (Per-session *permission* ownership is reserved for the deferred permission gate — `TODO(rfc010-permission-gate)`.)

Background-task isolation rides on `dsh-tool-bash`: bash task ids are global and predictable, so the tool layer records each background task's owning agent and `bash_output`/`bash_kill` reject a task owned by a different agent — one session's agent can't read or kill another's task.

## Per-session cwd

Each session runs in its own workspace, recorded as the session's `SessionHeader.cwd`. On `session/new` the (absolute) request `cwd` becomes that header cwd; on `session/load` the resumed session keeps its PERSISTED header cwd (the request `cwd` is only shape-checked — it does not override the stored one), and a load whose persisted session has no absolute cwd is REJECTED up front via a metadata-only `list()` check, BEFORE resume constructs an agent (else bash would silently fall back to the server's launch dir, and a post-resume reject would leak the registered agent). `dsh-tool-bash` then defaults the bash workdir to the calling agent's `session.header.cwd` (an explicit model `workdir` still wins; a relative one resolves against the session cwd; with no session cwd the executor falls back to its own config / `process.cwd()`). So the server no longer has to be launched in the workspace — an editor can open any project folder, and N sessions over one connection can each target a different directory. (`additionalDirectories` is still rejected: widening the tool/filesystem scope beyond the single cwd is a separate sandbox concern.)

## Tool-call presentation

How a tool call renders in the editor is owned by the TOOL, not the bridge — the bridge never special-cases tool names. Each tool may declare `presentCall(args)` (pending state: a human-readable `title`, a `kind` for the icon, and the salient `rawInput` to show in a detail view) and `presentResult(args, result)` (completed state: an optional replacement `title` and reformatted `content`) on its `dsh-tools` definition. The bridge looks the definition up by name in `ctx.tools` and maps the neutral `ToolCallPresentation`/`ToolResultPresentation` to the ACP `tool_call`/`tool_call_update` wire shapes. A tool that declares neither gets a generic fallback (title = tool name, raw parsed args as `rawInput`, kind inferred from the name). For example `dsh-tool-bash` sets the title to the model `description` + the exact `command` ("List files in src — ls -la src"), `kind: 'execute'`, the `command` as `rawInput`, and wraps the completed output in a fenced ` ```console ` block. (The command goes in the title because an editor hides `rawInput` for execute-kind cards — Zed renders it only for non-terminal tools.)

The `tool/result` session event carries only `{ callId, content, isError }` — not the tool name or args — so to call a tool's `presentResult` the bridge keeps a small per-session map from `callId` to the in-flight call's `(name, args)`, populated on `tool/call` and removed as each result is presented (it holds only currently-in-flight calls, never finished ones). This is bridge-local state — NOT a change to the event schema or a core service. The map lives on the `SessionRecord`, so two concurrent sessions never cross their in-flight tool state; a `session/load` replay uses a throwaway presenter that pairs each `tool/call` with its `tool/result` as the log replays in order, so replayed tool cards render identically to live ones.

A richer rendering — the ACP **terminal** content type (a live cwd-header terminal card with streaming output) and command classification (a `cat` shown as a `read`, a `grep` as a `search`) — is a capability-gated follow-up; the ` ```console ` text block here is the guaranteed baseline for clients without the terminal capability. See [the terminal-rendering RFC](../../docs/rfc/proposed/2026-06-18-acp-terminal-and-tool-rendering.md).

## Settle-exactly-once

A `session/prompt` resolves (or rejects) exactly once, keyed off the canonical session log (the `session/event` stream), NOT the `agent/turn-start`/`agent/turn-end` events. One listener captures the prompt's owning turn from the log's `turn/start` and settles on the matching `turn/end` — the one signal that always fires (`closeTurn` appends it unconditionally, even when a boundary emit throws and the `agent/turn-end` EVENT is skipped). A prompt settles only on ITS OWN turn (`inflight.turn === turn/end.turn`), so a stale `turn/end` for a previously-cancelled turn whose end arrives late can never settle the wrong prompt. A turn that ends `error` REJECTS the RPC with an internal error carrying the failure message (ACP has no error stop reason); every other reason resolves via the codec. As a fallback, when the agent settles to `idle`/`disposed` with a prompt still pending — e.g. a `session/event` listener registered before the bridge threw and starved the bridge's listener — an `agent/status` handler reconciles the prompt from the log (the owning turn's `turn/end`, or `cancelled` if the turn was torn down without one). An empty/whitespace prompt is rejected up front — it would queue no work, so no turn would start and the RPC would hang.

## Disposal & disconnect

Teardown reaches quiescence: for EVERY live session settle any pending prompt as `cancelled`, `agent.abort()`, then `await agent.whenIdle()` — the interface-level quiescence signal (NOT `agent/status('disposed')`, which fires before the driver exits). The agents drain in parallel. The same teardown runs on a **client disconnect** (`conn.closed` resolves when the editor quits / the transport EOFs), so a vanished client never leaves an orphaned running agent whose `session/update` writes are silently swallowed. The two paths are idempotent and memoized (the first clears the `sessions` map; a second caller awaits the same teardown promise).

## Known limitations (tracked TODOs)

- **`TODO(rfc010-permission-gate)`** — the `tools/execute` permission gate (`session/request_permission`) is NOT implemented; tools run with the executor's full authority. The `agent→sessionId` reverse map is in place so the gate can route a permission request (which receives only `exec.agent`) back to its originating session. RFC 010/011 stay `proposed` until the gate (and per-session permission ownership) land.
- **`TODO(rfc010-cancel-prestep)`** — `session/cancel` (and teardown/disconnect) is honest RPC/UI cancellation plus best-effort abort: a *running* step is aborted, but a turn that is queued-but-not-yet-started (the gap before `agent.abort()` has an `AbortController` to signal) may still run to completion. This same window means disposal/disconnect can return while one short queued turn per session still runs, and a prompt accepted right after a pre-step cancel can be batched into the cancelled turn (the loop merges queued messages into one turn). A loop-level queue-aware cancel will close this; the single-in-flight-per-session rule bounds the worst case to one extra prompt per session.
- **`TODO(rfc010-agent-disposal)`** — the factory (`ctx.agents.create`/`resume`) returns no per-agent disposer, so teardown aborts+drains each agent but cannot individually unregister it; on a bare client disconnect (no host dispose) the idled agents linger in `ctx.agents` until the host context disposes. A reconnect spins up a fresh context, so this strands no work; a per-agent disposal seam is the follow-up.
- **`additionalDirectories`** — rejected. A session operates in its single `cwd` (see Per-session cwd); widening the tool/filesystem scope to extra roots is a separate sandbox concern, not yet implemented.

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
