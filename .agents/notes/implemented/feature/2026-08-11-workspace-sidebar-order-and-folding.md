# Agent Note: Workspace Sidebar Order and Folding

Status: implemented

English | [中文](2026-08-11-workspace-sidebar-order-and-folding.zh.md)

## Problem

A Workspace with many Sessions can consume the entire sidebar and push other Workspaces out of reach. A compact list needs a bounded default while preserving an explicit route to every Session. The sidebar also needs an activity-oriented order, but `WorkspaceView.sessionIds` is the durable manual account and must not be rewritten by Session activity.

Workspace groups themselves had no user-controlled durable order. Browser-native drag additionally rejects a drop released outside the list and animates the row back even when the application still has a valid insertion marker. Expanded Workspace sections make header-only hit testing ambiguous because the visual boundary between two groups does not match either header's midpoint.

## Decision

### Workspace order

The Workspace registry owns a durable `workspaceIds` order and exposes `insertBefore(id, beforeId?)` with DOM `insertBefore` semantics. The Host RPC `workspace.insertBefore` returns the complete committed order, and a pure order mutation emits `host/workspace-order-changed` with the same complete order. Unknown source or anchor ids reject as `workspace-not-found`; self-anchored and already-positioned moves do not write.

The client installs a Workspace drag optimistically. Request and frame generations ensure that only the latest unary echo can replace local order and that a newer Host frame outranks an older response; a latest rejected request restores the preceding order. Every successful list baseline restores Host order so reconnects adopt durable changes made elsewhere.

### Session folding and view order

Each Workspace persists one browser-local open state: closed means zero Session rows and open means up to five. When more Sessions exist, **Show more** reveals the remainder only for the current mount; closing the whole Workspace clears this transient expansion, so reopening returns to five. The current Session's group opens automatically only when the user has not already stored an explicit state for that Workspace.

The combined view menu offers **Manual** and **Last updated**. Manual follows the Host account in `WorkspaceView.sessionIds`. Last updated maintains a browser-local per-Workspace order that users may still edit by dragging; whenever a Session summary's `updatedAt` advances, that Session is promoted to the front. This view order never writes the Host Session account. The flat list uses recent-update order because it has no single Workspace account for durable Session drag.

### Drag and compact chrome

Workspace hit testing uses the complete rendered group section, including visible Session rows. One insertion boundary is shared by the preceding group's lower half and the following group's upper half, and the indicator is an absolutely positioned line that does not affect layout. During a Session drag, document-level `dragover` and `drop` handlers accept the native operation; if release occurs outside the Workspace list, `dragend` commits the last valid marker.

Search is a header action while collapsed and expands across the title and trailing actions. An outside click collapses an empty search but retains a non-empty query. Compact Workspace and Session rows, a 24px bottom fade, and the absence of per-Workspace Session counts preserve vertical space without removing navigation affordances.

## Alternatives considered

**Persist the recent-update view into `Workspace.sessionIds`.** Activity would overwrite a deliberate manual order and recreate two competing meanings for the same Host field.

**Always show every Session in an open Workspace.** One large Workspace would continue to crowd out the rest, and remembering only the whole-group open state would not bound its height.

**Persist the expanded-remainder state.** A Workspace reopened much later could unexpectedly occupy the full sidebar. Only the zero-or-five state represents a stable navigation preference; revealing the remainder is a local inspection.

**Use numeric drop indices or header-only hit testing.** Indices drift when rows change during a drag, while header midpoints disagree with the visible boundary when a Workspace is expanded. Anchor ids and full-section geometry remain stable under both conditions.

**Let the browser reject an outside release.** The application would commit the last valid marker while the browser displays a rejected-drop animation, presenting contradictory feedback.

## Consequences

- Workspace order is durable and shared through the Host, while grouping, open state, recent-update Session order, and query state remain browser-local presentation preferences.
- Recent-update mode preserves manual edits until a Session becomes active again; a newer `updatedAt` intentionally promotes that Session to the front.
- Opening a Workspace never shows more than five Sessions without an explicit **Show more** gesture, and closing it resets only that transient gesture.
- The Host Session account retains the manual-order meaning established by [Session List Browsing and Manual Workspace Order](2026-07-25-session-list-browsing-and-manual-order.md).

## Testing

Domain and Host tests cover durable Workspace moves, no-op and invalid anchors, restart recovery, full-order RPC responses, and order frames. Runtime tests cover optimistic order, frame/response precedence, rejection rollback, reconnect baselines, and New Session target priority. UI tests cover five-row folding, transient expansion reset, recent-update promotion with manual drag, selected view indicators, expanded-section Workspace hit testing, outside-list Session drops, search collapse rules, and compact CSS dimensions.
