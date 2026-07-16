# RFC: Stop mirroring durable boundaries as agent events

Status: implemented

## Problem

The loop exposed durable turn and step boundaries through both the replayable `SessionEvent` log and live `agent/*` mirrors. Consumers had to choose between two sources for the same fact and reconcile their timing. ACP and persistence already used the log; the stdio UI was the only remaining mirror consumer and already rendered tool calls and results from `session/event`.

This duplication is not free. Every lifecycle change had to update the session event, the mirror event, docs, invariants, tests, and snapshot expectations. The duplicate boundary events also made failure ordering subtle: a turn can be durably closed before a live `agent/turn-end` listener runs, so a post-boundary listener failure has no valid in-log position left and must be reported out of band.

## Decision

Make `session/event` the single live boundary/transcript stream. Consumers that render turns, tool calls, tool results, assistant messages, and durable boundaries subscribe to `session/event` and derive their UI from the same event vocabulary persistence uses.

Remove `agent/turn-start`, `agent/turn-end`, `agent/step-start`, and `agent/step-end`. Boundary consumers subscribe to `session/event`. A UI that needs an agent label maintains a session-to-agent map from `agent/created` and `agent/disposed`, because the durable `turn/start` carries the turn number but not the agent id.

The step mirrors had no consumers and were removed first by the [event-domain-semantics RFC](../architecture/2026-06-30-event-domain-semantics.md). That decision retained the turn mirrors for the stdio UI; this RFC removes them after migrating that test REPL to `session/event` and the id map.

## Scope: what is and isn't removed

This decision covers only durable turn and step boundaries. `agent/steering` mirrored a control record and `agent/stream-chunk` mirrored the token stream, so each was handled separately: [steering](2026-07-04-remove-agent-steering-mirror.md) and [stream chunks](2026-07-02-remove-stream-chunk-mirror.md). `agent/created`, `agent/disposed`, `agent/status`, `agent/error`, and `agent/queued` remain live lifecycle or control events rather than transcript mirrors; queued input may be cancelled before any durable event exists.

## Alternatives considered

- **Remove `agent/steering` in the same change** — rejected because it was a control-record mirror rather than a boundary mirror.
- **Keep turn mirrors for the stdio UI** — rejected because the UI can render `session/event` and recover the agent label from its id map.

## Consequences

A plugin can no longer observe turn/step boundaries from a convenient `Agent`-first event. It must either subscribe to `session/event` or maintain a session-to-agent association. That is an acceptable trade: boundary consumers should not depend on a second event feed that can drift from the durable log.
