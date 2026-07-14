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
- **Merge-back is one condense turn plus one injection.** The child is prompted for a bounded handback note (a hard length cap), which is then `inject()`ed into the PARENT as a `context/message` with the same plugin source. The parent's next request sees it at its chronological position; replay and [reconstructability](../../implemented/architecture/2026-07-05-reconstructable-requests.md) hold by construction; no new event type enters [the session vocabulary](../../../core-data-structures/session.md).
- **The surface binding is deliberately unspecified.** How a user invokes the fork and the merge, and how a handback note is presented, are client concerns; while the harness speaks through protocols whose UI it does not control, this RFC pins only the surface-agnostic mechanics above and leaves presentation to the first surface the project owns.

Scope also excludes: rewind productization (mechanically the same fork-to-an-earlier-boundary, an entirely different product question), session tree views, a model-facing side-session tool, and `forkName`/`mergedInto` metadata.

## Prototype

A spike (branch `spike/side-sessions-b`) validates the mechanics against the live adapter: a fork that leaves the source log untouched, a child seeded with the full inherited prefix, a multi-turn advisor exchange that demonstrably uses parent history, and a merge-back the parent's next turn quotes correctly.

## Alternatives considered

- **Carry side conversations through the subagent seam.** Rejected: a subagent child is a model-driven run — the parent's model spawns it, drives it, and consumes its result as a tool result. A side session is user-driven, needs its own client-visible session and lifecycle, and must outlive any single parent turn.
- **Persona via `system-prompt/assemble` section filtering.** Rejected as the default path: any system-prompt byte change invalidates the provider prefix cache from token 0, forfeiting the cheap fork that makes side sessions attractive on long histories. The filter seam remains available for deployments that prefer hard prompt separation over cache reuse.
- **A dedicated `sidechat/*` event family for the handback.** Deferred: `context/message` with a mandatory plugin source already satisfies durability, provenance, and replay. A first-class event earns its catalog, persistence, and snapshot costs only if a UI needs to render handbacks as dedicated cards.
- **Binding the proposal to a protocol surface now.** Rejected in review: the harness currently speaks through client-owned UIs it does not control, so any presentation contract written today would be speculative. The RFC pins the surface-agnostic mechanics and defers presentation to the first surface the project owns.
- **Surface-level mirroring of the handback.** Rejected in review: a visible record emitted outside the log vanishes on replay while the model still sees it. Whatever surface eventually renders the handback must derive its presentation from the durable `context/message`, so live and replayed views come from the same event.

## Acceptance criteria

- Forking a live session yields a child agent seeded with the source's balanced completed-turn prefix, with `parentSession` and `seedLength` in its header and a system prompt byte-identical to the parent's; the source log is untouched by the fork.
- The advisor framing is exactly one plugin-sourced `context/message` at the head of the child's appended history — never a system-prompt change.
- Merge-back appends exactly one length-capped `context/message` to the parent with source `plugin: sidechat`; the parent's next request sees it, and replay reproduces it at the same position.
- Parent and child run concurrently without cross-talk between their logs or streams.
- Coverage: unit tests for the fork/attach and merge-back mechanics; surface-level snapshot coverage lands with whichever surface first binds the feature.

## Risks

- **Read-only is advisory in v1.** The rules are injected context, not enforcement; a determined prompt can still drive mutating tools. The hard gate is a `tools/pre-execute` deny via [the interception seams](../../implemented/feature/2026-06-30-interception-seams.md), and the RFC's advisor framing is written so that gate can be added without changing the mechanics.
- **A compacted source forks its compacted view.** The child inherits the summary, not the original turns; whichever surface binds the feature should disclose this once [compaction](../../implemented/feature/2026-06-18-compaction-capability-seam.md) ships in this path.
- **Handback notes spend parent tokens.** The length cap and one-note-per-merge bound the cost, but a user who merges repeatedly accumulates notes; a future consolidation pass belongs to the compaction work, not here.
