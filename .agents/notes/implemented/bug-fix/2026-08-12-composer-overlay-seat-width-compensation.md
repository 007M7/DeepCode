# Agent Note: The overlay composer seat compensates for the bar instead of reserving a gutter

Status: implemented

English | [中文](2026-08-12-composer-overlay-seat-width-compensation.zh.md)

## Problem

The [composer-tab gutter reservation](2026-08-04-composer-tab-gutter-reservation.md) made the column's scroller reserve a scrollbar gutter unconditionally, so the composer seat measured the same width in Chat and in a view with a composer overlay. The cost was paid by every overlay view: the view's content column ended 8px short of the column's right edge, because the scroller reserved a gutter for a bar it never draws — the trajectory ledger owns its own scrollers and the outer box never scrolls.

The trajectory table made that cost visible: its full-width row divider lines stopped 8px short of the pane edge, leaving a strip of whitespace at the right of every line and of the whole content column.

## Decision

The reservation now belongs to Chat alone. The overlay branch declares `scrollbar-gutter: auto`, so the view's content spans the full column; the overlay composer seat (absolutely positioned against the padding box) gives back the bar's width with `right: var(--dsh-scrollbar-width)`, so the input card still measures the same width as Chat's seat and does not move between tabs.

The compensation value is not a literal: ui-theme's scrollbar.css defines `--dsh-scrollbar-width` (8px on the WebKit path) beside the `::-webkit-scrollbar` rule it mirrors, and the seat reads that variable. A change to the sheet's bar width reaches the compensation in the same reviewable diff as the bar itself.

## Alternatives considered

**Keep the unconditional reservation and shrink every overlay view.** The pre-fix behavior. It keeps one declaration for both tabs but taxes every overlay view with an 8px content column, which the trajectory ledger surfaced as visible whitespace. Rejected because the overlay views own their scrolling; they should not pay for Chat's bar.

**Reserve on the overlay branch too and let the view bleed into the gutter.** More moving parts for the same result: the gutter would still exist on a box that never scrolls, and the view would have to break out of the content box to reclaim its width.

**Accept the 4px card shift.** Dropping the reservation without compensating the seat would move the input card on every tab switch, which is exactly the symptom the earlier note fixed. Rejected: the card position is a deliberate cross-tab invariant.

## Consequences

- Chat keeps its reserved gutter and its stable card position; nothing changes on that tab.
- Overlay views (trajectory) span the full column; the trajectory ledger's divider lines reach the pane edge.
- The input card still holds one horizontal position across the Chat and Trajectory tabs, now by two mechanisms instead of one: Chat reserves, the overlay seat compensates.
- `--dsh-scrollbar-width` becomes a public ui-theme variable read outside ui-theme; the scrollbar-styles spec's indirection checks only scan `--dsh-scrollbar-thumb{,-hover}` rebinds, so the width variable is not covered by the pair gate.

## Testing

`apps/web/tests/composer-tab-geometry.e2e.ts` still asserts the card holds its position across tabs and now also asserts the split: Chat's scroller keeps `scrollbar-gutter: stable` and a nonzero band, while the overlay branch resolves `auto` with a zero band. The control cascade changed with the mechanism: it now drops the seat's `right` compensation (instead of dropping a gutter Chat never had on that branch) and measures the same 4px shift, proving the equal rectangles are not a tab switch that never reached layout. The committed golden records both states.
