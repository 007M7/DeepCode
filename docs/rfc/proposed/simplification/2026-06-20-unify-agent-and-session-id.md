# RFC: Unify the agent id and the session id

Status: proposed

## Problem

The agent factory carries two ids for what every supported ownership path treats as one live agent/session pair: `agentId`, the `AgentRegistry` handle, and `sessionId`, the event-sourced/persisted-log identity. `CreateAgentOptions` takes both; `ResumeAgentOptions` takes `agentId` plus `resumeSessionId`; in-process subagents mint two independent UUIDs despite recording lineage separately.

ACP already uses the same value for both identities. Where they diverge, consumers maintain translations rather than use the distinction: stdio keeps `labelBySession` solely to recover an agent label from session events, ACP keeps reverse ownership state, and hooks expose both values for authors to reconcile. No production path reattaches one stable actor id to several sessions or drives one session through several agent ids.

The [agent-scope design](../../implemented/architecture/2026-07-08-agent-scope-contexts.md) makes the cost concrete. The `AgentLoop` factory reserves agent ids and session ids independently during asynchronous setup, with paired rollback paths, even though successful creation always publishes one pair; the registry and store then recheck live publication. PR #224 correctly closes the former duplicate-session ownership hole by reserving and rechecking both ids, so identity unification is no longer a correctness fix; it is a way to delete the second reservation/index/translation system.

Session itself repeats the same fact as `Session.id` and `Session.header.id`. Valid store paths construct them equal, but the constructor does not enforce equality and production consumers choose between the two. The duplicate creates an impossible-but-representable mismatch inside the object that owns session identity.

## Proposal

Make an agent's registry id equal its session id. `CreateAgentOptions` accepts one id used for both registration and session creation; resume registers the agent under the resumed session id; subagent creation mints one combined id; Session keeps one identity home by deriving `id` from `header.id` or removing the alias. Replace the two reservation sets and rollback branches with one combined identity reservation, and remove maps/fields whose sole job is translating between the ids.

The config-driven path must first settle its currently hidden resume-or-create policy. Today it uses a stable agent label and fresh UUID-suffixed session id to avoid colliding with a durable log on the next run. Under unification it must deliberately resume the fixed id, mint a fresh combined id, or expose an explicit policy; implementation must not pick silently.

After stdio's translation map disappears, rerun the consumer search for `agent/created` and `agent/disposed`. If it is empty, remove those notifications together with `AgentRegistry.announced`/`announce()` and their publication rollback machinery. PR #224 deliberately hardened those lifecycle semantics, so this follow-on removal is conditional on proving that identity unification eliminated their last owner.

## Alternatives considered

**Keep separate actor and session identities.** This leaves room for handoff, one actor traversing many logs, or many actors adopting one log. None is supported today. If that product direction arrives, it deserves an explicit actor/handoff seam with ownership semantics rather than two ids that happen to differ in a few constructors.

## Acceptance criteria

- Agent create/resume and subagent creation carry one identity; `Session` stores it in one place.
- The factory keeps one in-flight reservation/rollback path while preserving PR #224's duplicate and quiescence guarantees.
- ACP, stdio, hooks, bash ownership, persistence, and lineage need no agent/session id translation.
- The config-driven resume-or-create policy is explicit and covered across a durable restart.
- `agent/created`/`agent/disposed` are removed only if a post-change production search finds no listener; otherwise they and their publication semantics stay.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This forecloses latent multi-session-actor and session-handoff designs, makes persisted client-chosen session identity the registry identity, and touches every factory fixture. The config restart decision is blocking, not mechanical. If separate actor identity becomes a real requirement, reject this RFC and retain PR #224's already-correct dual reservation system.
