# Agent Note: Todo plan strip clears on the next turn

Status: implemented

English | [中文](2026-07-28-todo-plan-clears-on-next-turn.zh.md)

## Problem

`todo_write` stores whole-list snapshots on the session log, and interactive hosts render the latest list as a plan strip (web TodoPanel, TUI Plan panel). After a turn finished, that strip stayed on screen into the next user turn — a completed or abandoned checklist from the previous task. Readers treat the strip as "what this turn is doing," so a stale list across the turn boundary is the wrong product lifetime. The [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md) notes still own event-sourcing and the two render surfaces; they described the standing plan as lasting for the whole session until the next write.

## Decision

The standing plan is the latest `todo/write` that is not followed by a later `turn/start`. `turn/end` keeps the list visible so the finished checklist remains while the user reads the answer; the next `turn/start` clears it until the model writes again.

### Live path

Web `Session.applyEventSideEffects` and the TUI `renderEvent` switch clear the strip on `turn/start` and replace it on `todo/write`. The TUI rebuild path resets the panel before replaying the log so cold resume converges on the same rule.

### Cold-load / history projection

Host `backscanTodos` (and the fixture parallel) walks the full log from the tail: the first `turn/start` means no standing plan; the first `todo/write` is the standing list. Tail `session.history` still carries that projection (or omits it for empty). Client rebuild sweeps the window from an empty plan and restores the tail-page seed only when the window itself never determined the plan (no `todo/write` and no `turn/start`); a contiguous tail window that contains a post-write `turn/start` determines empty and matches the host.

## Alternatives considered

- **Clear on `turn/end`** — hides the checklist while the user is still reading the just-finished answer; the strip's job at that moment is the completed plan, not an empty dock.
- **Clear only when every item is `completed`** — leaves abandoned or partial plans across turns; the strip would still show another task's work.
- **Append an empty `todo/write` on turn start** — mutates the log for a UI lifetime rule and invents a write the model never authored.

## Consequences

Interactive hosts and the history projection share one lifetime rule; reopening a session restores a plan only when no later turn has started. Partial supersession of the session-long standing-plan wording in [web todo display](2026-07-23-web-todo-display.md) and [`todo_write` tool](2026-06-29-todo-write-tool.md): event-sourcing, last-write-wins replacement, and the two render surfaces stay there; this note owns turn-boundary clearance. Coverage: client session specs for live clear + replay empty, host history projection after a post-write `turn/start`, the standing-plan web todo-display snapshot (fixture turn 65 remains the log tip), plus assembled web/TUI snapshots that start the next turn and pin the strip gone.
