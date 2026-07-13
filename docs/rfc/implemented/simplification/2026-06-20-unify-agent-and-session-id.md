# RFC: Unify the agent id and the session id

Status: implemented

## Problem

The agent factory previously carried two ids for each live agent/session pair: `agentId`, the `AgentRegistry` routing handle, and `sessionId`, the event-sourced/persisted-log identity. `CreateAgentOptions` took both; `ResumeAgentOptions` took `agentId` plus `resumeSessionId`; in-process subagents minted two independent UUIDs despite recording lineage separately.

ACP already used the same value for both identities. Where they diverged, stdio kept `labelBySession` solely to recover an agent label from session events, and hooks exposed both values for authors to reconcile. No production path reattached one live agent object to several sessions or drove one session through several agent ids.

The [agent-scope runtime](../../implemented/architecture/2026-07-12-agent-scope-runtime-design.md) had no reservation side tables: create and resume used one `AgentCreationTransaction`, and agent/session entries used the same final-entry collision rule. Separate ids therefore did not duplicate asynchronous liveness, rollback, or quiescence machinery. Identity unification was only an API and representation simplification: it deleted one caller-supplied id, one UUID per in-process child, and the remaining translation paths without changing the transaction lifecycle.

Session itself repeated the same fact as `Session.id` and `Session.header.id`. Construction rejected a header whose id differed, so the aliases were constrained equal; the durable boundary nevertheless had to validate the duplicate, and production consumers chose between its two homes.

## Decision

An agent's registry id equals its session id. `CreateAgentOptions` accepts one `sessionId` used for both final registry entries; resume registers the agent under `resumeSessionId`; in-process and ACP subagent creation use the child session id; and `Session.id` derives from `header.id`. The existing creation transaction, final-entry collision checks, and exact-entry detach semantics remain; maps and fields whose sole job was translating between the ids are gone.

The config-driven path keeps `agents[].id` as a stable configuration label, not a live routing identity. A fresh start mints the combined id `${label}-session-${randomUUID()}` so durable restarts do not collide; `resumeSessionId` instead supplies the exact combined identity to load and register. Logs may use the stable label while all live and durable lookups use the one `SessionId`.

`agent/created` and `agent/disposed` remain. They are paired publication lifecycle events, not identity aliases; any later consumer-free removal needs its own proposal after a fresh search.

## Alternatives considered

**Keep separate routing and log identities.** A stable configured label plus a fresh durable conversation is useful, but it does not require two live identities: the label can remain configuration/display metadata while the combined per-run `SessionId` owns routing and persistence. Keeping two ids would preserve translation maps and permit impossible pairings without adding lifecycle capability.

## Verification

- Agent create/resume and subagent creation carry one identity, and `Session` stores it in one place.
- The creation transaction retains final-entry collision, exact-entry detach, rollback, and quiescence coverage without identity-specific lifecycle state.
- ACP, stdio, hooks, bash ownership, persistence, and lineage use the shared `SessionId` directly. The ACP subagent backend uses the child server's returned session id as its run id; the ACP bridge verifies exact `Agent` ownership from the forward session map; and JSON-RPC caches only disposable-child parent lineage.
- The config-driven resume-or-create policy is explicit and covered across a durable restart.
- A production listener search kept `agent/created`/`agent/disposed` and their publication semantics.
- Typecheck, coverage, snapshots, doc-sync, module-graph verification, build, and hygiene pass.

## Consequences

This forecloses latent multi-session-actor and session-handoff designs and makes persisted client-chosen session identity the registry identity. If separate routing identity becomes a real requirement, it needs an explicit lifecycle design rather than an unconstrained caller-supplied pair.
