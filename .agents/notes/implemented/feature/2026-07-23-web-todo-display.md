# Agent Note: Web todo display — snapshot side-effect channel + two render surfaces

Status: implemented

English | [中文](2026-07-23-web-todo-display.zh.md)

## Problem

`todo_write` appends `todo/write` whole-list snapshots to the session log; the TUI renders a persistent plan panel and the ACP bridge maps the event to native `plan` updates. The web client dropped the event entirely: the host mux stream already forwards every session event, but `todo/write` is not a surface type (it never folds into `ConversationSnapshot.nodes`), and no side-effect branch accumulated it — the browser had no consumption point and no display surface.

## Decision

Consume `todo/write` as a Session side effect, not a surface node, and render it on two surfaces matching the split the TUI and ACP already draw.

### Side-effect channel, converging with window replay

`applyEventSideEffects` gains a `todo/write` case (whole list, last write wins). Unlike partial/openCalls, `rebuildDerivedFromWindow` deliberately does NOT reset it: the value is session-level — seeded by the tail history page's full-log projection — and an arbitrary window may not contain the latest write, so rebuilds (paging, reconnect stitch, resync) preserve it and only an in-window or live write overwrites it. `ConversationSnapshot.todos` is the read surface. This follows the event's own contract ("log-only UI state; never derived history"): surfacing each write as a conversation node would render superseded lists as if they were still standing.

### TodoPanel: the durable list as a persistent strip

The skeleton pins the panel between the view area and the composer (the composer-card axis), hidden while empty, collapsible with the in-progress item as the collapsed one-line hint; ✓/●/○ glyphs mirror the TUI plan panel. It reads `snapshot.todos` via the framework `useSession` hook — no store, no service, no ctx. It lives inside `ConversationRoot` rather than the details column or its own slot: the details slot is single-occupant and selection-driven (a different lifetime than an always-on strip), and the slot table reserves no plan seat. The component is props-complete and framework-free, so a later relocation to a dedicated slot touches nothing inside it.

### TodoRow: the per-call row through the keyed toolview slot

The dedicated `todo_write` chat row is a plain registrant plugin (`todoToolview`, mounted from `apply`) that registers into the keyed `conversation.chat.toolview` slot via `ctx.slots.register` — the same seam and load-order posture as the bash sample (`inject: ['slots', 'conversation']`), but a product registration. The summary derives from call args (`N/M done · active item`); unparseable args fall back to the generic row summary; clicking opens the details column with the raw args. No `ToolEventView` is added for todo — presentation is client-owned, and the durable list renders from the session event, not the tool card.

## Alternatives considered

- **Fold todo writes into `nodes` as surface entries** — replayed windows would render every superseded list; the event is deliberately not a surface type.
- **Details column or a dedicated slot for the panel** — the details slot is single-occupant and selection-driven; a new slot key needs a slot-table seat that design has not assigned. The panel is framework-free, so the relocation stays cheap if one lands.
- **Host-computed view (a todo `ToolEventView`)** — presentation belongs to the client; the wire already carries the whole snapshot in the event payload.

## Consequences

Replay correctness is owned by one code path: any future change to window rebuild keeps todos consistent for free, and the fixture (fx-alpha turn 63) plus `scripts/verify-todo-display.mjs` pin the full chain (panel visibility, row summary, details linkage, collapse, dark theme) in a real chromium. `todos` is a required `ConversationSnapshot` field, so scripted fakes in specs must carry it. The ACP bridge's todo → `plan` mapping and the TUI panel are untouched; the web surfaces render the same event with no new wire vocabulary. Cold-load reconstruction is host-backed: the tail history page carries `todos` — the full-log latest `todo/write`, computed independently of the page window (the same backscan posture the view pairing uses) — so a reopened session restores the plan even when the last write precedes the window; the seeded value is preserved across window rebuilds and overwritten by any later write.
