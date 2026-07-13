# RFC: Unify the agent id and the session id

Status: proposed

## Problem

The agent factory carries two ids for each live agent/session pair: `agentId`, the `AgentRegistry` routing handle, and `sessionId`, the event-sourced/persisted-log identity. `CreateAgentOptions` takes both; `ResumeAgentOptions` takes `agentId` plus `resumeSessionId`; in-process subagents mint two independent UUIDs despite recording lineage separately.

ACP already uses the same value for both identities. Where they diverge, stdio keeps `labelBySession` solely to recover an agent label from session events, and hooks expose both values for authors to reconcile. No production path reattaches one live agent object to several sessions or drives one session through several agent ids.

The [agent-scope runtime](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md) has no reservation side tables: create and resume use one `AgentCreationTransaction`, and agent/session entries use the same final-entry collision rule. Separate ids therefore do not duplicate asynchronous liveness, rollback, or quiescence machinery. Identity unification is only an API and representation simplification: it deletes one caller-supplied id, one UUID per in-process child, and the remaining translation paths without changing the transaction lifecycle.

Session itself repeats the same fact as `Session.id` and `Session.header.id`. Construction rejects a header whose id differs, so the aliases are constrained equal; the durable boundary must nevertheless validate the duplicate, and production consumers choose between its two homes.

## Proposal

Make an agent's registry id equal its session id. `CreateAgentOptions` accepts one id used for both final registry entries; resume registers the agent under the resumed session id; subagent creation mints one combined id; Session keeps one identity home by deriving `id` from `header.id` or removing the alias. Keep the existing creation transaction, final-entry collision checks, and exact-entry detach semantics; remove only maps and fields whose sole job is translating between the ids.

The config-driven path keeps `agents[].id` as a stable configuration label, not a live routing identity. A fresh start mints the combined id `${label}-session-${randomUUID()}` so durable restarts do not collide; `resumeSessionId` instead supplies the exact combined identity to load and register. Logs may use the stable label while all live and durable lookups use the one `SessionId`.

`agent/created` and `agent/disposed` remain outside this proposal. They are paired publication lifecycle events, not identity aliases; any later consumer-free removal needs its own proposal after a fresh search.

## Alternatives considered

**Keep separate routing and log identities.** A stable configured label plus a fresh durable conversation is useful, but it does not require two live identities: the label can remain configuration/display metadata while the combined per-run `SessionId` owns routing and persistence. Keeping two ids would preserve translation maps and permit impossible pairings without adding lifecycle capability.

## Acceptance criteria

- Agent create/resume and subagent creation carry one identity; `Session` stores it in one place.
- The existing creation transaction keeps final-entry collision, exact-entry detach, rollback, and quiescence guarantees without adding identity-specific lifecycle state.
- ACP, stdio, hooks, bash ownership, persistence, and lineage need no agent/session id translation.
- The config-driven resume-or-create policy is explicit and covered across a durable restart.
- `agent/created`/`agent/disposed` are removed only if a post-change production search finds no listener; otherwise they and their publication semantics stay.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Risks

This forecloses latent multi-session-actor and session-handoff designs, makes persisted client-chosen session identity the registry identity, and touches every factory fixture. If separate routing identity becomes a real requirement, it needs an explicit lifecycle design rather than an unconstrained caller-supplied pair.
