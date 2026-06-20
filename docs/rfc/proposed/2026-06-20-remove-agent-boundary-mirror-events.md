# RFC: Stop mirroring durable boundaries as agent events

Status: proposed

## Problem

The loop records the canonical transcript in `SessionEvent` and also emits a parallel set of live `agent/*` mirror events: `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`, `agent/stream-chunk`, and `agent/steering`. The mirrors make consumers choose between two sources of truth. ACP already chose the session log for the editor-facing transcript because a throwing peer listener can prevent later `agent/*` listeners from observing a boundary, while the session event was already appended. The stdio UI is the only production consumer that still renders turn boundaries and the token stream from the mirror events; it already renders tool calls and results from `session/event`.

This duplication is not free. Every lifecycle change has to update the session event, the mirror event, docs, invariants, tests, and snapshot expectations. The duplicate boundary events also make failure ordering subtle: a turn can be durably closed before a live `agent/turn-end` listener runs, so a post-boundary listener failure has no valid in-log position left and must be reported out of band.

## Proposal

Make `session/event` the live transcript stream. Consumers that render turns, tool calls, tool results, assistant messages, and durable boundaries subscribe to `session/event` and derive their UI from the same event vocabulary persistence uses. Keep agent lifecycle/control events that are not transcript data: `agent/created`, `agent/disposed`, `agent/status`, `agent/error`, and `agent/queued`. `agent/queued` is an inbox acknowledgement rather than a transcript mirror: it fires before any durable event exists, and cancelled queued work may never enter the log.

Remove the duplicate durable-boundary mirrors from the agent event taxonomy. If a UI wants an agent handle from a session event, it can keep a small map from session id to agent built from `agent/created`/`agent/disposed`, or the registry can offer an explicit lookup. The canonical record remains the event-sourced session log.

## Acceptance criteria

- ACP and stdio render transcript content from `session/event`.
- `agent/turn-start`, `agent/turn-end`, `agent/step-start`, `agent/step-end`, and `agent/steering` are removed or reduced to private implementation details.
- `agent/queued` is either retained and documented as live-only inbox/control state, or deleted in a separate proposal that names the queue-acknowledgement capability loss.
- Tests assert the persisted event stream, not a second mirror stream, for turn and step ordering.
- Documentation presents `SessionEvent` as both the durable source and the live transcript feed.

## What we give up

A plugin can no longer observe turn/step boundaries from a convenient `Agent`-first event. It must either subscribe to `session/event` or maintain a session-to-agent association. That is an acceptable trade: transcript consumers should not depend on a second event feed that can drift from the durable log.

## Related

Because high-fidelity `assistant/chunk` persistence remains load-bearing, `agent/stream-chunk` can be evaluated as another mirror of durable session data rather than as the only token stream. If a future proposal moves chunks out of the canonical log, `agent/stream-chunk` would need a fresh decision as a deliberately live-only UI signal.
