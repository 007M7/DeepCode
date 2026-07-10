# RFC: Interactive side sessions and merge-back

Status: proposed

## Problem

A user deep in a live session often wants to fork the conversation — ask "why did we structure it this way", explore an alternative, get an explanation — without polluting the main context and without abandoning the surface they are in. The harness has every primitive this needs and no product face for it: [the session-store fork API](../../implemented/feature/2026-06-30-session-store-fork-api.md) produces a `Session` with no attached agent and no way for a client to reach it, and [the fork subagent](../../implemented/feature/2026-06-21-subagent-capability-seam.md) seeds a child with the parent's prefix but runs it as a model-driven task whose whole transcript collapses into one tool result — neither yields a forked conversation the USER can talk to.

The return path is missing entirely: nothing carries a conclusion from one branch back into another. Whatever the user learns in an exploration branch is copy-pasted by hand or lost, with no provenance and no replayable record.

Terminal-first competitors ship half of each: single-shot side questions with inherited context, and user-switched branch copies that force a client restart. None ship the return verb. A harness that owns its session store and context assembly can do both cheaply — and can do so without breaking the provider prefix cache, which third-party wrappers structurally cannot.

## Proposal

A **side session** is an ordinary live session forked from a source session at its last completed turn, attached to its own agent, framed as a read-only advisor, with one new verb — **merge-back** — that hands a condensed note to the parent.

- **Fork + attach composes existing primitives.** The child is created via `ctx.agents.create({ seed, meta })` with the parent's balanced completed-turn prefix (the same slice the fork subagent takes) and `parentSession`/`seedLength` lineage stamped in `meta`. No new core service and no session-store change, for the same reasons [the fork API RFC](../../implemented/feature/2026-06-30-session-store-fork-api.md) rejected a standalone fork service.
- **Advisor framing rides the log, not the system prompt.** The rules ("you are a read-only side advisor; explain, do not mutate; refuse task continuation") are `inject()`ed as a `context/message` with source `{ kind: 'plugin', plugin: 'sidechat' }` immediately after creation. The child's system prompt stays byte-identical to the parent's, so the provider's prefix cache covers the inherited history.
- **Merge-back is one condense turn plus one injection.** `/merge` prompts the child for a bounded handback note (a hard length cap), then `inject()`s the note into the PARENT as a `context/message` with the same plugin source. The parent's next request sees it at its chronological position; replay and [reconstructability](../../implemented/architecture/2026-07-05-reconstructable-requests.md) hold by construction; no new event type enters [the session vocabulary](../../../core-data-structures/session.md).
- **The v1 surface is the ACP bridge, with no new protocol capability.** The bridge intercepts `/side [question]` on a prompt: it stages the fork (bridge-local state, nothing appended to the source log) and the next `session/new` in the same workspace claims it, so the child appears to the editor as an ordinary second session under [multi-session](./2026-06-14-acp-multi-session.md). Because `context/message` produces no client update, the bridge mirrors the handback as an `agent_message_chunk` in the parent session so the merge is visible.

v1 scope excludes: the stdio-agent surface (single-session readline today), rewind productization (mechanically the same fork-to-an-earlier-boundary, an entirely different product question), session tree views, a model-facing side-session tool, `forkName`/`mergedInto` metadata, and cross-connection persistence of a staged fork.

## Prototype

A bridge-level spike (branch `spike/side-sessions-b`) runs the full loop against the live adapter: `/side` staging with zero source-log writes, a claim that seeds the child with the full inherited prefix, a multi-turn advisor exchange that demonstrably uses parent history, and a merge-back the parent's next turn quotes correctly.

## Alternatives considered

- **Carry side conversations through the subagent seam.** Rejected: a subagent child is a model-driven run — the parent's model spawns it, drives it, and consumes its result as a tool result. A side session is user-driven, needs its own client-visible session and lifecycle, and must outlive any single parent turn.
- **Persona via `system-prompt/assemble` section filtering.** Rejected as the default path: any system-prompt byte change invalidates the provider prefix cache from token 0, forfeiting the cheap fork that makes side sessions attractive on long histories. The filter seam remains available for deployments that prefer hard prompt separation over cache reuse.
- **A dedicated `sidechat/*` event family for the handback.** Deferred: `context/message` with a mandatory plugin source already satisfies durability, provenance, and replay. A first-class event earns its catalog, persistence, and snapshot costs only if a UI needs to render handbacks as dedicated cards.
- **An ACP `session/fork` method now.** Deferred: the fork API RFC gates any ACP surface on transcript/snapshot coverage before the capability is advertised, and today's clients offer no fork affordance to call it from. Stage-and-claim ships the experience with zero protocol additions and can be replaced by the method transparently later.

## Acceptance criteria

- `/side` on a live ACP session appends nothing to that session's log; staging is bridge-local and consumed by exactly one claim.
- The claiming `session/new` yields a child seeded with the source's completed-turn prefix, with `parentSession` and `seedLength` in its header and a system prompt byte-identical to the parent's.
- `/merge` appends exactly one length-capped `context/message` to the parent with source `plugin: sidechat`; the parent's next request sees it, and `session/load` replays both sessions faithfully.
- Parent and child stream concurrently without interleaving their `session/update` feeds (existing multi-session isolation).
- Coverage: bridge unit tests for the stage/claim/merge state machine over the in-memory transport, plus a keyless snapshot scenario exercising fork-claim and merge-back end to end.

## Risks

- **Read-only is advisory in v1.** The rules are injected context, not enforcement; a determined prompt can still drive mutating tools. The hard gate is a `tools/pre-execute` deny via [the interception seams](../../implemented/feature/2026-06-30-interception-seams.md), and the RFC's advisor framing is written so that gate can be added without changing the product surface.
- **The staged fork has one slot.** The next same-workspace `session/new` claims it even if the user meant an unrelated thread; the claim banner names the source session and the slot dies with the connection, but a mis-claim costs the user a discarded thread.
- **A compacted source forks its compacted view.** The child inherits the summary, not the original turns; the claim banner should disclose this once [compaction](../../implemented/feature/2026-06-18-compaction-capability-seam.md) ships in this path.
- **Handback notes spend parent tokens.** The length cap and one-note-per-`/merge` bound the cost, but a user who merges repeatedly accumulates notes; a future consolidation pass belongs to the compaction work, not this surface.
