# Agent Note: Recursive Python SDK session notifications

Status: implemented

English | [中文](2026-07-24-recursive-python-sdk-session-notifications.zh.md)

## Problem

The Python SDK filtered turn notifications by comparing each payload directly with the root session id. This admitted a direct child's lifecycle because its parent id named the root, but rejected a grandchild's lifecycle and every descendant `session.event`. The JSON-RPC server still emitted those notifications, so they accumulated on the low-level global queue while high-level consumers lost nested trajectory relationships and completion states.

## Decision

`HarnessClient` records every valid `subagent.started` and `subagent.finished` child-to-parent edge before dispatching the notification. Session subscriptions classify each payload session id, parent id, and child id by walking that client-lifetime ancestry graph to their requested root. The graph survives successive subscriptions so a descendant that outlives one `Session.run()` remains attributable when it emits during a later turn, and it resets when the client starts a new runtime process.

`Session.run()` delivers the complete discovered session-tree notification stream through `TurnResult.notifications` and `on_notification`. Only `session.event` notifications whose `sessionId` equals the requested root enter `TurnResult.events` or final-response reconstruction. Descendant events are therefore observable without allowing a child response to replace the root response.

## Alternatives considered

**Add a root session id to every JSON-RPC notification.** The server already provides exact immediate-parent edges, and duplicating transitive ancestry on the wire would make every producer responsible for client subscription state.

**Limit subagents to one level.** A deployment can set `maxDepth: 1`, but changing the SDK to depend on that policy would silently misreport valid recursive compositions.

**Subscribe only to descendant lifecycle notifications.** This would repair relation and completion reporting, but descendant session events would continue accumulating on the global queue and callbacks would expose an incomplete tree.

## Consequences

High-level consumers receive nested lifecycle and session notifications in wire order while root turn results preserve their prior response semantics. The client retains one parent entry per observed child until the runtime restarts; ancestry lookup is cycle-safe, and unrelated session notifications remain available through the global queue. Keyless Python tests cover two-level delegation, root-response isolation, absence of tree-notification queue buildup, and ancestry reuse across subscriptions.
