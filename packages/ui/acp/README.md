# @deepseek-ai/dsh-acp

Agent Client Protocol bridge over JSON-RPC stdio. Editors can create or resume agents, stream their events, answer questions and approvals, and render tool calls. One connection supports multiple isolated sessions; Zed is the primary compatibility target.

It is a **client-driver / UI plugin**, the structured analogue of the readline `stdio-chat` plugin — NOT a loop change and NOT a [capability seam](../../../docs/rfc/implemented/architecture/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

## Service / plugin

`apply(ctx, config)` — wires an `AgentSideConnection` (from `@agentclientprotocol/sdk`) to `process.stdin`/`process.stdout` and implements the ACP `Agent` method surface.

The plugin injects `agents`, `sessions`, `sessionPersistence`, `tools`, and `userInteraction`, never the concrete loop. Persistence backs `session/load`; tool definitions own presentation; user interaction maps agent questions to ACP forms.

### Config

| Key | Default | Meaning |
|---|---|---|
| `model` | — | Model name for created agents (must have a registered adapter). |

(No persona key: `dsh-system-prompt`'s own `persona` config supplies the global default section, so ACP-created agents render it without the bridge carrying prompt text. An agent-scoped same-name section may still shadow that default.)

The `initialize` handshake reports a fixed server identity (`agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }`) — branding is a literal at the `initialize` site, not config.

## ACP method mapping

| ACP method | Harness seam | Notes |
|---|---|---|
| `initialize` | static | negotiate `protocolVersion`; advertise baseline prompt capabilities (`text`, plus `resource_link` rendered as text) and `loadSession: true` |
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | creates a new session/agent; N concurrent sessions are allowed, keyed by id; `cwd` must be absolute (it becomes the session's workspace — see Per-session cwd); non-empty `additionalDirectories` and `mcpServers` rejected |
| `session/load` | `ctx.agents.resume(...)` | reserves the id, verifies the persisted cwd, resumes, and replays user, assistant, and tool events |
| `session/prompt` | `agent.send()` | supports ACP `text` and `resource_link` blocks; rejects image/audio/embedded resource and empty prompts; one in-flight prompt PER session (independent); settles on the OWNING turn's end (a turn that ends in `error` rejects the RPC) |
| `session/cancel` | `agent.cancel()` | the queue-aware cancel: aborts a running step, clears queued + steering work, and drops a turn about to start, then settles the prompt `cancelled` — for ONLY that session (a cancel never touches another session's stream or prompt) |
| `session/update` | `session/event` | streams user replay, assistant text/reasoning, and tool render intents |
| `elicitation/create` | `ctx.userInteraction.ask()` | maps `ask_user_question` questions to ACP form elicitations; option descriptions are shown in enum titles, `multi_select` uses ACP array enums, optionless requests use a required `custom` field, and a non-empty custom answer overrides any selected choice |
| `session/request_permission` | `approval/request` listener | answers one-shot allow/reject requests for bridge-owned calls; foreign or call-less requests delegate and fail closed if unanswered — see "Permission prompts" |
| `session/set_config_option` | `ctx.permission.set()` | per-session permission-preset switching over [session config options](https://agentclientprotocol.com/protocol/session-config-options) — see "Session config options" |

## Multi-session

Forward and reverse indexes route every event, prompt, cancel, and approval to one session. Each session permits one in-flight prompt; teardown drains all sessions in parallel. See the [multi-session RFC](../../../docs/rfc/implemented/feature/2026-06-14-acp-multi-session.md).

## Session config options

When `ctx.permission` is composed, the bridge advertises one `permission` select in `session/new` and `session/load`. Options come from the deployment's preset table; the current value comes from the session fold, with switch-away-only `custom` for unmatched knobs. `session/set_config_option` accepts advertised presets and writes both sandbox-mode and approval-policy events through `PermissionService.set()`. Open-turn switches append immediately; idle switches overlay responses and anchor at the next `agent/prompt-submit`, before request assembly. A crash before anchoring restores the durable fold. See the [sandbox RFC](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md), [`dsh-permission`](../permission/README.md), and [protocol matrix](acp-feature-support.md#6-session-config-options).

Background bash tasks use the session id as an opaque owner token, so one session cannot inspect or stop another's task. That contract belongs to [`dsh-tool-bash`](../../bash/tool-bash/).

## Per-session cwd

`session/new` records the request's absolute cwd in the session header. Before constructing an agent, `session/load` uses persisted metadata to require an absolute request cwd that matches the stored one. Bash defaults to that workspace; an explicit relative workdir resolves against it, and multiple sessions may use different workspaces. `additionalDirectories` remains unsupported.

## Tool-call presentation

Tools return provider-neutral `generic`, `terminal`, or `diff` render intents from `presentCall()` and `presentResult()`. The bridge maps the discriminator to ACP without special-casing tool names and falls back to a generic card. Per-session call-id state supplies result events with their omitted name and arguments during live streaming and replay. See [`dsh-tools`](../../core/tools/README.md#tool-owned-ui-presentation).

## Terminal card (capability-gated)

When the client advertises `_meta.terminal_output`, terminal intents map to Zed's terminal info, output, and exit metadata. The bridge resolves relative cwd against the session, places the description before the terminal block, and omits result content because ACP updates replace call content. Other clients receive a generic card and bridge-derived fenced console fallback. Session creation snapshots the capability so call and result agree. The command still executes through the harness, not ACP terminal creation. See the [terminal-rendering RFC](../../../docs/rfc/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md) and [render-intent RFC](../../../docs/rfc/implemented/architecture/2026-07-02-tool-render-intent-union.md).

## Settle-exactly-once

A prompt captures its owning turn and settles exactly once from the matching durable `turn/end`, even if presentation failed. Turn correlation excludes stale endings. Error turns reject with an ACP internal error; empty prompts reject before enqueue.

## Permission prompts

For a bridge-owned call, the [approval seam](../user-approval/README.md) maps `ask` to an editor prompt with one-shot allow/reject options. Foreign or call-less requests delegate; unknown choices never grant, cancellation stays cancellation, and transport failure becomes fail-closed unavailability. Whether a tool asks remains policy outside the bridge.

## Disposal & disconnect

Disposal and client disconnect share one memoized teardown. It cancels pending prompts and disposes all owned agent handles in parallel, waiting for loop exit and final flush before registry removal. Mid-turn teardown records `disposed`; `session/cancel` records `aborted`.

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

## Model Experience

### User messages

**What the model sees**: Each ACP `session/prompt` becomes an agent user message: text passes through verbatim and each `resource_link` becomes exactly a leading newline, `[resource_link name=<JSON-string> uri=<JSON-string>]`, and a trailing newline. Unsupported image, audio, and embedded-resource blocks are rejected rather than silently omitted.

**Token effect**: Prompt tokens are data-dependent and remain in that session's history until compaction. Concurrent ACP sessions keep separate contexts.

### Human answers and permission decisions

**What the model sees**: When optional consumers are loaded, ACP form answers become the exact JSON shape documented by `dsh-tool-ask-user`. Failures become `Error: ACP user questions must come from an agent-owned request`, `Error: ACP user question has no matching session`, `Error: ACP elicitation request failed`, `Error: ask_user_question was cancelled by the user`, `Error: ask_user_question returned no answer`, or `Error: ask_user_question was aborted before the user answered`. Permission decisions control whether another tool yields success or denial. ACP tool cards, terminal output, diffs, and streamed session updates are UI-only.

**Token effect**: Answer, error, and denial text enters context only through the owning tool result; presentation metadata adds zero model tokens.

### Permission preset switches

**What the model sees**: `session/set_config_option` emits no model message itself. When `dsh-permission` is composed, the bridge writes the selected preset through that service; the resulting model-visible policy prompt and change notice belong to [`dsh-user-approval`](../user-approval/README.md), while sandbox-mode effects belong to [`dsh-tool-bash`](../../bash/tool-bash/README.md). The ACP `Permissions` select, its option descriptions, pending idle value, and refreshed config response remain client-only.

**Token effect**: Zero direct tokens from the ACP option or the log-only `permission/preset` event. Downstream cost is limited to the owning plugins' policy prompt, conditional retained change notice, and any changed tool outcome.

### Loaded sessions

**What the model sees**: `session/load` resumes the persisted log, after which the loop sends its reconstructed history and request header. Replaying that log to the editor is not an extra model message.

**Token effect**: Restored context has the persistence and session packages' normal retained cost; ACP replay to the client adds none.

## Known Limitations and Deferred Work

- **`additionalDirectories`** — rejected. A session operates in its single `cwd` (see Per-session cwd); widening the tool/filesystem scope to extra roots is a separate sandbox concern, not yet implemented.
- **Prompt content is `text` + `resource_link` only** — image, audio, and embedded-resource blocks are rejected, as is a non-empty `mcpServers` list at `session/new`.
- **One configured `model` for every created session** — per-session model selection has no config or protocol surface here yet.
- **Terminal cards render completed output** — live incremental streaming and command classification are named follow-ups of [the terminal-rendering RFC](../../../docs/rfc/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md).
- **Permission answers are one-shot only** — the bridge offers `allow_once` / `reject_once`; durable `allow_always` grants and their storage/revocation policy remain deferred to the approval seam.
