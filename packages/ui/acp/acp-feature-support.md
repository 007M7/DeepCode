# ACP feature support checklist

A structured inventory of [Agent Client Protocol](https://agentclientprotocol.com) (ACP) features and where the harness's ACP bridge ([`@deepseek-ai/dsh-acp`](README.md)) stands on each. The bridge exposes the harness agent as an ACP **server** (the agent side of an editor↔agent connection), so "supported" below means *the bridge implements the agent's half* — answering an agent method, advertising a capability, or calling a client method.

## Scope

This tracks the **stable** ACP v1 surface (schema `1.14.0`, `schema/v1/schema.json`) PLUS the **unstable/draft** features that the two reference adapters — [`claude-agent-acp`](https://github.com/zed-industries/claude-code-acp) (Claude Code) and [`codex-acp`](https://github.com/zed-industries/codex-acp) (OpenAI Codex) — actually ship. A purely-unstable feature that neither reference adapter uses is omitted (see [Out of scope](#out-of-scope)).

Legend: ✅ supported · ⚠️ partial / fallback · ❌ not yet · — n/a. The **Stable** column marks whether the feature is in the released v1 schema (S) or only the unstable schema (U). The **Claude** / **Codex** columns record whether each reference adapter ships it, as a maturity signal.

## At a glance

The bridge implements the **core prompt-turn loop** for N concurrent sessions: initialize, session new/load, prompt, cancel, streamed assistant/thought chunks, tool-call rendering (including Zed terminal cards), resumable session replay, one-shot permission prompts, and per-session permission presets. The largest **unbuilt** areas are **MCP passthrough**, runtime model selection, **slash commands**, and **agent plans**, plus the client **filesystem** and **terminal** method families (which the adapters mostly do NOT drive either — see rows 43-49). See [Gap summary](#gap-summary).

## 1. Agent methods (client → agent)

| Method | Stable | Bridge | Claude | Codex | Notes |
|---|---|---|---|---|---|
| `initialize` | S | ✅ | ✅ | ✅ | Negotiates `PROTOCOL_VERSION`; advertises `loadSession` + baseline prompt caps. Snapshots the Zed `_meta.terminal_output` client cap. |
| `authenticate` | S | ⚠️ | ✅ | ✅ | No-op stub; the bridge advertises no `authMethods`, so there is nothing to authenticate. |
| `logout` | S | ❌ | ✅ | ✅ | Gated by `agentCapabilities.auth.logout`; not advertised. |
| `session/new` | S | ✅ | ✅ | ✅ | Maps to `agents.create`; requires an absolute `cwd` (becomes the session workspace); rejects non-empty `additionalDirectories` / `mcpServers`. |
| `session/load` | S | ✅ | ✅ | ✅ | Maps to `agents.resume` + full event-log replay; validates persisted `cwd` before constructing the agent. |
| `session/resume` | S | ❌ | ✅ | ✅ | Reconnect WITHOUT replay; gated by `sessionCapabilities.resume`. Not advertised. |
| `session/close` | S | ❌ | ✅ | ✅ | No `session/close` handler — the SDK dispatch returns `method_not_found`. The bridge tears sessions down on client disconnect / Cordis disposal (cross-cutting, see [§8](#8-cross-cutting)), but that is not the on-demand per-session method. |
| `session/prompt` | S | ✅ | ✅ | ✅ | Maps to `agent.send`; one in-flight prompt per session; settles on the owning turn's end. |
| `session/cancel` | S | ✅ | ✅ | ✅ | Queue-aware `agent.cancel`; settles the in-flight prompt `cancelled`, scoped to the one session. |
| `session/set_mode` | S | ❌ | ✅ | ✅ | Session modes deliberately skipped: config options are the spec's replacement and modes are slated for removal in ACP v2 (see [§6](#6-session-modes--config-options--models)). |
| `session/set_config_option` | S | ✅ | ✅ | ✅ | One `permission` select when `ctx.permission` is composed; values come from the deployment preset table, a switch writes its preset event through to both knob events, and the response carries the complete refreshed state ([sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)). |
| model selection | S | ❌ | ✅ | ✅ | No distinct stable `session/set_model` — model is the `model`-category `session/set_config_option`. The bridge fixes the model per-bridge via config; no runtime switch. Codex still uses the legacy `unstable_setSessionModel` ext method. |
| `session/list` | S | ❌ | ✅ | ✅ | Gated by `sessionCapabilities.list`. The harness HAS `sessionPersistence.list()` (used internally for load-cwd validation) but does not expose it over ACP. |
| `session/delete` | S | ❌ | ✅ | ✅ | Gated by `sessionCapabilities.delete`. |
| `session/fork` | U | ❌ | ✅ | ❌ | Claude ships `unstable_forkSession`; Codex does not. |

## 2. Client methods the agent CALLS (agent → client)

These are capabilities the bridge would *drive* on the editor. The harness runs tools in-process (its own `dsh-bash` executor, direct file I/O), so it does not yet delegate to the editor for any of these.

| Method | Stable | Bridge | Claude | Codex | Notes |
|---|---|---|---|---|---|
| `session/update` | S | ✅ | ✅ | ✅ | The bridge's primary output channel (see [§4](#4-sessionupdate-variants)). |
| `session/request_permission` | S | ✅ | ✅ | ✅ | The bridge answers the [`ctx.approval`](../user-approval/README.md) seam for the agents it owns: an `ask` from a hook/plugin becomes an editor prompt attached to the streamed tool call, one-shot `allow_once`/`reject_once` options only. Whether a call asks is policy (nothing asks by default); `allow_always` is deferred (grant storage). |
| `fs/read_text_file` | S | ❌ | ✅ | ❌ | The harness reads files directly (it does not see the editor's unsaved buffer state). Claude delegates; Codex does not. |
| `fs/write_text_file` | S | ❌ | ✅ | ❌ | Same — direct writes, no editor delegation. |
| `terminal/create` | S | ❌ | ❌ | ❌ | Neither reference adapter drives the client terminal API either — both, like the bridge, render shell output as tool-call content + a `_meta` channel (see [§5 Terminal](#terminal-rendering)). |
| `terminal/output` | S | ❌ | ❌ | ❌ | As above. |
| `terminal/wait_for_exit` | S | ❌ | ❌ | ❌ | As above. |
| `terminal/kill` | S | ❌ | ❌ | ❌ | As above. |
| `terminal/release` | S | ❌ | ❌ | ❌ | As above. |
| `elicitation/create` · `elicitation/complete` | U | ⚠️ | ✅ | ⚠️ | The bridge drives `unstable_createElicitation` for `ask_user_question` form prompts (session-scoped, no URL-mode flow yet). Claude calls the `unstable_*` elicitation methods for MCP server elicitations; Codex maps elicitations onto `session/request_permission`. |

## 3. Capabilities

### 3a. `agentCapabilities` (advertised by the bridge)

| Capability | Stable | Bridge | Claude | Codex | Notes |
|---|---|---|---|---|---|
| `loadSession` | S | ✅ | ✅ | ✅ | Advertised `true`; backs `session/load`. |
| `promptCapabilities.image` | S | ❌ | ✅ | ✅ | Bridge advertises `image: false`; image prompt blocks are rejected. |
| `promptCapabilities.audio` | S | ❌ | ❌ | ❌ | `audio: false`; neither adapter accepts audio either. |
| `promptCapabilities.embeddedContext` | S | ❌ | ✅ | ✅ | `embeddedContext: false`; embedded `resource` blocks rejected. |
| `mcpCapabilities.{http,sse}` | S | ❌ | ✅ | ⚠️ | No MCP passthrough; `mcpServers` is rejected. Claude advertises http+sse, Codex http only. |
| `sessionCapabilities.*` | S | ❌ | ✅ | ✅ | None advertised (list/delete/resume/close/additionalDirectories/fork all off). |
| `auth.logout` | S | ❌ | ✅ | ✅ | Not advertised. |
| `authMethods[]` | S | ⚠️ | ✅ | ✅ | Advertised as empty (no auth required to reach the model). |
| `agentInfo` (name/version) | S | ✅ | ✅ | ✅ | Fixed literals: `deepseek-harness-acp` / `0.0.1` (not config). |
| `_meta` custom caps | S | ❌ | ✅ | — | E.g. Claude's `claudeCode.promptQueueing`. The bridge advertises no custom `_meta`. |

### 3b. `clientCapabilities` (consumed by the bridge)

| Capability | Stable | Bridge | Notes |
|---|---|---|---|
| `fs.{readTextFile,writeTextFile}` | S | ❌ | Not consulted (the bridge never calls `fs/*`). |
| `terminal` | S | ❌ | Not consulted; the bridge keys terminal rendering off the Zed `_meta.terminal_output` cap instead. |
| `_meta.terminal_output` (Zed) | S (`_meta`) | ✅ | Snapshotted per session at create/load; gates terminal-card rendering. |

## 4. `session/update` variants

| `sessionUpdate` | Stable | Bridge | Claude | Codex | Notes |
|---|---|---|---|---|---|
| `agent_message_chunk` | S | ✅ | ✅ | ✅ | From `assistant/chunk` text-delta. |
| `agent_thought_chunk` | S | ✅ | ✅ | ✅ | From `assistant/chunk` reasoning-delta. |
| `user_message_chunk` | S | ✅ | ✅ | ✅ | Emitted during `session/load` replay to reconstruct the user side. |
| `tool_call` | S | ✅ | ✅ | ✅ | Tool-owned presentation (`presentCall`); see [§5](#5-tool-call-rendering). |
| `tool_call_update` | S | ✅ | ✅ | ✅ | From `tool/result` via `presentResult`. |
| `plan` | S | ❌ | ✅ | ✅ | No agent plan emitted. Both adapters emit real plan entries (Codex's `CodexEventHandler.updatePlan` maps `turn/plan/updated` → `{ sessionUpdate: 'plan', entries }`). |
| `available_commands_update` | S | ❌ | ✅ | ✅ | No slash commands advertised. |
| `current_mode_update` | S | ❌ | ✅ | ✅ | No session modes. |
| `config_option_update` | S | ❌ | ✅ | ✅ | Config options exist (advertised in `session/new`/`session/load`, switched via `session/set_config_option`), but the bridge never pushes agent-initiated changes — an operator default drift is narrated to the MODEL, not echoed to the editor. Future work in the [sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md). |
| `usage_update` | S | ❌ | ✅ | ✅ | Token/cost reporting not surfaced (the harness records token usage internally on `assistant/message`). |
| `session_info_update` | S | ❌ | ⚠️ | ⚠️ | Session title/metadata not pushed. |

## 5. Tool-call rendering

Tool-call presentation is **owned by each tool** (`presentCall` / `presentResult` on the `dsh-tools` definition), not special-cased in the bridge — see the [terminal-and-tool-rendering RFC](../../../docs/rfc/implemented/feature/2026-06-18-acp-terminal-and-tool-rendering.md).

| Feature | Stable | Bridge | Claude | Codex | Notes |
|---|---|---|---|---|---|
| `ToolCallKind` mapping | S | ✅ | ✅ | ✅ | `execute`/`read`/`edit` declared by each tool's `presentCall`; presenter-less tools render `other` (no name sniffing); richer mapping possible. |
| `ToolCallStatus` | S | ✅ | ✅ | ✅ | `in_progress` → `completed`/`failed`. |
| `content` blocks | S | ✅ | ✅ | ✅ | Text content; the description renders above the card. |
| `diff` content | S | ✅ | ✅ | ✅ | The `write`/`edit` tools declare a `diff` render intent: `presentCall` → a call-time `{ card: 'diff' }` snippet, and `presentResult` → a result-time `{ card: 'diff' }`. For an edit or an overwrite it carries the applied hunk(s) with surrounding context (one per `replace_all` site), computed from the before/after text and persisted on the `tool/result` event as `meta`; for a create (no before-image) it is an args-derived whole-file diff. The bridge emits `{ type: 'diff', path, oldText, newText }` content blocks; a successful mutation ALWAYS returns the result diff (an ACP `tool_call_update.content` replaces the call's content, so the result diff — not the model-facing text — is what survives). |
| `terminal` content | S | ✅ | ✅ | ✅ | Via the Zed `_meta` terminal convention (see below), not the spec `terminal/*` sub-protocol. |
| `locations` (follow-along) | S | ✅ | ✅ | ✅ | The `read`/`write`/`edit` tools emit `{ path, line? }` file-location hints via `presentCall`. |
| `rawInput` | S | ✅ | ⚠️ | ✅ | Parsed tool args surfaced as `rawInput`. |
| `rawOutput` | S | ❌ | ⚠️ | ✅ | Not emitted. |

### Terminal rendering

⚠️ Implemented via the **Zed `_meta` convention** (`terminal_info` / `terminal_output` / `terminal_exit`), gated on the client advertising `_meta.terminal_output` — NOT the spec's `terminal/create` sub-protocol (which would make the editor execute the command, bypassing `dsh-bash`'s sandbox / env-scrub / ownership / cwd). Both reference adapters take the same `_meta` approach. Live incremental streaming (`terminal_output_delta`, which Codex negotiates) is a follow-up — the bridge currently sends the full captured output once on the result.

## 6. Session modes / config options / models

Config options ✅ (the [sandbox RFC § Per-session mode switching](../../../docs/rfc/implemented/feature/2026-07-06-sandbox.md)): when `ctx.permission` is composed, the bridge advertises one `permission` select whose values come from the deployment preset table and whose current value derives from the session log; `session/set_config_option` switches the preset end to end, with idle switches anchoring at the next turn under the turn-enclosure contract. Session modes stay deliberately unmodeled because config options replace them in ACP v2. Runtime model selection is still not modeled — the harness fixes the model per bridge via `AcpConfig.model` (both reference adapters ship a model selector).

## 7. Content blocks

| Block | Stable | In prompts | In updates | Notes |
|---|---|---|---|---|
| `text` | S | ✅ | ✅ | Baseline. |
| `resource_link` | S | ✅ | ⚠️ | Accepted in prompts and rendered into text (`acpPromptToText`); not emitted as a structured update block. |
| `image` | S | ❌ | ❌ | Rejected in prompts (`promptCapabilities.image: false`). |
| `audio` | S | ❌ | ❌ | Rejected. |
| `resource` (embedded) | S | ❌ | ❌ | Rejected (`embeddedContext: false`). |

The bridge rejects unsupported prompt blocks rather than silently dropping them (`promptHasUnsupportedContent`), per the "explicit over implicit" convention.

## 8. Cross-cutting

| Feature | Stable | Bridge | Notes |
|---|---|---|---|
| `StopReason` mapping | S | ✅ | `turnEndToStopReason` is total over harness turn-end reasons → `end_turn`/`max_tokens`/`cancelled`. |
| Multi-session (N per connection) | S | ✅ | Strict per-session demux; concurrent streams never interleave. See the [multi-session RFC](../../../docs/rfc/implemented/feature/2026-06-14-acp-multi-session.md). |
| Disconnect / disposal teardown | S | ✅ | Quiesces every live session on client disconnect or Cordis disposal. |
| `_meta` extensibility | S | ⚠️ | Consumed (Zed terminal cap) and emitted (terminal `_meta`); no other custom extensions. |
| Background-task ownership isolation | — | ✅ | `bash_output`/`bash_kill` reject another session's task via an opaque owner token. |
| stdout-is-the-protocol guarantee | S | ✅ | The bridge runs in an example with no stdout logger. |

## Gap summary

Ranked by how commonly the reference adapters ship them and how much UX they unlock:

1. **Session lifecycle** — `session/list` + `session/delete` (the persistence layer already lists), then `session/resume` / `session/close`.
2. **Model selection** — sandbox and approval config options are implemented; selecting the bridge's model at runtime remains open.
3. **Agent plan** (`sessionUpdate: 'plan'`) — surface the loop's plan as structured entries.
4. **Slash commands** (`available_commands_update`).
5. **MCP passthrough** (`mcpServers` on `session/new` + `mcpCapabilities`).
6. **Richer prompt content** — image / embedded `resource` blocks (needs a multimodal model path).
7. **Usage reporting** (`usage_update`) — the harness already records token usage internally (on `assistant/message`).
8. **Editor filesystem delegation** (`fs/read_text_file` / `fs/write_text_file`) — lets the agent see unsaved buffers; lower priority since the harness has direct disk access.

## Out of scope

Unstable/draft ACP features that **neither** reference adapter ships are not tracked above: `providers/*` (LLM provider selection), `mcp/connect`·`mcp/message`·`mcp/disconnect` (client-side MCP passthrough), `nes/*` (Next Edit Suggestion), `document/did*` (LSP-style document sync), the v2 plan model (`plan_update` / `plan_removed`), boolean config options, `$/cancel_request`, and the draft Streamable-HTTP transport. They can be added if a target editor adopts them.

## Sources

- Stable spec: `schema/v1/schema.json` (schema `1.14.0`) and `docs/protocol/v1/*.mdx` in the [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) repo.
- Reference adapters: [`claude-agent-acp`](https://github.com/zed-industries/claude-code-acp) and [`codex-acp`](https://github.com/zed-industries/codex-acp).
- Bridge: [`README.md`](README.md), [`src/index.ts`](src/index.ts), and the ACP RFCs under [`docs/rfc/`](../../../docs/rfc/README.md).
