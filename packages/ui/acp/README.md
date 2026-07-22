# @deepseek-ai/dsh-acp

Agent Client Protocol bridge over JSON-RPC stdio. Editors can create or resume agents, stream their events, answer questions and approvals, and render tool calls. One connection supports multiple isolated sessions; Zed is the primary compatibility target.

It is a **client-driver / UI plugin**, the structured analogue of the terminal `dsh-tui` channel — NOT a loop change and NOT a [capability seam](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md). It consumes the existing `agent/*` event taxonomy, the `dsh-agent` create/resume factory, and `dsh-session-persistence`.

## Service / plugin

`apply(ctx, config)` — wires an `AgentSideConnection` (from `@agentclientprotocol/sdk`) to `process.stdin`/`process.stdout` and implements the ACP `Agent` method surface.

The plugin injects `agents`, [`commands`](../commands/README.md), `sessionPersistence`, `sessionQuery`, `tools`, `userInteraction`, `llm`, and `systemPrompt`, never the concrete loop. Persistence backs `session/load`; live-preferred session queries back `session/list`; the command registry backs slash discovery and direct dispatch; the LLM catalog backs model selection; prompt assembly keeps model variables aligned with routing; tool definitions own presentation; user interaction maps agent questions to ACP forms.

### Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | — | Initial provider route for created agents (must have a registered adapter). |
| `model` | — | Initial model id for created agents. |

(No persona key: `dsh-system-prompt`'s own `persona` config supplies the global default section, so ACP-created agents render it without the bridge carrying prompt text. An agent-scoped same-name section may still shadow that default.)

The `initialize` handshake reports a fixed server identity (`agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }`) — branding is a literal at the `initialize` site, not config.

## ACP method mapping

| ACP method | Harness seam | Notes |
|---|---|---|
| `initialize` | static | negotiate `protocolVersion`; advertise baseline prompt capabilities (`text`, plus `resource_link` rendered as text), `loadSession: true`, and `sessionCapabilities.list` |
| `session/new` | `ctx.agents.create({ sessionId, meta:{cwd} })` | creates a new session/agent; N concurrent sessions are allowed, keyed by id; advertises the effective command snapshot; `cwd` must be absolute (it becomes the session's workspace — see Per-session cwd); non-empty `additionalDirectories` and `mcpServers` rejected |
| `session/load` | `ctx.agents.resume(...)` | reserves the id, verifies the persisted cwd, resumes, replays user, assistant, tool, and title events, and re-advertises commands |
| `session/list` | `ctx.sessionQuery` | returns live-preferred newest-first sessions with absolute cwd and optional folded title; supports exact normalized cwd filtering, returns no cursor, and rejects supplied cursors |
| `session/prompt` | `ctx.commands.execute()` or `agent.send()` | a flattened prompt beginning with `/` stays in the direct command plane; ordinary prompts support ACP `text` and `resource_link`; `dsh-session:` links and inline mentions are snapshotted through optional `ctx.sessionReferences` before enqueue; unsupported content, unavailable reference capability, failed snapshots, and empty prompts are rejected; one request is in flight per session and settles on the owning turn's end, with an error turn rejecting the RPC |
| `session/cancel` | command `AbortSignal` or `agent.cancel()` | aborts the exact direct command, or applies the queue-aware agent cancel and settles its prompt `cancelled`; one session never cancels another |
| `session/update` | `session/event` | streams user replay, assistant text/reasoning, retry/failure attempt markers, tool render intents, and `session_info_update` title revisions |
| `elicitation/create` | `ctx.userInteraction.ask()` | maps `ask_user_question` questions to ACP form elicitations; option descriptions are shown in enum titles, `multi_select` uses ACP array enums, optionless requests use a required `custom` field, and a non-empty custom answer overrides any selected choice |
| `session/request_permission` | `approval/request` listener | answers one-shot allow/reject requests for bridge-owned calls; foreign or call-less requests delegate and fail closed if unanswered — see "Permission prompts" |
| `session/set_config_option` | agent-scoped request target / `ctx.permission.set()` | per-session provider+model and permission-preset switching over [session config options](https://agentclientprotocol.com/protocol/session-config-options) — see "Session config options" |

## Multi-session

One id-keyed record map plus exact agent-object checks route every event, prompt, cancel, and approval to one session. Each session permits one in-flight prompt or reference-preparation operation; `session/cancel` aborts preparation before it can enqueue. Teardown drains all sessions in parallel. See the [multi-session Agent Note](../../../.agents/notes/implemented/feature/2026-06-14-acp-multi-session.md).

## Human commands

After `session/new` and `session/load`, the bridge emits ACP's full `available_commands_update` snapshot for that exact agent. A new session's server-generated id is introduced by the RPC response before its snapshot enters the connection write queue. A global or scoped registry change refreshes every live session from its independently resolved view, so clients replace rather than merge cached catalogs. Names omit the slash; descriptions and optional unstructured-input hints map directly to ACP `AvailableCommand`.

ACP v1 permits a command prompt to carry additional content blocks. The bridge applies its ordinary lossless flattening for supported `text` and `resource_link` blocks, then dispatches when the result begins with `/`. Known commands execute without a model request. Unknown or malformed slash input returns a direct error instead of falling back to the model; prefix whitespace when literal slash-leading text must reach the model. Expected handler errors, thrown failures, and successful text stream as UI-only `agent_message_chunk` output and end the request; cancellation returns `cancelled`. See the [command Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.md) and the [ACP v1 slash-command contract](https://agentclientprotocol.com/protocol/v1/slash-commands).

## Session config options

The bridge advertises a `model`-category select in `session/new` and `session/load` when the session has a complete target whose provider is registered. Values encode the complete provider/model pair, are grouped by provider when more than one group is available, and come from `ctx.llm.listProviders()` / `listModels()`. The configured or last-requested model is added when absent because catalogs are advisory and private adapters may accept unlisted ids. A selection changes only that ACP session. Agent-scoped prompt assembly snapshots the selected pair for one step, supplies matching `{{provider}}` / `{{model}}` variables, and the `agent/request` waterfall applies the same pair; a concurrent selection therefore takes effect on the next step instead of splitting prompt text from routing. The resulting request header is the durable record restored by `session/load`; a selection never used by a request remains in-memory only.

When `ctx.permission` is composed, the bridge also advertises a `permission` select. Options come from the deployment's preset table; the current value comes from the session fold, with switch-away-only `custom` for unmatched knobs. `session/set_config_option` accepts advertised presets and writes both sandbox-mode and approval-policy events through `PermissionService.set()`. Open-turn switches append immediately; idle switches overlay responses and anchor at the next `agent/prompt-submit`, before request assembly. A crash before anchoring restores the durable fold. See the [model-catalog Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-llm-model-catalog-and-acp-selection.md), [sandbox Agent Note](../../../.agents/notes/implemented/feature/2026-07-06-sandbox.md), [`dsh-permission`](../permission/README.md), and [protocol matrix](acp-feature-support.md#6-session-modes--config-options--models).

The shared [`ctx.tasks` runtime](../../tasks/tasks/) fences access to predictable task ids by the owning session; ACP sessions therefore cannot read or stop one another's background work.

ACP updates are append-only, so `llm/retry` emits a visible separator that marks preceding partial model output discarded before the next attempt streams. A terminal model-request failure emits the same discarded-output warning; replay derives both markers from the durable events.

A log-only `session/title` event maps to ACP `session_info_update` with `title` and the event timestamp as `updatedAt`. The same mapping runs for live events and `session/load` replay, so an asynchronously generated late title and a restored persisted title have one wire representation without entering model history.

`session/list` returns the same latest folded title in standard `SessionInfo.title`. When `ctx.sessionReferences` is mounted, each listed item also carries `_meta["deepseek-harness/sessionReference"].uri`; a title-aware client can render `title ?? sessionId` in its `@` picker and submit that URI as a `resource_link` with the same display name. Sessions without cwd are omitted because ACP requires an absolute `SessionInfo.cwd` and the bridge cannot load them.

## Per-session cwd

`session/new` records the request's absolute cwd in the session header. Before constructing an agent, `session/load` uses persisted metadata to require an absolute request cwd that matches the stored one. Bash defaults to that workspace; an explicit relative workdir resolves against it, and multiple sessions may use different workspaces. `additionalDirectories` remains unsupported.

## Tool-call presentation

Tools return provider-neutral `generic`, `terminal`, or `diff` render intents from `presentCall()` and `presentResult()`. The bridge maps the discriminator to ACP without special-casing tool names and falls back to a generic card. Per-session call-id state supplies result events with their omitted name and arguments during live streaming and replay. File-card titles are relative to the session cwd and use the host separator, while location and diff paths remain raw so the editor opens the real file. See [`dsh-tools`](../../core/tools/README.md#tool-owned-ui-presentation).

## Terminal card (capability-gated)

When the client advertises `_meta.terminal_output`, terminal intents map to Zed's terminal info, output, and exit metadata. The bridge resolves relative cwd against the session and preserves the host filesystem separator, places the description before the terminal block, and omits result content because ACP updates replace call content. Other clients receive a generic card and bridge-derived fenced console fallback. Session creation snapshots the capability so call and result agree. The command still executes through the harness, not ACP terminal creation. See the [terminal-rendering Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md) and [render-intent Agent Note](../../../.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md).

## Settle-exactly-once

A prompt captures its owning turn and settles exactly once from the matching durable `turn/end`, even if presentation failed. Turn correlation excludes stale endings. Error turns reject with an ACP internal error; empty prompts reject before enqueue.

## Permission prompts

For a bridge-owned call, the [approval seam](../user-approval/README.md) maps `ask` to an editor prompt with one-shot allow/reject options. Foreign or call-less requests delegate; unknown choices never grant, cancellation stays cancellation, and transport failure becomes fail-closed unavailability. Whether a tool asks remains policy outside the bridge.

## Disposal & disconnect

Disposal and client disconnect share one memoized teardown. It cancels pending prompts and disposes all owned agent handles in parallel, waiting for loop exit and final flush before registry removal. Mid-turn teardown records `disposed`; `session/cancel` records `aborted`.

## stdout is the protocol

The JSON-RPC frames go on stdout, so this plugin MUST run in an example that loads **no stdout logger** (the console logger writes to stdout and would corrupt the frames). The guarantee is config-only — see `examples/acp-agent` (no console logger) and [ACP support risks](../../../.agents/notes/implemented/feature/2026-06-14-acp-agent-client-protocol.md#risks). A stderr exporter is fine for logging.

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

#### What the model sees

Each ACP `session/prompt` becomes an agent user message: text passes through verbatim and each ordinary `resource_link` becomes exactly a leading newline, `[resource_link name=<JSON-string> uri=<JSON-string>]`, and a trailing newline. When `ctx.sessionReferences` is mounted, a `resource_link` whose URI uses `dsh-session:` or an inline canonical mention becomes readable `@label` text plus one durable untrusted snapshot context; without the capability it is rejected. Unsupported image, audio, and embedded-resource blocks are rejected rather than silently omitted.

#### Token effect

Prompt tokens are data-dependent and remain in that session's history until compaction. Concurrent ACP sessions keep separate contexts.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Human commands

#### What the model sees

Nothing from command discovery, slash input, or command output. A command handler may separately mutate a durable domain whose later state affects model requests.

#### Token effect

Direct dispatch adds no model tokens and no session message. The mutated domain owns any later prompt or history cost.

#### KV Cache effect

Command discovery, dispatch, and direct output never enter a model request and do not affect its cache. A mutated domain owns any later cache effect.

### Human answers and permission decisions

#### What the model sees

When optional consumers are loaded, ACP form answers become the exact JSON shape documented by `dsh-tool-ask-user`. Failures become `Error: ACP user questions must come from an agent-owned request`, `Error: ACP user question has no matching session`, `Error: ACP elicitation request failed`, `Error: ask_user_question was cancelled by the user`, `Error: ask_user_question returned no answer`, or `Error: ask_user_question was aborted before the user answered`. Permission decisions control whether another tool yields success or denial. ACP tool cards, terminal output, diffs, title updates, and other streamed session updates are UI-only.

#### Token effect

Answer, error, and denial text enters context only through the owning tool result; presentation metadata adds zero model tokens. A replacement `tool/result` still changes the model-facing session surface, but live and replayed ACP feeds ignore it as an execution update so the original terminal or diff completion is not overwritten.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Permission preset switches

#### What the model sees

`session/set_config_option` emits no model message itself. When `dsh-permission` is composed, the bridge writes the selected preset through that service; the resulting model-visible policy prompt and change notice belong to [`dsh-user-approval`](../user-approval/README.md), while sandbox-mode effects belong to [`dsh-tool-bash`](../../bash/tool-bash/README.md). The ACP `Permissions` select, its option descriptions, pending idle value, and refreshed config response remain client-only.

#### Token effect

Zero direct tokens from the ACP option or the log-only `permission/preset` event. Downstream cost is limited to the owning plugins' policy prompt, conditional retained change notice, and any changed tool outcome.

#### KV Cache effect

The ACP option and log event cause no direct invalidation. The downstream policy-prompt change may invalidate reuse from that system section, while its change notice appends to history.

### Model switches

#### What the model sees

The ACP selector itself emits no message. The selected provider/model pair supplies the next step's `{{provider}}` / `{{model}}` prompt variables and request routing together; all other call-config fields continue through the `agent/request` waterfall unchanged.

#### Token effect

The selector adds no direct tokens. A changed model may tokenize the same retained prompt/history differently, and any persona text that interpolates provider or model changes accordingly.

#### KV Cache effect

Switching provider or model selects a different cache domain. If the persona interpolates either value, the rendered system prompt also changes and prevents reuse from its first changed token.

### Loaded sessions

#### What the model sees

`session/load` resumes the persisted log, after which the loop sends its reconstructed history and request header. Replaying that log to the editor is not an extra model message.

#### Token effect

Restored context has the persistence and session packages' normal retained cost; ACP replay to the client adds none.

#### KV Cache effect

Loading does not rewrite the stored log, but the next request is reconstructed under the current envelope and route. Reuse requires that reconstruction to match; ACP replay to the client has no cache effect.

## Known Limitations and Deferred Work

- **`additionalDirectories`** — rejected. A session operates in its single `cwd` (see Per-session cwd); widening the tool/filesystem scope to extra roots is a separate sandbox concern, not yet implemented.
- **Prompt content is `text` + `resource_link` only** — image, audio, and embedded-resource blocks are rejected, as is a non-empty `mcpServers` list at `session/new`.
- **Session picker UI is client-owned** — `session/list` supplies standard title metadata and, when references are available, a canonical URI extension; an ACP client must consume those fields to add an `@` picker. Title/body search remains future metadata or FTS work.
- **Terminal cards render completed output** — live incremental streaming and command classification are named follow-ups of [the terminal-rendering Agent Note](../../../.agents/notes/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md).
- **Permission answers are one-shot only** — the bridge offers `allow_once` / `reject_once`; durable `allow_always` grants and their storage/revocation policy remain deferred to the approval seam.
- **Command output is live-only** — discovery is refreshed after load, but direct command results are not persisted or replayed into a reconnected editor.
