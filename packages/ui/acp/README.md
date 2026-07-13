# @deepseek-ai/dsh-acp

The **Agent Client Protocol (ACP)** bridge: exposes DeepSeek Harness SDK agents as an ACP server over JSON-RPC stdio, so editors (Zed and other ACP clients) can drive them — streaming render, tool-call display, and resumable sessions. Zed is the current target client: baseline ACP behavior should remain reasonable for other clients, but bridge capabilities and compatibility decisions are evaluated against Zed first. **N concurrent sessions per connection** (see [ACP multi-session](../../../docs/rfc/implemented/feature/2026-06-14-acp-multi-session.md)): each maps to its own `ReactLoopAgent`, and every event is demuxed strictly by session id so two sessions streaming at once never interleave.

It is a **client-driver / UI plugin**, the structured analogue of the readline `stdio-chat` plugin — NOT a loop change and NOT a [capability seam](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

## Service / plugin

`apply(ctx, config)` — wires an `AgentSideConnection` (from `@agentclientprotocol/sdk`) to `process.stdin`/`process.stdout` and implements the ACP `Agent` method surface.

`inject: ['agents', 'sessions', 'sessionPersistence', 'tools', 'userInteraction']` — programs against the interface packages only (never `dsh-agent-loop`). `sessionPersistence` is required because `initialize` advertises `loadSession: true`; `tools` lets a tool own how its calls render (`presentCall`/`presentResult`) — the bridge looks the definition up by name and falls back to a generic presentation when a tool declares none (see Tool-call presentation). `userInteraction` lets agent-owned `ask_user_question` calls become ACP form elicitations routed to the owning session.

### Config

| Key | Default | Meaning |
|---|---|---|
| `model` | — | Model name for created agents (must have a registered adapter). |

(No persona key: the deployment persona is `dsh-system-prompt`'s own `persona` config — a context-wide section, so ACP-created agents render it without the bridge carrying prompt text.)

The `initialize` handshake reports a fixed server identity (`agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }`) — branding is a literal at the `initialize` site, not config.

## ACP method mapping

| ACP method | Harness seam | Notes |
|---|---|---|
| `initialize` | static | negotiate `protocolVersion`; advertise baseline prompt capabilities (`text`, plus `resource_link` rendered as text) and `loadSession: true` |
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | creates a new session/agent; N concurrent sessions are allowed, keyed by id; `cwd` must be absolute (it becomes the session's workspace — see Per-session cwd); non-empty `additionalDirectories` and `mcpServers` rejected |
| `session/load` | `ctx.agents.resume(...)` | replays the persisted event log to the client as `session/update` — the USER side (`user/message` → `user_message_chunk`), assistant text/reasoning (`assistant/chunk`), and tool calls/results (`tool/call` + `tool/result`). Re-loading an already-live id is rejected; the id's load slot is reserved (`loadingIds`) BEFORE the async resume so a pipelined load of the SAME id can't leak a second agent (distinct ids load concurrently). The resumed session keeps its PERSISTED header `cwd`, so its bash tools run in the original workspace; the requested `cwd` must be absolute and match the persisted `cwd`. After the async resume a `closed` re-check refuses to install a record if the bridge tore down mid-load |
| `session/prompt` | `agent.send()` | supports ACP `text` and `resource_link` blocks; rejects image/audio/embedded resource and empty prompts; one in-flight prompt PER session (independent); settles on the OWNING turn's end (a turn that ends in `error` rejects the RPC) |
| `session/cancel` | `agent.cancel()` | the queue-aware cancel: aborts a running step, clears queued + steering work, and drops a turn about to start, then settles the prompt `cancelled` — for ONLY that session (a cancel never touches another session's stream or prompt) |
| `session/update` | `session/event` | `agent_message_chunk` (text-delta), `agent_thought_chunk` (reasoning-delta), `user_message_chunk` (load replay), `tool_call`/`tool_call_update` (the render intent — a `card`-tagged `ToolCallView`/`ToolResultView` — owned by the TOOL via `presentCall`/`presentResult`, which the bridge switches on to build the wire shape — see Tool-call presentation) |
| `elicitation/create` | `ctx.userInteraction.ask()` | maps `ask_user_question` questions to ACP form elicitations; option descriptions are shown in enum titles, `multi_select` uses ACP array enums, optionless requests use a required `custom` field, and a non-empty custom answer overrides any selected choice |
| `session/request_permission` | `approval/request` listener | the bridge is the [`ctx.approval`](../user-approval/README.md) answerer for the agents it owns: an `ask` (a hook or `tools/pre-execute` plugin) becomes an editor prompt attached to the streamed tool call, offering one-shot `allow_once`/`reject_once` options only; a foreign or call-less request delegates down the answerer chain (fail-closed `unavailable` default). See "Permission prompts" |
| `session/set_config_option` | `setSandboxMode` / `setApprovalPolicy` | per-session knob switching over [session config options](https://agentclientprotocol.com/protocol/session-config-options) — see "Session config options" |

## Multi-session

The bridge multiplexes N sessions over one connection. Live sessions are held in a `Map<sessionId, SessionRecord>` (forward) with a `WeakMap<Agent, sessionId>` reverse map so `agent/*` events — which carry only the `Agent` — demux in O(1). Every `session/event` and `agent/status` is routed strictly to its owning record, so concurrent sessions never cross-settle or interleave their `session/update` notifications. State is per session: one in-flight prompt each, `session/cancel` aborts and settles only its own agent/prompt, and disposal drains every live session in parallel to quiescence. Permission prompts follow the same ownership: the `approval/request` answerer resolves the owning session through the reverse map and prompts only there.

## Session config options

The bridge advertises one independent `select` per composable knob in the `session/new`/`session/load` responses — `sandbox-mode` (`read-only`/`workspace-write`/`danger-full-access`, category `mode`) iff the mounted executor confines (`ctx.get('bash')?.sandboxMode` defined), `approval-policy` (`ask`/`never`) iff the approval seam is composed — with each session's `currentValue` folded from its OWN log (`effectiveSandboxMode`/`effectiveApprovalPolicy` ?? the composition default), so `session/load` reports a resumed session's overrides with no catch-up machinery. `session/set_config_option` validates the value against the same closed vocabulary, routes to the domain's write path (`setSandboxMode`/`setApprovalPolicy` — ONE log-only event on that session's log), and returns the complete refreshed state per the spec. Anchoring honors turn-enclosure: a switch while a turn is open appends immediately (openness read from the LOG — `agent.status` stays `running` between queued turns); an idle switch is held on the session record and anchored at the next turn's `agent/prompt-submit` (inside the turn, before anything assembles, last write per knob — an idle flip-flop anchors as one event), because appending from inside a `session/event` listener would reorder events for later-registered peers. Until anchored the switch lives in bridge memory only: responses overlay it truthfully, and a crash before the next turn reverts it — `session/load` then reports the fold's truth. Design: [the sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md); protocol matrix: [acp-feature-support.md](acp-feature-support.md) § 6.

Background-task isolation rides on `dsh-tool-bash`: bash task ids are global and predictable, so each task carries an opaque owner token — the owning agent's `session.header.id` — stored on the task inside the executor (`dsh-bash`'s `ownerOf(id)` seam). `bash_output`/`bash_kill` reject a task whose token differs from the caller's session token, so one session's agent can't read or kill another's task. Ownership is by session TOKEN, not `Agent` object identity — a different `Agent` object on the same session may access the task — and because the token lives on the executor's task it survives a `tool-bash` HMR reload.

## Per-session cwd

Each session runs in its own workspace, recorded as the session's `SessionHeader.cwd`. On `session/new` the (absolute) request `cwd` becomes that header cwd; on `session/load` the resumed session keeps its PERSISTED header cwd and the request `cwd` must be absolute and equal to it, so the editor and bash executor agree on the workspace before an agent is constructed. A load whose persisted session has no absolute cwd is REJECTED up front via a metadata-only `list()` check, BEFORE resume constructs an agent (else bash would silently fall back to the server's launch dir, and a post-resume reject would leak the registered agent). `dsh-tool-bash` then defaults the bash workdir to the calling agent's `session.header.cwd` (an explicit model `workdir` still wins; a relative one resolves against the session cwd; with no session cwd the executor falls back to its own config / `process.cwd()`). So the server no longer has to be launched in the workspace — an editor can open any project folder, and N sessions over one connection can each target a different directory. (`additionalDirectories` is still rejected: widening the tool/filesystem scope beyond the single cwd is a separate sandbox concern.)

## Tool-call presentation

How a tool call renders in the editor is owned by the TOOL, not the bridge — the bridge never special-cases tool names. Each tool may declare `presentCall(args)` (pending state) and `presentResult(args, result)` (completed state) on its `dsh-tools` definition, each returning a **`card`-tagged render intent** — a discriminated union the bridge switches on. `presentCall` returns a `ToolCallView`, one of three cards:

- `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` — the default card: a human-readable `title`, a `kind` for the icon, the salient `rawInput` for a detail view, optional `content` blocks shown alongside, and optional `locations` (`FileLocation[]` = `{ path, line? }[]` files the call reads/modifies, forwarded as `tool_call.locations` so an editor can follow along).
- `{ card: 'terminal', title, description?, cwd? }` — a shell command → a terminal card (see Terminal card).
- `{ card: 'diff', title, diffs, locations? }` — a file create/modify → an inline diff card; `diffs` is `FileDiff[]` (`{ path, oldText, newText }`, `oldText: null` ⇒ new file). The bridge emits each diff as an ACP `{ type: 'diff', path, oldText, newText }` `tool_call.content` block, which Zed renders as an inline diff / new-file preview.

`presentResult` returns a `ToolResultView`, one of three cards: `{ card: 'generic', title?, content? }` (an optional replacement `title` and reformatted `content`), `{ card: 'terminal', title?, output?, exitCode?, signal? }` (the captured run output + exit — see Terminal card), or `{ card: 'diff', title?, diffs }` (a completed file mutation → typically the applied hunks with context lines computed from the before/after content, or a whole-file diff for a create; a successful mutation ALWAYS returns this so the model-facing result text can't clobber the diff — an ACP `tool_call_update.content` replaces the call's content). The bridge looks the definition up by name in `ctx.tools` and `switch (view.card)`es to build the ACP `tool_call`/`tool_call_update` wire shape per card; a tool that declares neither gets a generic fallback (title = tool name, raw parsed args as `rawInput`, kind `other` — the bridge never sniffs a kind from the tool name). For example `dsh-tool-bash` returns a `terminal` card for a foreground `bash` (title = the exact `command` "ls -la src", `description` = the model description); the `dsh-tool-fs` `write`/`edit` tools return a `diff` call card and a `diff` result card, and `read` returns a `generic` card (`kind: 'read'`, the read window in its title — `Read foo.txt (5 - 8)` — and a `locations` entry for the file). For a file card the bridge **relativizes the title** against the session cwd (mirroring `claude-agent-acp`'s `toDisplayPath` — `Read src/foo.ts`, not the absolute path) while keeping `locations[]`/`diffs[].path` **raw** so the editor opens the real path.

The `tool/result` session event does not carry the tool name or args — so to call a tool's `presentResult` the bridge keeps a small per-session map from `callId` to the in-flight call's `(name, args)`, populated on `tool/call` and removed as each result is presented (it holds only currently-in-flight calls, never finished ones). This is bridge-local state — NOT a change to the event schema or a core service. The map lives on the `SessionRecord`, so two concurrent sessions never cross their in-flight tool state; a `session/load` replay uses a throwaway presenter that pairs each `tool/call` with its `tool/result` as the log replays in order, so replayed tool cards render identically to live ones.

## Terminal card (capability-gated)

A tool whose call IS a shell command (`bash`) can render as a real **terminal card** — a working-directory header with the command's output and an exit-status pill — rather than a plain text block. The tool asks for this with the `terminal` card variant of its render intent (`dsh-tools`: `{ card: 'terminal', title, description?, cwd? }` from `presentCall`, `{ card: 'terminal', title?, output?, exitCode?, signal? }` from `presentResult`); the bridge maps it to the Zed `_meta` convention, gated on the client advertising `clientCapabilities._meta.terminal_output` in `initialize`:

- `tool_call`: `content:[…, {type:'terminal', terminalId}]` + `_meta.terminal_info.{terminal_id, cwd}` — the terminal id is the harness `callId`; the cwd is the card's explicit absolute `cwd`, else a relative `cwd` resolved against the session cwd, else the session's workspace cwd (the bridge fills the default, since the pure tool presenter can't see it). The card's `description` renders as a content block BEFORE the terminal block, so the description sits above the card.
- `tool_call_update`: `_meta.terminal_output.{terminal_id, data}` (the terminal card's `output`) plus `_meta.terminal_exit.{terminal_id, exit_code | signal}` when the card reported a structured `exitCode`/`signal`. In terminal mode the update's `content` is OMITTED — an ACP `tool_call_update.content` REPLACES the call's content, so sending the fenced text block would clobber the terminal content block from the call.

When the client does NOT advertise the capability, none of the `_meta`/terminal content is emitted: the `tool_call` shows the `description` content block and the `tool_call_update` carries a ` ```console ` text block the bridge DERIVES by fencing the terminal result's `output` (the tool no longer double-encodes the fences) — so a non-Zed client is never worse off. The `_meta` object is ACP's spec-blessed extensibility point; the specific `terminal_info`/`terminal_output`/`terminal_exit` keys are a Zed convention, not the ACP `terminal/create` sub-protocol (which would make the editor execute the command, bypassing `dsh-bash`'s sandbox/env-scrub/ownership/cwd). Live incremental streaming and command classification are follow-ups. See [the terminal-rendering RFC](../../../docs/rfc/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md) and [the render-intent-union RFC](../../../docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md).

## Settle-exactly-once

A `session/prompt` resolves (or rejects) exactly once, keyed off the canonical session log (the `session/event` stream). One listener captures the prompt's owning turn from the log's `turn/start` and settles on the matching `turn/end` — the durable boundary event (`closeTurn` appends it unconditionally; there is no `agent/*` turn mirror). A prompt settles only on ITS OWN turn (`inflight.turn === turn/end.turn`), so a stale `turn/end` for a previously-cancelled turn whose end arrives late can never settle the wrong prompt. A turn that ends `error` REJECTS the RPC with an internal error carrying the failure message (ACP has no error stop reason); every other reason resolves via the codec. As a fallback, when the agent settles to `idle`/`disposed` with a prompt still pending — e.g. a peer `session/event` listener registered before the bridge threw and starved the bridge's listener — an `agent/status` handler reconciles the prompt from the log (the owning turn's `turn/end`, or `cancelled` if the turn was torn down without one). An empty/whitespace prompt is rejected up front — it would queue no work, so no turn would start and the RPC would hang.

## Permission prompts

The bridge registers an `approval/request` waterfall listener — the ACP answerer of the [user-approval seam](../user-approval/README.md). When `ctx.approval` routes an `ask` for an agent the bridge owns, the listener resolves the owning session through the reverse map and issues `session/request_permission` with the request's `callId` as the `toolCall` reference (the editor attaches the prompt to the already-streamed call) and the one-shot options `allow_once`/`reject_once` (`allow_always` is deferred to the approval RFC's grant-storage question). Outcomes map `allow-once → allowed-once`, any other selection → `rejected` (an unknown optionId from a non-conforming client never grants), client `cancelled → cancelled`. A request for an agent the bridge does NOT own — or one without a `callId` to attach to — delegates via `next()` so another answerer or the seam's fail-closed `unavailable` default takes it. A rejected `requestPermission` RPC (client gone mid-prompt) propagates to the ApprovalService, which contains it as `unavailable`. Whether a call asks at all is policy — a hook or `tools/pre-execute` plugin returning `ask` — never the bridge's own judgment; without such policy, tools keep the executor's full authority.

## Disposal & disconnect

Teardown reaches quiescence: for EVERY live session settle any pending prompt as `cancelled`, then run that session's [`AgentHandle`](../../core/agent/README.md) `dispose()` — which stops the loop (sets `disposed` + aborts the in-flight step), `await`s the loop's exit (the final `turn/end` + `session/flush` are captured while the session is still attached), unregisters the agent, and removes its session from the store. A turn cut off mid-flight by teardown ends with reason `disposed` (not `aborted` — `dispose()` uses the disposed path, not `session/cancel`'s queue-aware `cancel()`). The per-session disposes run in parallel. The same teardown runs on a **client disconnect** (`conn.closed` resolves when the editor quits / the transport EOFs), so a vanished client never leaves an orphaned running — or idled-but-still-registered — agent whose `session/update` writes are silently swallowed. The two paths are idempotent and memoized (the first clears the `sessions` map; a second caller awaits the same teardown promise).

## Known limitations (tracked TODOs)

- **`additionalDirectories`** — rejected. A session operates in its single `cwd` (see Per-session cwd); widening the tool/filesystem scope to extra roots is a separate sandbox concern, not yet implemented.

## stdout is the protocol

The JSON-RPC frames go on stdout, so this plugin MUST run in an example that loads **no stdout logger** (the console logger writes to stdout and would corrupt the frames). The guarantee is config-only — see `examples/acp-agent` (no console logger) and [ACP support risks](../../../docs/rfc/implemented/feature/2026-06-14-acp-agent-client-protocol.md#risks). A stderr exporter is fine for logging.

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
