# RFC: Unify the agent id and the session id

Status: proposed

## Problem

The agent factory carries two ids for each live agent/session pair: `agentId`, the `AgentRegistry` routing handle, and `sessionId`, the event-sourced and persisted-log identity. `CreateAgentOptions` takes both; `ResumeAgentOptions` takes `agentId` plus `resumeSessionId`; in-process subagents mint two independent UUIDs despite recording lineage separately.

ACP already uses the same value for both identities. They diverge for config-created agents, resumed sessions, and in-process children, but no production path reattaches one live agent to several sessions or drives one session through several agent ids. Stdio keeps `labelBySession` only to recover an agent label from session events, and hooks expose both values for authors to reconcile.

The [agent-scope runtime](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md) has no identity-specific reservation state: create and resume use one `AgentCreationTransaction`, and both registry entries use the same final-entry collision rule. Separate ids do not duplicate liveness, rollback, or quiescence machinery. Unification deletes one caller-supplied id, one UUID per in-process child, and the remaining translation paths without changing the transaction lifecycle; it also makes the live-agent registry enforce the session identity used by background-task ownership.

`Session` separately exposes `Session.id` and `Session.header.id` even though construction requires them to match. The durable boundary must validate the duplicate, and consumers must choose between two homes for one fact.

## Proposal

Use one id for the agent registry entry and `session.header.id`. `CreateAgentOptions` accepts one identity for both final entries; resume registers the agent under the resumed session id; subagent creation mints one combined id; and `Session` keeps one identity home. Preserve the current transaction, final-entry collision checks, exact-entry detach, rollback, and quiescence; remove only maps and fields whose sole job is translating between the ids.

The config-driven path must first settle its resume-or-create policy. Today it uses a stable agent label and a fresh UUID-suffixed session id to avoid colliding with an existing durable log on the next run. Under unification it must deliberately resume a fixed id, mint a fresh combined id, or expose that policy; implementation must not choose silently.

`agent/created` and `agent/disposed` remain outside this proposal. They are publication lifecycle events rather than identity aliases; removing them requires a separate production-consumer audit and decision.

## Alternatives considered

**Keep separate routing and log identities.** A stable configured agent label paired with a fresh conversation is a real use of the distinction. If that display or routing identity is required, reject this proposal and enforce session-id uniqueness explicitly instead of hiding the translation in another map.

## Acceptance criteria

- Agent create/resume and subagent creation carry one identity; `Session` stores it in one place.
- The creation transaction retains final-entry collision, exact-entry detach, rollback, and quiescence guarantees without identity-specific lifecycle state.
- ACP, stdio, hooks, bash ownership, persistence, and lineage need no agent/session-id translation.
- The config-driven resume-or-create policy is explicit and covered across a durable restart.
- `agent/created` and `agent/disposed` change only after a separate production-consumer audit.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

Unification forecloses a stable actor identity spanning several session logs, including a future handoff or fork that preserves the actor while changing the session. Reintroducing that design would require a new explicit actor identity. It also makes a persisted, possibly client-chosen session id the registry handle and changes every create/resume call site and fixture.

The config restart policy is the blocking design decision: a fixed combined id may collide with its existing log, while a per-run id gives up the stable configured label. If either independent actor identity or the stable-label/fresh-session pairing is required, reject this proposal and retain the separate ids with an explicit uniqueness guard.
