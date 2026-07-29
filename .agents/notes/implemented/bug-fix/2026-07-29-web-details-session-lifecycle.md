# Agent Note: Web details follow the current Session lifecycle

Status: implemented

English | [中文](2026-07-29-web-details-session-lifecycle.zh.md)

## Problem

The details entry is Session-scoped, but its grid width is root-scoped and persisted. Changing the current Session replaced or removed the details content without closing that root column, so New Session could show its composer beside an empty details panel that still consumed 360 pixels. The same ownership gap applied to ordinary Session switches and to selection invalidation after a Session disappeared.

## Decision

`AppFrame` derives one details owner from the authoritative Session projection after the Session baseline is ready: the current Session must still exist and must not be blank. The first ready active Session is baseline restoration, so an open details width may survive a browser refresh. A first ready New Session state has no details owner and closes stale persisted state.

After baseline restoration, every details-owner change closes the panel through the layout store before paint. This covers active-to-active navigation, active-to-blank New Session, clearing the current selection, and invalidation after deletion. Returning to the earlier Session keeps details closed because the root store records the close; the per-Session chat selection remains owned by the session-scoped store described by the [slot system standard](../architecture/2026-07-22-slot-type-chain-implementation.md).

Manual close and reopen inside one unchanged active Session retain their existing behavior. The lifecycle effect changes neither sidebar actions nor the [Workspace-owned New Session flow](../feature/2026-07-25-workspace-ui-product-flow.md), composer drafts, Session navigation, or concession-chain resizing.

## Alternatives considered

**Close details in the New Session click handler.** Rejected because top-level New Session, Workspace row actions, the Workspace picker, ordinary Session rows, and removal can all change the owner. An entry-point patch would leave the shared lifecycle inconsistent.

**Persist panel geometry per Session.** Rejected because the product contract needs stale context removed, not a new map of remembered widths. Per-Session geometry would also reopen details when users return, contrary to the chosen close-on-leave behavior.

**Only hide the details component when no Session is current.** Rejected because a blank Session is still current, and removing content without zeroing the grid track is the reported defect.

## Consequences

Leaving an active Session forgets any dragged details width, since the existing close action writes zero and reopening uses the contract default. Refreshing an active Session preserves its open panel, while refreshing New Session clears stale persisted geometry. The layout behavior test covers active, blank, missing, switch-back, and baseline-restore states; the keyless browser e2e drives the shipped composition from an active Session through New Session and back while checking the full grid track and browser errors.
