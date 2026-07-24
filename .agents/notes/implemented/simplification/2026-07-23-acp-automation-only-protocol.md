# Agent Note: ACP as an automation-only protocol

Status: implemented

English | [中文](2026-07-23-acp-automation-only-protocol.zh.md)

## Problem

The ACP bridge had become a second interactive product UI. It translated durable events into editor cards, terminal metadata, diffs, plans, titles, reasoning, commands, modes, model and permission pickers, session navigation, and human elicitation. Those responsibilities duplicated the TUI and the Web client while coupling an automation transport to UI services, persistence queries, presentation policy, and editor-specific conventions.

ACP still has one useful role: another agent or automated controller can start a harness process, create an isolated session, send text, receive the committed answer, cancel work, and answer a permission request. The out-of-process ACP subagent backend depends on that standard protocol boundary.

The snapshot suite complicates removal. Most ACP scenarios exercise the assembled agent backend rather than ACP presentation, so deleting the suite with the editor bridge would discard broad keyless behavioral coverage.

## Decision

`@deepseek-ai/dsh-acp` is an automation transport under [`packages/acp/acp`](../../../../packages/acp/acp/README.md), outside the `ui` package group. Its public protocol is intentionally small: version negotiation, fresh text sessions with one in-flight prompt each, committed assistant text updates, per-session cancellation, concurrent sessions, and connection-owned teardown. Prompts carry the spec-required baseline only — text plus resource links flattened to bracketed textual references; the bridge rejects additional directories, MCP servers, beyond-baseline prompt content (image, audio, embedded resources), empty prompts, unknown sessions, and overlapping prompts.

The bridge emits only committed `assistant/message` text. Reasoning, raw chunks, tool activity, todos, plans, titles, retry markers, terminal metadata, diffs, locations, and resource links remain in the durable session log or in UI-specific transports. It does not provide session load/list/delete, commands, modes, configuration selectors, model switching, plan review, or human elicitation.

One-shot `session/request_permission` remains. It is a machine policy channel for bridge-owned agents, not a human approval UI: the client chooses allow once, reject once, or cancel, and the bridge never turns that response into a durable grant. [`dsh-subagent-acp`](../../../../packages/subagent/subagent-acp/README.md) uses this channel programmatically.

The app composition contains the agent spine, persistence, checkpoint policy, and ACP transport. It does not mount command, session-query, session-reference, plan-mode, permission-picker, or user-interaction services for ACP. SDK scaffolding likewise treats `ask_user_question` as TUI-only.

Disconnect and plugin disposal share one memoized quiescence boundary. Both successful and failed transport closure settle pending prompts as cancelled, dispose every bridge-owned agent, and await loop and session cleanup. A create that loses the close race disposes its unpublished handle.

## Snapshot boundary

The ACP snapshot suite still boots the assembled ACP example and retains scenarios that pin backend behavior. Only scenarios driven through deleted UI methods leave the suite; semantic-checkpoint recovery runs through the headless `stream-json` example because ACP no longer loads sessions.

## Alternatives considered

**Keep ACP as an editor UI until Web reaches parity.** Rejected because it leaves two interactive contracts to evolve and keeps editor conventions in the automation boundary.

**Replace ACP with a private subagent RPC.** Rejected because ACP already supplies a typed, interoperable process protocol and is used by the out-of-process subagent backend.

**Remove machine permission requests with the other interaction features.** Rejected because an automated parent must answer a child agent's one-shot policy decision; this is control flow between agents, not presentation.

**Delete the ACP snapshot suite or migrate every scenario in this change.** Rejected because most scenarios test the backend and remain valuable, while a full harness migration is an independent testing change. Only scenarios whose driver was a deleted UI method leave this suite.

## Consequences

ACP has a narrow contract suitable for agents and automation, while TUI and Web own human interaction and presentation. The package has fewer injected services, dependencies, protocol branches, and lifecycle states, and it no longer claims compatibility as a general editor front door.

Automation clients receive complete committed text rather than token deltas or structured tool UI. They inspect durable logs or another API when they need reasoning, tool traces, titles, or richer state. Fresh-session-only operation also means callers that need durable browsing or resume use a host API rather than ACP.

Backend snapshot coverage therefore remains transport-coupled to ACP even though that transport is incidental to the behavior under test.
