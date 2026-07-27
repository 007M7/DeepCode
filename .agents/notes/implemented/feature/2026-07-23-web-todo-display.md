# Agent Note: Web todo display — snapshot side-effect channel + two render surfaces

Status: implemented

English | [中文](2026-07-23-web-todo-display.zh.md)

## Problem

`todo_write` appends `todo/write` whole-list snapshots to the session log; the TUI renders a persistent plan panel (the automation-only ACP bridge deliberately omits todo presentation). The web client dropped the event entirely: the host mux stream already forwards every session event, but `todo/write` is not a surface type (it never folds into `ConversationSnapshot.nodes`), and no side-effect branch accumulated it — the browser had no consumption point and no display surface.

## Decision

Consume `todo/write` as a Session side effect, not a surface node, and render it on two surfaces matching the split the TUI already draws.

### Side-effect channel, converging with window replay

`applyEventSideEffects` gains a `todo/write` case (whole list, last write wins). Unlike partial/openCalls, `rebuildDerivedFromWindow` deliberately does NOT reset it: the value is session-level — taken from the tail history page's full-log projection — and an arbitrary window may not contain the latest write, so an older-page prepend keeps it and only an in-window or live write overwrites it. Every `installWindow` caller is a tail request (`doOpen`, its gap re-pull, `repairGap`; `loadOlder` prepends without it), which the host answers with the projection or omits it only when the full log holds no `todo/write` — so an absent field is the authoritative empty list and is assigned as such. That distinction matters on rollback: a live write whose host crashed before persisting leaves the log empty, and preserving the prior value instead would strand the rolled-back plan on screen indefinitely. `ConversationSnapshot.todos` is the read surface. This follows the event's own contract ("log-only UI state; never derived history"): surfacing each write as a conversation node would render superseded lists as if they were still standing.

### TodoPanel: the durable list as a persistent strip

The panel mounts through the `conversation.input.dock` slot (a plain registrant plugin, `todoDockEntry`, the QueueDock posture: `inject: ['slots', 'conversation']` as the load-order seam, `order: -1` above the queue rows), hidden while empty, collapsible with the in-progress item as the collapsed one-line hint; ✓/●/○ glyphs mirror the TUI plan panel. It reads `snapshot.todos` via the standard-kit `useSession` hook the dock entry receives — no store, no service, no ctx. The inner component stays props-complete and framework-free; the dock adapter is a one-line wrapper.

### TodoRow: the per-call row through the keyed toolview slot

The dedicated `todo_write` chat row is a plain registrant plugin (`todoToolview`, mounted from `apply`) that registers into the keyed `conversation.chat.toolview` slot via `ctx.slots.register` — the same seam and load-order posture as the bash sample (`inject: ['slots', 'conversation']`), but a product registration. The summary derives from call args (`N/M done · active item`); unparseable args fall back to the generic row summary; clicking opens the details column with the raw args. No `ToolEventView` is added for todo — presentation is client-owned, and the durable list renders from the session event, not the tool card.

## Alternatives considered

- **Fold todo writes into `nodes` as surface entries** — replayed windows would render every superseded list; the event is deliberately not a surface type.
- **Hardcoding the panel inside `ConversationRoot`** — the original landing spot before the input-dock slot existed; the dock is the architecture's home for always-on strips above the composer, and a hardcode bypasses the slot registry's disposal and ordering.
- **Details column for the panel** — the details slot is single-occupant and selection-driven, a different lifetime than an always-on strip.
- **Host-computed view (a todo `ToolEventView`)** — presentation belongs to the client; the wire already carries the whole snapshot in the event payload.

## Consequences

Replay correctness is owned by one code path: any future change to window rebuild keeps todos consistent for free, and the fixture (fx-alpha turn 65) plus the assembled keyless snapshot (`apps/web/tests/todo-display.snapshot.ts`) pin the full chain (row summary and state, dock panel content, collapse round-trip) over the built client graph. `todos` is a required `ConversationSnapshot` field, so scripted fakes in specs must carry it. The TUI panel is untouched (the automation-only ACP bridge deliberately omits todo presentation); the web surfaces render the same event, adding one wire field and no new event type. That field is how cold-load reconstruction stays host-backed: the tail history page carries `todos` — the full-log latest `todo/write`, computed independently of the page window (the same backscan posture the view pairing uses) — so a reopened session restores the plan even when the last write precedes the window; that value survives an older-page prepend, is overwritten by any later write, and resets to empty when a tail response carries no projection.
