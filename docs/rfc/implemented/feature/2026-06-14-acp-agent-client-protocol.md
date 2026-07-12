# RFC: Agent Client Protocol (ACP) support — drive the coding agent from external editors

Status: implemented

## Problem

The harness originally exposed agents only through a readline loop. That surface could carry text, but it gave an editor no structured way to create or resume sessions, correlate prompt completion, stream reasoning and tool activity, render tool-specific UI, ask for permission, or cancel one conversation without disturbing another. ACP defines those interactions as JSON-RPC over stdio, and Zed is the target client used to make concrete compatibility decisions.

The bridge must preserve the harness's existing ownership boundaries. It cannot depend on the concrete agent loop, bypass the tool registry, execute shell commands in the editor, or invent a second source of session truth. stdout is also the protocol transport, so any accidental log output corrupts the connection.

## Decision

`@deepseek-ai/dsh-acp` is a UI/client-driver plugin under `packages/ui/acp`. It uses `@agentclientprotocol/sdk`'s `AgentSideConnection` over stdin/stdout and programs only interface services: the agent create/resume factory, session persistence, tool registry, user interaction, and optional approval/bash capabilities. It does not change the agent loop and is not a capability-seam implementation.

The bridge implements the following stable session path:

- `initialize` negotiates the protocol version, advertises text plus `resource_link` prompts, and advertises `loadSession`.
- `session/new` validates an absolute `cwd`, stores it in `SessionHeader`, creates an agent through `ctx.agents`, and returns any composition-backed config options.
- `session/load` validates the requested cwd against persisted metadata before constructing an agent, reserves the id across the asynchronous resume, replays user/assistant/tool events as ACP updates, and reports the resumed config-option fold.
- `session/prompt` accepts text and resource links, rejects unsupported or empty content, allows one in-flight prompt per session, and settles against that prompt's owning `turn/end`. An error turn rejects the RPC; other closed turn reasons map through a total ACP stop-reason codec.
- `session/cancel` calls the queue-aware agent cancel path and settles only the addressed session's prompt.

Tool-call presentation remains tool-owned. A tool's `presentCall` and `presentResult` return the `generic`, `terminal`, or `diff` render-intent variants; the bridge switches on that union and maps it to ACP. Presenter-less tools receive a generic fallback. Bash terminal cards use Zed's capability-gated `_meta.terminal_info`, `_meta.terminal_output`, and `_meta.terminal_exit` convention; the harness still executes the command through `ctx.bash`, preserving sandbox, environment scrub, ownership, and cwd. Clients without that extension receive ordinary text content. Filesystem tools provide diff cards and file locations without hard-coded tool-name branches in the bridge.

Permission handling is an answerer on the [user-approval seam](2026-07-06-approval-seam.md), not an ask-every-tool policy in ACP. An `approval/request` for a bridge-owned agent with a call id becomes `session/request_permission` on that agent's editor session, with one-shot allow/reject choices. Foreign or call-less requests delegate; a missing or failed answerer remains fail-closed. The plugin that asks—such as a pre-execute policy or bash escalation—owns the decision to ask.

The bridge advertises ACP config options instead of session modes. `sandbox-mode` exists only when the mounted bash executor reports sandbox capability, and `approval-policy` exists only when `ctx.approval` is composed. Each option is an independent select whose current value is the session event fold over the composition default. `session/set_config_option` validates against the owning domain vocabulary and writes through `setSandboxMode` or `setApprovalPolicy`. An open-turn switch appends immediately; an idle switch is overlaid in the response and anchored at the next turn start. Until that anchor it is memory-only and a crash reverts to the durable fold. ACP session modes are deliberately not modeled because one mode list cannot represent these orthogonal knobs and config options are the forward protocol surface. Runtime model selection remains outside this decision; `AcpConfig.model` is connection-wide.

The bridge also provides the ACP-backed `UserInteractionProvider`: `ask_user_question` requests become form elicitations on the owning session. Select, multi-select, option descriptions, and custom-answer override semantics are preserved.

Lifecycle ownership is explicit. The bridge holds an `AgentHandle` per live session. Disconnect and Cordis disposal cancel pending prompts, dispose every handle in parallel, await loop quiescence and persistence flush, and then remove the records. Stream notification failures are contained so a vanished client cannot corrupt an agent turn. The ACP app composition loads no stdout logger; a test guards stdout as framed JSON-RPC only.

The precise supported and deferred protocol rows live in [`packages/ui/acp/acp-feature-support.md`](../../../../packages/ui/acp/acp-feature-support.md); the package README is the operational contract.

## Alternatives considered

**A prepended `tools/execute` listener that asks on every ACP-owned call** — rejected. It would hard-code permission policy into the UI bridge, ask even when no policy requires it, and could not serve approval requests that arise after execution begins. The shared user-approval seam keeps mechanism, asking policy, and UI answerer separate.

**Inject the concrete `agentLoop`** — rejected. Agent creation, resume, idle observation, and disposal are interface-level ownership operations on `dsh-agent`; a UI plugin does not need a dependency-rule exception.

**Execute bash through ACP `terminal/*`** — rejected. That would move execution outside the harness and bypass its sandbox, credential scrub, task ownership, cwd resolution, and session log. Terminal metadata is presentation only.

**Represent sandbox and approval as ACP session modes** — rejected. They are independent composable settings, while a single current mode is mutually exclusive. ACP config options represent both without a cross-product and match the protocol's forward direction.

**Hijack stdout defensively** — rejected. Process-wide monkey-patching is outside Cordis effect ownership and races the protocol transport. The app composition owns stdout purity.

## Consequences

Editors can create, load, prompt, cancel, render, ask, and reconfigure multiple harness sessions over one ACP connection without a loop-specific dependency. The session event log remains the durable source for replay, prompt settlement, cwd, and per-session configuration. Tool presentation and human-answer channels remain extensible plugin contracts instead of ACP-specific behavior.

The bridge deliberately does not implement session list/delete/resume/close capabilities, MCP passthrough, additional directories, image/audio/embedded-resource prompts, runtime model selection, plans, slash commands, usage updates, editor filesystem delegation, or the ACP terminal execution sub-protocol. The feature checklist records these as unsupported rather than silently accepting them.

An idle config selection is truthful in the live response but not durable until the next turn anchors it. Crashing before that boundary loses the pending selection; this is the cost of keeping session events turn-enclosed and replay-safe.

## Verification

The ACP suites cover the in-memory protocol codec, create/load replay, exact prompt settlement, cancellation races, unsupported content, tool presentation, terminal capability fallback, permission outcome mapping, config-option validation and persistence, multi-session isolation, disconnect/disposal quiescence, and HMR cleanup. Snapshot and built-bin tests exercise the app composition, while the real-API e2e self-skips without a key.
