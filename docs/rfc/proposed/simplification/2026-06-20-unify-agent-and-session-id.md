# RFC: Unify the agent id and the session id

Status: proposed

## Problem

The agent factory carries TWO ids for what is, in every live consumer, one thing:

- `agentId` — the `AgentRegistry` handle (the actor identity; the registry rejects a duplicate).
- `sessionId` — the event-sourced session / persisted-log identity (`session.header.id`).

`CreateAgentOptions` takes both separately; `ResumeAgentOptions` takes an `agentId` plus a `resumeSessionId`. They diverge in exactly three places:

- **Config-driven create** (`AgentLoop.create`): a stable `agentId` (e.g. `"echo"`) with a fresh per-run `sessionId` (`${id}-session-<uuid>`).
- **Resume**: a caller-supplied `agentId` (e.g. `"main"`) on a persisted `resumeSessionId`.
- **In-process subagent children**: the backend mints the child's `agentId` and `sessionId` as two independent UUIDs (`packages/subagent/subagent-inprocess/src/index.ts`) that nothing distinguishes — `parentSession` records lineage independently.

Where a live consumer looks an agent up, no lookup needs an id translation: the ACP bridge — the primary production path — already unifies the two (`agentId === sessionId === <uuid>`; both factory call sites brand `AgentId(sessionId)` directly, and its reverse lookup keys on the `Agent` object itself), and the CC hooks bridge resolves subagent children directly by the `agentId` its lifecycle event carries. The one production population whose two ids actually DIVERGE is the in-process subagent children — the same cosmetic separation as the config path, and the same one-field simplification under unification. One consumer already pays the two-id tax: ui-stdio keeps a `labelBySession` map (seeded from the registry, maintained by `agent/created`/`agent/disposed` listeners) solely to translate `session.header.id` back to an agent id for its turn labels — machinery that deletes outright when the ids unify. And the CC hooks bridge stamps `session_id: agent.session.header.id` into every hook payload, so under unification a subagent hook's `session_id` and `agent_id` become the same string — one less identity for a hook author to reconcile.

The separation is **latent generality no consumer exercises**: nothing reads a *stable* `agentId` back across runs (each process starts fresh, and persistence keys off the session id, never the agent id). The config path's "stable agentId, fresh sessionId" buys nothing concrete — it is cosmetic. And the `agentId !== sessionId` case is precisely what opens the bash owner-token alias hole: the bash completion-notice routes by `session.header.id`, but the registry enforces uniqueness only on `agentId`, so a programmatic caller registering two agents with different agent ids but the SAME session id can mis-route a notice (see [agent lifecycle and ownership seams](../../implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md) § Seam precondition). The current code documents this as a precondition rather than guaranteeing it.

## Proposal

Make an agent BE its session: one id. An agent's registry handle IS its `session.header.id`.

- `CreateAgentOptions` drops the separate `sessionId` — the single `id` is both the registry handle and the live/persisted session id. (ACP already passes the same UUID for both, so its call site simplifies to one field.)
- `ResumeAgentOptions` drops the separate `agentId` — resuming `sessionId` X registers the agent under id X. (ACP already does this.)
- The config path (`AgentLoop.create`) uses its configured `id` directly as the session id, applying whatever resume-or-create policy it adopts (today it appends a per-run uuid to avoid colliding with an on-disk log; that policy moves onto the single id, e.g. the config id IS the session and a durable backend resumes it — to be settled in the implementing PR).
- The registry's existing unique-`agentId` check becomes, by construction, a unique-session-id guarantee — the bash alias hole is closed with NO new defensive invariant: two agents cannot share a session id because the session id is the agent id.

## Why not just enforce session-id uniqueness in `AgentRegistry.register()`?

That was the review's first suggestion. It would couple the generic registry to a session-uniqueness assumption (the registry tracks *agents*, not sessions) and entrench the very separation this RFC removes. Unifying the ids closes the hole more cleanly — there is nothing left to enforce.

## Acceptance criteria

- `ctx.agents.create`/`resume` take a single id; the ACP bridge passes one id.
- The config-driven agent path has a deliberate, documented session-id policy (no silent per-run id divergence that no consumer reads).
- The bash owner-token alias hole is gone by construction (no two live agents can share a session id).
- All existing behavior the tests pin (ACP create/resume/load, config startup, durability) still holds — or the tests change WITH the behavior where the divergence was an artifact (per AGENTS.md "tests document behavior, not golden truth").

## Risks

This touches public factory interfaces (`CreateAgentOptions`, `ResumeAgentOptions`, `AgentFactory`) and the config-agent id scheme, so it is a deliberate cross-package change, not a local patch — it ships as its own PR (converged with Codex); the bash owner-token precondition it closes is documented in [agent lifecycle and ownership seams](../../implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-seams.md).

The genuine risks of collapsing the two ids into one (the case AGAINST this proposal — to be weighed honestly before implementing):

- **It forecloses a one-agent-resumes-many-sessions / one-session-driven-by-many-agents future.** Today the separate ids leave room for an agent (a stable actor) to detach from one session and attach to another, or for a handoff where a new agent process adopts an existing session under a new actor handle. Unifying makes "agent" and "session" the same lifetime, so any such future needs a NEW seam (e.g. an explicit `actorId` distinct from the session) — re-introducing the very separation we removed. We judge this generality currently unused, but it is a door this change closes.

- **Subagents / fork / spawn may WANT a stable actor id across forked sessions.** The [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) runs a child agent seeded from a parent's event log (fork). If a future design wants "the same agent identity across a fork" (parent and child share an actor but have distinct session logs), a unified id blocks it. The implementing PR must check the intended fork/spawn model BEFORE unifying, or accept that fork always mints a fresh combined id. (As shipped, each subagent child mints its own distinct agent id — `parentSession` records lineage — so the seam does not currently rely on a shared actor id, but unifying would foreclose adding one.)

- **The config-driven resume-or-create policy becomes load-bearing, not cosmetic.** Today the per-run-uuid session id quietly sidesteps the "a fixed id collides with its own on-disk log on the second run" problem. Once the id is unified and stable, a config agent restarting MUST decide resume-vs-fresh deliberately — there is no longer a throwaway session id to hide behind. Getting this wrong reintroduces the create-collision the uuid was avoiding (a durable backend refuses to re-create an id whose log exists). This is the one real design decision the implementing PR owns, and it is easy to get subtly wrong.

- **Persisted/on-disk identity becomes the agent identity.** Unifying means the registry handle is now a persisted, externally-meaningful string (a session id a client chose), not an internal label. A caller that previously used a short human label (`"main"`) as the agent id now must use the session id. This is fine for ACP (already a UUID) but is a semantic narrowing for any programmatic embedder that relied on naming its agents independently of session storage.

- **Migration churn touches every create/resume call site and its tests.** `CreateAgentOptions`/`ResumeAgentOptions` shape changes ripple to ACP, the config path, the agent-loop factory, and ~dozens of test fixtures that currently pass distinct `agentId`/`sessionId` (some deliberately distinct to exercise the divergence — those tests change WITH the behavior, per AGENTS.md "tests document behavior, not golden truth"). The risk is mechanical but broad; a missed call site is a type error, but a missed *test* could silently lose coverage of a path.

The one real design question the implementing PR must settle first is the config-driven resume-or-create policy once the id is unified (today's per-run-uuid behavior is a demo simplification already flagged `TODO(demo)`). If, on closer look, the fork/spawn or multi-session-actor futures turn out to be wanted, this RFC should be REJECTED in favor of the lighter "enforce session-id uniqueness in the registry" guard — the alias hole is not reachable via ACP, so keeping the ids separate and merely documenting (or mechanically enforcing) the precondition remains a valid alternative.
