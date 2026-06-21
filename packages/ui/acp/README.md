# @deepseek-ai/dsh-acp

The **Agent Client Protocol (ACP)** bridge: exposes the DeepSeek Harness coding agent as an ACP server over JSON-RPC stdio, so editors (Zed and other ACP clients) can drive it — streaming render, tool-call display, and resumable sessions. Zed is the current target client: baseline ACP behavior should remain reasonable for other clients, but bridge capabilities and compatibility decisions are evaluated against Zed first. **N concurrent sessions per connection** (see [ACP multi-session](../../../docs/rfc/proposed/feature/2026-06-14-acp-multi-session.md)): each maps to its own `ReactLoopAgent`, and every event is demuxed strictly by session id so two sessions streaming at once never interleave.

It is a **client-driver / UI plugin**, the structured analogue of the readline `stdio-chat` plugin — NOT a loop change and NOT a [capability seam](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

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
| `initialize` | static | negotiate `protocolVersion`; advertise baseline prompt capabilities (`text`, plus `resource_link` rendered as text) and `loadSession: true` |
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | creates a new session/agent; N concurrent sessions are allowed, keyed by id; `cwd` must be absolute (it becomes the session's workspace — see Per-session cwd); non-empty `additionalDirectories` and `mcpServers` rejected |
| `session/load` | `ctx.agents.resume(...)` | replays the persisted event log to the client as `session/update` — the USER side (`user/message` → `user_message_chunk`), assistant text/reasoning (`assistant/chunk`), and tool calls/results (`tool/call` + `tool/result`). Re-loading an already-live id is rejected; the id's load slot is reserved (`loadingIds`) BEFORE the async resume so a pipelined load of the SAME id can't leak a second agent (distinct ids load concurrently). The resumed session keeps its PERSISTED header `cwd`, so its bash tools run in the original workspace; the requested `cwd` must be absolute and match the persisted `cwd`. After the async resume a `closed` re-check refuses to install a record if the bridge tore down mid-load |
| `session/prompt` | `agent.send()` | supports ACP `text` and `resource_link` blocks; rejects image/audio/embedded resource and empty prompts; one in-flight prompt PER session (independent); settles on the OWNING turn's end (a turn that ends in `error` rejects the RPC) |
| `session/cancel` | `agent.cancel()` | the queue-aware cancel: aborts a running step, clears queued + steering work, and drops a turn about to start, then settles the prompt `cancelled` — for ONLY that session (a cancel never touches another session's stream or prompt) |
| `session/update` | `session/event` | `agent_message_chunk` (text-delta), `agent_thought_chunk` (reasoning-delta), `user_message_chunk` (load replay), `tool_call`/`tool_call_update` (title/kind/rawInput/content owned by the TOOL via `presentCall`/`presentResult` — see Tool-call presentation) |

## Multi-session

The bridge multiplexes N sessions over one connection. Live sessions are held in a `Map<sessionId, SessionRecord>` (forward) with a `WeakMap<Agent, sessionId>` reverse map so `agent/*` events — which carry only the `Agent` — demux in O(1). Every `session/event` and `agent/status` is routed strictly to its owning record, so concurrent sessions never cross-settle or interleave their `session/update` notifications. State is per session: one in-flight prompt each, `session/cancel` aborts and settles only its own agent/prompt, and disposal drains every live session in parallel to quiescence. (Per-session *permission* ownership is reserved for the deferred permission gate — `TODO(rfc010-permission-gate)`.)

Background-task isolation rides on `dsh-tool-bash`: bash task ids are global and predictable, so each task carries an opaque owner token — the owning agent's `session.header.id` — stored on the task inside the executor (`dsh-bash`'s `ownerOf(id)` seam). `bash_output`/`bash_kill` reject a task whose token differs from the caller's session token, so one session's agent can't read or kill another's task. Ownership is by session TOKEN, not `Agent` object identity — a different `Agent` object on the same session may access the task — and because the token lives on the executor's task it survives a `tool-bash` HMR reload.

## Per-session cwd

Each session runs in its own workspace, recorded as the session's `SessionHeader.cwd`. On `session/new` the (absolute) request `cwd` becomes that header cwd; on `session/load` the resumed session keeps its PERSISTED header cwd and the request `cwd` must be absolute and equal to it, so the editor and bash executor agree on the workspace before an agent is constructed. A load whose persisted session has no absolute cwd is REJECTED up front via a metadata-only `list()` check, BEFORE resume constructs an agent (else bash would silently fall back to the server's launch dir, and a post-resume reject would leak the registered agent). `dsh-tool-bash` then defaults the bash workdir to the calling agent's `session.header.cwd` (an explicit model `workdir` still wins; a relative one resolves against the session cwd; with no session cwd the executor falls back to its own config / `process.cwd()`). So the server no longer has to be launched in the workspace — an editor can open any project folder, and N sessions over one connection can each target a different directory. (`additionalDirectories` is still rejected: widening the tool/filesystem scope beyond the single cwd is a separate sandbox concern.)

## Tool-call presentation

How a tool call renders in the editor is owned by the TOOL, not the bridge — the bridge never special-cases tool names. Each tool may declare `presentCall(args)` (pending state: a human-readable `title`, a `kind` for the icon, the salient `rawInput` to show in a detail view, and optional `content` blocks shown alongside) and `presentResult(args, result)` (completed state: an optional replacement `title` and reformatted `content`) on its `dsh-tools` definition. The bridge looks the definition up by name in `ctx.tools` and maps the neutral `ToolCallPresentation`/`ToolResultPresentation` to the ACP `tool_call`/`tool_call_update` wire shapes. A tool that declares neither gets a generic fallback (title = tool name, raw parsed args as `rawInput`, kind inferred from the name). For example `dsh-tool-bash` sets the title to the exact `command` ("ls -la src"), `kind: 'execute'`, the `command` as `rawInput`, the model `description` as a `content` text block, and wraps the completed output in a fenced ` ```console ` block. (The command is the title because an editor hides `rawInput` for execute-kind cards — Zed renders it only for non-terminal tools — and the reference adapters likewise use the command as an execute tool's title.)

The `tool/result` session event carries only `{ callId, content, isError }` — not the tool name or args — so to call a tool's `presentResult` the bridge keeps a small per-session map from `callId` to the in-flight call's `(name, args)`, populated on `tool/call` and removed as each result is presented (it holds only currently-in-flight calls, never finished ones). This is bridge-local state — NOT a change to the event schema or a core service. The map lives on the `SessionRecord`, so two concurrent sessions never cross their in-flight tool state; a `session/load` replay uses a throwaway presenter that pairs each `tool/call` with its `tool/result` as the log replays in order, so replayed tool cards render identically to live ones.

## Terminal card (capability-gated)

A tool whose call IS a shell command (`bash`) can render as a real **terminal card** — a working-directory header with the command's output and an exit-status pill — rather than a plain text block. The tool asks for this with the neutral `terminal` field on its presentation (`dsh-tools`: a `{ cwd?, output?, exitCode?, signal? }` shape on `ToolCallPresentation`/`ToolResultPresentation`); the bridge maps it to the Zed `_meta` convention, gated on the client advertising `clientCapabilities._meta.terminal_output` in `initialize`:

- `tool_call`: `content:[…, {type:'terminal', terminalId}]` + `_meta.terminal_info.{terminal_id, cwd}` — the terminal id is the harness `callId`; the cwd is the tool's explicit absolute `terminal.cwd`, else a relative `terminal.cwd` resolved against the session cwd, else the session's workspace cwd (the bridge fills the default, since the pure tool presenter can't see it). Any pending `content` the tool supplied (e.g. bash's `description`) renders BEFORE the terminal block, so the description sits above the card.
- `tool_call_update`: `_meta.terminal_output.{terminal_id, data}` (the captured output) plus `_meta.terminal_exit.{terminal_id, exit_code | signal}` when the tool reported a structured exit. In terminal mode the update's `content` is OMITTED — an ACP `tool_call_update.content` REPLACES the call's content, so sending the fenced text block would clobber the terminal content block from the call.

When the client does NOT advertise the capability, none of the `_meta`/terminal content is emitted: the `tool_call` shows the `description` content block and the `tool_call_update` carries the ` ```console ` text block (above) as the rendering — so a non-Zed client is never worse off. The `_meta` object is ACP's spec-blessed extensibility point; the specific `terminal_info`/`terminal_output`/`terminal_exit` keys are a Zed convention, not the ACP `terminal/create` sub-protocol (which would make the editor execute the command, bypassing `dsh-bash`'s sandbox/env-scrub/ownership/cwd). Live incremental streaming and command classification are follow-ups. See [the terminal-rendering RFC](../../../docs/rfc/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md).

## Settle-exactly-once

A `session/prompt` resolves (or rejects) exactly once, keyed off the canonical session log (the `session/event` stream), NOT the `agent/turn-start`/`agent/turn-end` events. One listener captures the prompt's owning turn from the log's `turn/start` and settles on the matching `turn/end` — the one signal that always fires (`closeTurn` appends it unconditionally, even when a boundary emit throws and the `agent/turn-end` EVENT is skipped). A prompt settles only on ITS OWN turn (`inflight.turn === turn/end.turn`), so a stale `turn/end` for a previously-cancelled turn whose end arrives late can never settle the wrong prompt. A turn that ends `error` REJECTS the RPC with an internal error carrying the failure message (ACP has no error stop reason); every other reason resolves via the codec. As a fallback, when the agent settles to `idle`/`disposed` with a prompt still pending — e.g. a `session/event` listener registered before the bridge threw and starved the bridge's listener — an `agent/status` handler reconciles the prompt from the log (the owning turn's `turn/end`, or `cancelled` if the turn was torn down without one). An empty/whitespace prompt is rejected up front — it would queue no work, so no turn would start and the RPC would hang.

## Disposal & disconnect

Teardown reaches quiescence: for EVERY live session settle any pending prompt as `cancelled`, then run that session's [`AgentHandle`](../../core/agent/README.md) `dispose()` — which stops the loop (sets `disposed` + aborts the in-flight step), `await`s the loop's exit (the final `turn/end` + `session/flush` are captured while the session is still attached), unregisters the agent, and removes its session from the store. A turn cut off mid-flight by teardown ends with reason `disposed` (not `aborted` — `dispose()` uses the disposed path, not `session/cancel`'s queue-aware `cancel()`). The per-session disposes run in parallel. The same teardown runs on a **client disconnect** (`conn.closed` resolves when the editor quits / the transport EOFs), so a vanished client never leaves an orphaned running — or idled-but-still-registered — agent whose `session/update` writes are silently swallowed. The two paths are idempotent and memoized (the first clears the `sessions` map; a second caller awaits the same teardown promise).

## Known limitations (tracked TODOs)

- **`TODO(rfc010-permission-gate)`** — the `tools/execute` permission gate (`session/request_permission`) is NOT implemented; tools run with the executor's full authority. The `agent→sessionId` reverse map is in place so the gate can route a permission request (which receives only `exec.agent`) back to its originating session. [ACP support](../../../docs/rfc/proposed/feature/2026-06-14-acp-agent-client-protocol.md) and [ACP multi-session](../../../docs/rfc/proposed/feature/2026-06-14-acp-multi-session.md) stay `proposed` until the gate (and per-session permission ownership) land.
- **`additionalDirectories`** — rejected. A session operates in its single `cwd` (see Per-session cwd); widening the tool/filesystem scope to extra roots is a separate sandbox concern, not yet implemented.

## stdout is the protocol

The JSON-RPC frames go on stdout, so this plugin MUST run in an example that loads **no stdout logger** (the console logger writes to stdout and would corrupt the frames). The guarantee is config-only — see `examples/acp-agent` (no console logger) and [ACP support risks](../../../docs/rfc/proposed/feature/2026-06-14-acp-agent-client-protocol.md#risks). A stderr exporter is fine for logging.

## Running

`pnpm --dir /path/to/deepseek-harness run demo:acp` boots `examples/acp-agent` (needs `DEEPSEEK_API_KEY`). Point an ACP client at it; for Zed, add to `agent_servers`:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/deepseek-harness", "run", "demo:acp"]
    }
  }
}
```
