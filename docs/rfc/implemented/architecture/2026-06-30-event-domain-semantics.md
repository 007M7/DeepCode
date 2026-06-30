# RFC: Event-domain semantics — session is the fact log, agent is the live surface

Status: implemented (accepted 2026-06-30)

## Context

The harness extends the agent loop through a Cordis event taxonomy (see [the microkernel event-taxonomy RFC](2026-06-11-microkernel-event-taxonomy.md)). As that taxonomy grew, the line between the three event domains blurred:

- `session/*` carries the durable, event-sourced log (`SessionEventMap`).
- `agent/*` carries live runtime signals that hand a plugin the `Agent` handle.
- `tools/*` carries the tool registry + execution seam.

Two problems motivated pinning the semantics down. First, several turn/step boundaries existed BOTH as a durable `SessionEvent` (`turn/start`, `turn/end`, `step/start`, `step/end`) AND as a mirrored `agent/*` emit (`agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`). A consumer had two sources of truth for the same fact, and every lifecycle change had to update both. Second, the upcoming Hooks subsystem needs ONE coherent, documented surface to subscribe to — a plugin author (and the Claude Code / Codex hook bridges built on top) must know, without reading the loop, whether to listen on a session event or an agent event, and why.

This is the foundational change in a stack that adds a Hooks subsystem; it establishes the vocabulary the later PRs (interception-Decision reshape, the `hook/*` durable log, the bridges) build on.

## Decision

**Three domains, one job each, with a single boundary rule.**

- **`session/*` — the durable, replayable FACT log.** Owns `SessionEventMap`; every entry is JSON-only (no live objects). One `session/event` emit per append, plus the `session/flush` parallel durability checkpoint. It is also the live transcript feed: a consumer that wants to render or react to what happened subscribes here, so live rendering and `session/load` replay share one path.
- **`agent/*` — the LIVE runtime surface.** Always carries the live `Agent`. Two shapes: INTERCEPTION waterfalls (`agent/request`, `agent/step-result`, `agent/turn-continuation`) that mutate or veto, and TRANSIENT emits (`agent/status`, `agent/stream-chunk`, `agent/error`, `agent/created`/`agent/disposed`, `agent/queued`, `agent/steering`, and the turn boundaries) that notify with the `Agent` in hand.
- **`tools/*` — the tool registry + execution seam.**

**The boundary rule:** a durable, replayable fact is a `SessionEvent`; a live interception or a transient/live-object signal is an `agent`/`tools` Cordis event. A datum that is BOTH — a turn or step boundary — lives in the session log, and is mirrored as an `agent/*` emit ONLY where a live consumer provably needs the `Agent` handle at that instant.

**Applying the rule to the boundary twins (prune case-by-case):**

- `agent/turn-start` — **KEPT.** The stdio UI (`dsh-ui-stdio`) labels turn output by `agent.id`, which the `turn/start` session event does not carry. A genuine live-object need.
- `agent/turn-end` — **KEPT.** The stdio UI listens to print the next-prompt glyph. (Note: the ACP bridge does NOT settle on this event — it settles from `session/event` `turn/end` plus `agent/status`; the surviving justification is the stdio UI alone.)
- `agent/step-start`, `agent/step-end` — **REMOVED.** No production consumer needs the live `Agent` at a step boundary; a consumer that wants per-step boundaries reads the durable `step/start`/`step/end` session events. Removing the two emits also simplifies the loop's `closeStep` (one append, no paired emit).

## Consequences

- The loop no longer emits `agent/step-start`/`agent/step-end`; `closeStep` appends `step/end` only, and a throwing `step/end` session-event listener is the surviving step-boundary-listener failure path (contained by `closeStep` → `failTurn`, the turn closes balanced).
- Tests that observed step boundaries via the removed emits now observe the durable `step/start`/`step/end` session events — the behavior they pin (boundary ordering, step counting, a throwing boundary listener failing the turn balanced) is unchanged; only the feed they read moved to the canonical one. Per [AGENTS.md "tests document behavior, not golden truth"](../../../../AGENTS.md), the behavior and its test moved together.
- One behavior genuinely shifts and is documented in its test: a throwing `step/start` session-event listener throws INSIDE `session.append('step/start')`, before the loop marks the step open, so no `step/end` is owed (the old `agent/step-start` emit fired after the step was open). The turn still closes balanced with an error.
- This is a partial, conservative realization of the broader [proposed simplification "Stop mirroring durable boundaries as agent events"](../../proposed/simplification/2026-06-20-remove-agent-boundary-mirror-events.md): that RFC proposes removing ALL boundary mirrors (including the turn boundaries and `agent/steering`) and migrating the stdio UI's turn rendering onto `session/event`. This RFC removes only the two step mirrors that have no live consumer; the turn mirrors stay until the stdio UI is migrated. The proposed RFC remains the home for finishing that migration.
- The cordis catalog (`docs/cordis-catalog/events-and-services.md`) is regenerated to drop the two events.
