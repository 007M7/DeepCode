# Agent Note: Web session fork actions

Status: implemented

English | [中文](2026-07-27-web-session-fork-actions.zh.md)

## Problem

The Session store already provides a fork primitive that creates a child session from a completed-turn prefix, but the Web client has no unified interaction contract. The Session-row menu can express only “branch from the latest completed turn,” while message IconActions need to express “branch from the turn containing this message”; if the two entry points independently interpret the boundary, switching, and failure behavior, the same user action acquires two sets of semantics. Nesting a fork child beneath its source session also makes the newly selected child visible only while its ancestors are expanded and weakens the workspace manual-order model.

## Decision

The Web Session-row menu and message IconActions share the client runtime's `sessions.fork` action. A Session row passes `{ sessionId }`, so it forks at the source session's last completed turn; a user message or settled assistant content message passes `{ sessionId, atSeq: node.seq }`, so it forks at the turn containing that event. On success, the client first adds the child session to its local list and then opens it; on failure, it leaves the source session and current selection unchanged.

`forkAt(seq)` touches the session service only in ui-conversation's apply injection layer; message components report only the event `seq`. Session rows likewise initiate the operation only through ui-workspace's injected callback. Neither presentation package owns session mutation state or duplicates the host's boundary evaluation.

Session lineage is not projected into a list hierarchy. WorkSpace mode displays source sessions and all fork children as peer rows in the manual order from `WorkspaceView.sessionIds`; every row can be opened, searched, and dragged independently. In one list mode continues to sort strictly by `updatedAt`; the Ungrouped group also sorts by recency when no workspace ledger is available. `parentId` remains available for lineage, tool presentation, and later queries, but does not control session-list visibility.

## Alternatives considered

**Wire only the Session-row menu.** Rejected: at a message, the user has already selected more precise context; forcing them back to the list can only degrade the boundary to the latest completed turn, while the visible message branch icon would remain non-responsive.

**Allow branching only from user messages.** Rejected: settled assistant content also has a stable event `seq`, and the host places it in its containing completed turn; making only one of two visually identical branch buttons work would create an invisible behavioral difference.

**Nest fork children beneath their source by `parentId`.** Rejected: lineage is not navigation ownership; nesting requires automatic ancestor expansion to reveal the current item and prevents children from participating in the workspace's peer manual order.

**Call the session service directly from message components.** Rejected: client components must not touch `ctx` or business services; injected callbacks keep mutation in the apply world and leave components driven purely by props.

## Consequences

Users can create forks from Session rows, user messages, or settled assistant content messages; all three entry points ultimately use the same runtime/host operation. Message entry points preserve the exact event boundary, while the list entry point preserves the “latest completed turn” shortcut. Every fork child immediately appears as an ordinary peer row, so the list no longer needs session expansion state, recursive nodes, or twist controls.

Fork failures stay silent and preserve the source selection, preventing a derivation action from disrupting the current reading position; this tradeoff also means the UI does not yet expose a failure reason or retry entry point. Package tests separately pin the two message `seq` paths and the peer-list derivation; `apps/web/tests/message-actions.e2e.ts` exercises assistant-message branching and Session-row menu branching through the assembled application.
