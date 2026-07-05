# RFC: Multiplex concurrent ACP sessions over one connection

Status: proposed

> **Implementation status:** the multi-session bridge (steps 1, 3, 4) and the bash task-ownership isolation are implemented in `packages/ui/acp` + `packages/bash/tool-bash`. **Per-session *permission* ownership is deferred** — it depends on [the ACP support permission gate](2026-06-14-acp-agent-client-protocol.md) (`TODO(rfc010-permission-gate)`), which is itself deferred; the `agent→sessionId` reverse map the gate will route through is in place. Step 2's per-session disposer scope is now implemented (see [agent lifecycle & ownership seams](../../implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md)): the factory returns a per-agent `AgentHandle` whose `dispose()` stops the loop, awaits quiescence, unregisters the agent, and removes its session, so a bare client disconnect leaves no registered agent or session-store entry. Status stays `proposed` until per-session permission ownership lands.

> **Target-client note:** Zed is the current target ACP client, and its ACP client maintains a `HashMap<SessionId, AcpSession>` plus `pending_sessions` for concurrent `session/load` calls. The competing simplification to return to one live session per connection was rejected after checking that target-client shape; this RFC remains the path for finishing multiplexing and per-session permission ownership. See [the rejected simplification](../../rejected/simplification/2026-06-20-single-session-acp-bridge.md).

## Problem

[ACP support](2026-06-14-acp-agent-client-protocol.md) ships with a single active session per connection: a second `session/new` is rejected. Editors expect to run several conversations over one agent subprocess — a user opens multiple threads, or a client pre-warms sessions. The single-session guard is a deliberate MVP scope cut, not an architectural limit; this RFC lifts it.

This paragraph is historical: the multi-session bridge has landed. The remaining proposed work is per-session permission ownership plus the lifecycle seams now tracked in [agent lifecycle and ownership seams](../../implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

## Proposal

The harness core already supports many agents (`AgentRegistry.list()` and `AgentLoop.create` impose no count limit), so multiplexing is a bridge-layer change in `@deepseek-ai/dsh-acp`, not a loop or core change.

- Lift the single-session guard in `session/new`; allow N live sessions, each mapped to its own `ReactLoopAgent`.
- The bridge's `sessionId→agent` and `Session→sessionId` maps (introduced single-entry by [the ACP support RFC](2026-06-14-acp-agent-client-protocol.md)) become true multi-entry, plus a third `agent→sessionId` reverse map: the `tools/execute` permission gate receives only `exec.agent` (no sessionId), so it needs an O(1) reverse lookup to find the owning session. Every `agent/*` event and every `session/event` is demuxed strictly by id, so two sessions streaming at once never interleave their `session/update` notifications.
- Per-session prompt queues: [the ACP support RFC](2026-06-14-acp-agent-client-protocol.md)'s single-entry in-flight-prompt state becomes multi-entry — one in-flight prompt *per session*, tracked per `sessionId`.
- Per-session cancel routing: `session/cancel` cancels only its own session's agent (via the queue-aware `agent.cancel()`) and settles only that session's in-flight prompt. The cancel is scoped to that one agent — a per-agent `AbortController` for the running step plus the agent's own queued/steering FIFOs — so it never touches another session's stream or pending prompt.
- Per-session permission ownership: a `session/request_permission` and its outcome are bound to the originating session via the reverse map, so a permission prompt or a cancel in one session can never resolve another session's pending permission.

## Plan

1. Generalize the two id maps to multi-entry and add the `agent→sessionId` reverse map; add a per-session record holding the agent, the in-flight-prompt state, the pending-permission registry, and the session's disposer scope (see step 2).
2. Give each session a real per-session disposer scope, NOT `ctx.extend()` — in Cordis `ctx.extend()` only creates a child context/prototype, but `ctx.on()` registered on it is still owned by the current plugin fiber, so disposing it would not remove that session's listeners. Use a genuine child fiber (load a per-session sub-plugin, e.g. `ctx.plugin(...)` returning a fork, or collect each session's `ctx.on` disposers in its session record and call them on teardown). Demux every `agent/*` and `session/event` by id into the right session record. Note the single global `tools/execute` listener stays on the bridge root (it must see all agents) and routes via the reverse map.
3. Lift the `session/new` guard; keep `session/load` ([from ACP support](2026-06-14-acp-agent-client-protocol.md)) working per session.
4. Tests for cross-session isolation: two sessions streaming and permission-prompting concurrently never interleave; a cancel/abort in one session leaves the other's stream and pending permission untouched; per-session in-flight-prompt enforcement holds independently; disposing one session leaves the others running.

## Alternatives considered

**A per-session `ctx.extend()` scope** — rejected: in Cordis, `ctx.extend()` only creates a child context/prototype, and `ctx.on()` registered on it is still owned by the current plugin fiber, so disposing it would not remove that session's listeners. A genuine child fiber (or a per-session collection of disposers) is required.

## Acceptance criteria

- N concurrent sessions stream and permission-prompt without interleaving their `session/update` notifications; a cancel in one session leaves every other session's stream, queued prompts, and pending permissions untouched.
- Disposing one session removes exactly its own listeners; connection teardown reaches quiescence across all sessions.
- One session's agent cannot read or kill another session's background bash task.

## Risks

Listener fan-out cost: each session adds listeners; ensure disposal of one session removes exactly its own and the connection teardown ([from ACP support](2026-06-14-acp-agent-client-protocol.md)) still reaches quiescence across all sessions.

The subtle correctness trap is cross-session leakage — a cancel or abort on one session settling another session's pending permission. The per-session permission ownership rule (routed via the `agent→sessionId` reverse map) and its isolation test are the guard.

Shared background-task state: the bash executor's task ids are global and predictable (`bash-1`, `bash-2`, …), and `bash_output`/`bash_kill` look up by id without checking the caller. Under one session this is benign; under N sessions one session's agent could read or kill another's background task. This is a pre-existing `tool-bash` gap that multi-session turns into a real isolation hole — fixing it (validate the caller against the task owner) belongs with this RFC or a companion `tool-bash` change.
