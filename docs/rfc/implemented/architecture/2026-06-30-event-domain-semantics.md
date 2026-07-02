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
- **`agent/*` — the LIVE runtime surface.** Always carries the live `Agent`. Two shapes: INTERCEPTION waterfalls (`agent/request`, `agent/step-result`, `agent/turn-continuation`) that mutate or veto, and TRANSIENT emits (`agent/status`, `agent/error`, `agent/created`/`agent/disposed`, `agent/queued`, `agent/steering`) that notify with the `Agent` in hand. Turn and step BOUNDARIES are NOT here — they are durable session events read off `session/event`, and so is the token stream (`assistant/chunk`).
- **`tools/*` — the tool registry + execution seam.**

**The boundary rule:** a durable, replayable fact is a `SessionEvent`; a live interception or a transient/live-object signal is an `agent`/`tools` Cordis event. A turn or step boundary is a durable fact, so it lives in the session log and is read off the `session/event` feed — it is NOT mirrored as an `agent/*` emit.

**Applying the rule to the boundary twins:** all four boundary mirrors — `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end` — are **REMOVED**. No production consumer needs the live `Agent` at a boundary: the ACP bridge settles from `session/event` `turn/end` plus `agent/status`, and the only turn-mirror consumer (`dsh-ui-stdio`, a disposable test REPL) was migrated to render boundaries from `session/event`, recovering the short agent label from an `agent/created`→id map. The step mirrors were removed first (they had no consumer at all); the turn mirrors followed once ui-stdio was migrated — see [the remove-boundary-mirror-events RFC](../simplification/2026-06-20-remove-agent-boundary-mirror-events.md), which owns that decision. Removing the emits also simplifies the loop's `closeStep`/`closeTurn` (one append each, no paired emit).

## Consequences

- The loop no longer emits any boundary mirror; `closeStep` appends `step/end` only and `closeTurn` appends `turn/end` only. A throwing `step/end`/`turn/end` session-event listener is the surviving boundary-listener failure path (contained inside `closeStep`/`closeTurn` — `Session.append` pushes the event before notifying listeners, so the boundary is durable and the turn closes balanced regardless).
- Tests that observed boundaries via the removed emits now observe the durable `turn/start`/`turn/end`/`step/start`/`step/end` session events — the behavior they pin (boundary ordering, step counting) is unchanged; only the feed they read moved to the canonical one. The tests that exercised a *throwing turn-boundary emit listener* were deleted, because that code path no longer exists (there is no emit to throw from). Per [AGENTS.md "tests document behavior, not golden truth"](../../../../AGENTS.md), the behavior and its test moved (or died) together.
- The loop marks the step open (`stepOpen = true`) BEFORE appending `step/start`, because `Session.append` pushes the event to the log before notifying `session/event` listeners (validation throws happen earlier, before the push — see [the session append contract](../../../core-data-structures/session.md)). So a throwing `step/start` session-event listener runs with the step already open and the event already in the log: the loop's outer catch then calls `closeStep()`, which appends the balancing `step/end`, and the turn closes balanced with an error (`turn/start → step/start → step/end → turn/end` — verified by the invariants oracle in the regression test). Closing the open step is owed precisely because the marker is set first.
- The full realization of this is [the simplification RFC "Stop mirroring durable boundaries as agent events"](../simplification/2026-06-20-remove-agent-boundary-mirror-events.md): all four boundary mirrors are removed and every consumer reads boundaries off `session/event`. `agent/steering` (a live control signal, not a boundary mirror) is retained; see that RFC's scope section.
- The cordis catalog (`docs/cordis-catalog/events-and-services.md`) is regenerated to drop the mirror events.
